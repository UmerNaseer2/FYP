// push-db: phone alert devices and the server's push key, in a real metadata
// database.
//
// tests/phone-push-routes.test.ts checks what the routes do with each answer.
// Only Postgres can say whether "ON CONFLICT (endpoint)" has a constraint to
// lean on, whether a device goes with its person, and whether someone who left
// an organization really stops getting its alerts.
//
// It needs a Postgres it may create and drop databases in, so it runs only when
// TEST_DATABASE_URL is set (CI sets it, and fails rather than skip without it:
// see tests/helpers/test-database.ts), and only against a database whose name
// contains "test". tests/invites-db.test.ts shows how to start one locally.
import { Client } from "pg";
import { readPushKey } from "@/lib/web-push";
import { newPhone, subscriptionOf } from "./helpers/push-phone";
import { testDatabaseUrl } from "./helpers/test-database";

type Org = { id: number };
type Person = { id: number; email: string };

const testUrl = testDatabaseUrl();
const describeWithDatabase = testUrl ? describe : describe.skip;

const SLOW = 60_000;
const SETUP = 120_000;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function urlFor(name: string): string {
  const url = new URL(testUrl);
  url.pathname = "/" + encodeURIComponent(name);
  return url.toString();
}

async function connectTo(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

describeWithDatabase("phone alert devices in a real metadata database", () => {
  const savedUrl = process.env.DATABASE_URL_A;
  const savedDesktop = process.env.SCHEMA_STUDIO_DESKTOP;
  const savedKey = process.env.APP_ENCRYPTION_KEY;
  let server: Client;
  let db: Client;
  let databaseName = "";

  // The code under test. Imported after DATABASE_URL_A points at the fresh
  // database, so it uses the one Sequelize pool made for it.
  let sequelize: typeof import("@/lib/db/sequelize").sequelize;
  let push: typeof import("@/lib/push-db");
  let encryption: typeof import("@/lib/secret-store");

  let orgA: Org;
  let orgB: Org;
  let ada: Person;
  let bea: Person;

  async function rows<T>(text: string, values: unknown[] = []): Promise<T[]> {
    return (await db.query(text, values)).rows as T[];
  }

  let addresses = 0;
  async function person(name: string, memberOf: { org: Org; role: string }[]): Promise<Person> {
    addresses += 1;
    const email = `${name}.${addresses}@example.test`;
    const [profile] = await rows<{ id: number }>(
      `INSERT INTO profiles (email) VALUES ($1) RETURNING id`,
      [email]
    );
    for (const { org, role } of memberOf) {
      await db.query(`INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, $3)`, [
        org.id,
        profile.id,
        role,
      ]);
    }
    return { id: profile.id, email };
  }

  let devices = 0;
  function device() {
    devices += 1;
    return subscriptionOf(newPhone(), `https://fcm.googleapis.com/fcm/send/${devices}`);
  }

  async function settle(): Promise<void> {
    const pool = (sequelize.connectionManager as unknown as {
      pool: { using: number; waiting: number };
    }).pool;
    let idle = 0;
    for (let attempt = 0; attempt < 250 && idle < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      idle = pool.using === 0 && pool.waiting === 0 ? idle + 1 : 0;
    }
    if (idle < 3) throw new Error("The metadata pool never went idle.");
  }

  beforeAll(async () => {
    const baseName = decodeURIComponent(new URL(testUrl).pathname.slice(1));
    if (!/test/i.test(baseName)) {
      throw new Error(
        `TEST_DATABASE_URL names "${baseName}". These tests create and drop databases, ` +
          `so they only run against one whose name contains "test".`
      );
    }
    server = await connectTo(testUrl);
    databaseName = `${baseName}_push`;
    await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
    const url = urlFor(databaseName);

    jest.resetModules();
    globalThis.__metadataSequelize = undefined;
    process.env.DATABASE_URL_A = url;
    process.env.APP_ENCRYPTION_KEY = "a".repeat(64);
    delete process.env.SCHEMA_STUDIO_DESKTOP;
    const bootstrap = await import("@/lib/db/bootstrap");
    await bootstrap.syncMetadataTables();
    ({ sequelize } = await import("@/lib/db/sequelize"));
    push = await import("@/lib/push-db");
    encryption = await import("@/lib/secret-store");

    db = await connectTo(url);
    [orgA] = await rows<Org>(`SELECT id FROM organizations WHERE is_default`);
    [orgB] = await rows<Org>(
      `INSERT INTO organizations (slug, name) VALUES ('other-org', 'Other org') RETURNING id`
    );
    await bootstrap.setUpRoles();
    ada = await person("ada", [{ org: orgA, role: "admin" }]);
    bea = await person("bea", [{ org: orgB, role: "viewer" }]);
  }, SETUP);

  afterAll(async () => {
    if (sequelize) {
      await settle();
      await sequelize.close();
    }
    globalThis.__metadataSequelize = undefined;
    if (savedUrl === undefined) delete process.env.DATABASE_URL_A;
    else process.env.DATABASE_URL_A = savedUrl;
    if (savedDesktop === undefined) delete process.env.SCHEMA_STUDIO_DESKTOP;
    else process.env.SCHEMA_STUDIO_DESKTOP = savedDesktop;
    if (savedKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = savedKey;
    await db?.end();
    if (server) {
      if (databaseName) {
        await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
      }
      await server.end();
    }
  }, SETUP);

  beforeEach(async () => {
    await db.query(`DELETE FROM push_subscriptions`);
  });

  describe("the tables", () => {
    it("has a real unique constraint for ON CONFLICT (endpoint) to lean on", async () => {
      const found = await rows<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'push_subscriptions'::regclass AND contype = 'u'`
      );
      expect(found.map((row) => row.definition)).toContain("UNIQUE (endpoint)");
    });

    it("takes a person's devices with them when they go", async () => {
      const found = await rows<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'push_subscriptions'::regclass AND contype = 'f'`
      );
      expect(found).toHaveLength(1);
      expect(found[0].definition).toContain("REFERENCES profiles(id) ON DELETE CASCADE");

      const leaver = await person("leaver", [{ org: orgA, role: "viewer" }]);
      await push.savePushSubscription(leaver.id, device());
      await db.query(`DELETE FROM profiles WHERE id = $1`, [leaver.id]);
      expect(await push.listOwnSubscriptions(leaver.id)).toEqual([]);
    }, SLOW);

    it("survives setup running again on the same database", async () => {
      const bootstrap = await import("@/lib/db/bootstrap");
      await bootstrap.syncMetadataTables();
      await push.savePushSubscription(ada.id, device());
      expect(await push.listOwnSubscriptions(ada.id)).toHaveLength(1);
    }, SLOW);
  });

  describe("the push key", () => {
    it("makes one key and keeps it, encrypted", async () => {
      const first = await push.pushPublicKey();
      expect(await push.pushPublicKey()).toBe(first);
      const [stored] = await rows<{ private_key: string }>(`SELECT private_key FROM push_keys`);
      expect(stored.private_key).toMatch(/^enc:v1:/);
      expect(readPushKey(encryption.decryptSecret(stored.private_key) ?? "")?.publicKey.toString("base64url")).toBe(first);
    }, SLOW);

    it("agrees on one key when two servers start at once", async () => {
      await db.query(`DELETE FROM push_keys`);
      const keys = await Promise.all([push.pushPublicKey(), push.pushPublicKey(), push.pushPublicKey()]);
      expect(new Set(keys).size).toBe(1);
      expect(await rows(`SELECT name FROM push_keys`)).toHaveLength(1);
    }, SLOW);

    it("makes a new key when the old one can no longer be read, and forgets the devices tied to it", async () => {
      const first = await push.pushPublicKey();
      await push.savePushSubscription(ada.id, device());
      await db.query(`UPDATE push_keys SET private_key = 'not something this server encrypted'`);
      const second = await push.pushPublicKey();
      expect(second).not.toBe(first);
      expect(await push.listOwnSubscriptions(ada.id)).toEqual([]);
    }, SLOW);

    it("keeps an https address and nothing else", async () => {
      await push.pushPublicKey();
      await db.query(`UPDATE push_keys SET site_origin = NULL`);
      await push.rememberSiteOrigin("http://fyp.example.test");
      await push.rememberSiteOrigin(null);
      expect((await push.pushSender()).siteOrigin).toBeNull();
      await push.rememberSiteOrigin("https://fyp.example.test");
      expect((await push.pushSender()).siteOrigin).toBe("https://fyp.example.test");
    }, SLOW);
  });

  describe("devices", () => {
    it("keeps a device and gives it back", async () => {
      const phone = device();
      await push.savePushSubscription(ada.id, phone);
      const [own] = await push.listOwnSubscriptions(ada.id);
      expect(own).toMatchObject(phone);
    }, SLOW);

    it("does not make a second row for a device sent again", async () => {
      const phone = device();
      await push.savePushSubscription(ada.id, phone);
      await push.savePushSubscription(ada.id, { ...phone, auth: "changed" });
      const own = await push.listOwnSubscriptions(ada.id);
      expect(own).toHaveLength(1);
      expect(own[0].auth).toBe("changed");
    }, SLOW);

    it("moves a shared phone to whoever turned alerts on last", async () => {
      const phone = device();
      await push.savePushSubscription(ada.id, phone);
      await push.savePushSubscription(bea.id, phone);
      expect(await push.listOwnSubscriptions(ada.id)).toEqual([]);
      expect(await push.listOwnSubscriptions(bea.id)).toHaveLength(1);
    }, SLOW);

    it("lets a person forget their own device and nobody else's", async () => {
      const phone = device();
      await push.savePushSubscription(ada.id, phone);
      await push.deletePushSubscription(bea.id, phone.endpoint);
      expect(await push.listOwnSubscriptions(ada.id)).toHaveLength(1);
      await push.deletePushSubscription(ada.id, phone.endpoint);
      expect(await push.listOwnSubscriptions(ada.id)).toEqual([]);
    }, SLOW);

    it("keeps a person's newest devices, up to the limit", async () => {
      const phones = Array.from({ length: push.MOST_DEVICES_PER_PERSON + 2 }, device);
      for (const phone of phones) await push.savePushSubscription(ada.id, phone);
      const kept = (await push.listOwnSubscriptions(ada.id)).map((row) => row.endpoint);
      expect(kept).toHaveLength(push.MOST_DEVICES_PER_PERSON);
      expect(kept).not.toContain(phones[0].endpoint);
      expect(kept).toContain(phones[phones.length - 1].endpoint);
    }, SLOW);

    it("waits out a push service's request to slow down", async () => {
      const phone = device();
      await push.savePushSubscription(ada.id, phone);
      const [{ id }] = await push.listOwnSubscriptions(ada.id);
      await push.holdPushSubscription(id, new Date(Date.now() + 60_000));
      expect(await push.listOwnSubscriptions(ada.id)).toEqual([]);
      expect(await push.subscriptionsInOrganization(orgA.id)).toEqual([]);
      await push.holdPushSubscription(id, new Date(Date.now() - 60_000));
      expect(await push.listOwnSubscriptions(ada.id)).toHaveLength(1);
      expect(await push.subscriptionsInOrganization(orgA.id)).toHaveLength(1);
    }, SLOW);

    it("forgets a device that has gone", async () => {
      await push.savePushSubscription(ada.id, device());
      const [{ id }] = await push.listOwnSubscriptions(ada.id);
      await push.dropPushSubscription(id);
      expect(await push.listOwnSubscriptions(ada.id)).toEqual([]);
    }, SLOW);
  });

  describe("an organization's devices", () => {
    it("holds only its members, with who they are and their role here", async () => {
      await push.savePushSubscription(ada.id, device());
      await push.savePushSubscription(bea.id, device());
      const inA = await push.subscriptionsInOrganization(orgA.id);
      expect(inA).toHaveLength(1);
      expect(inA[0]).toMatchObject({ profileId: ada.id, email: ada.email, role: "admin" });
    }, SLOW);

    it("uses the person's role in this organization, not another", async () => {
      const both = await person("both", [
        { org: orgA, role: "viewer" },
        { org: orgB, role: "admin" },
      ]);
      await push.savePushSubscription(both.id, device());
      expect((await push.subscriptionsInOrganization(orgA.id))[0].role).toBe("viewer");
      expect((await push.subscriptionsInOrganization(orgB.id))[0].role).toBe("admin");
    }, SLOW);

    it("stops the moment someone is taken out", async () => {
      const leaver = await person("leaver", [{ org: orgA, role: "viewer" }]);
      await push.savePushSubscription(leaver.id, device());
      expect(await push.subscriptionsInOrganization(orgA.id)).toHaveLength(1);
      await db.query(`DELETE FROM memberships WHERE profile_id = $1 AND org_id = $2`, [leaver.id, orgA.id]);
      expect(await push.subscriptionsInOrganization(orgA.id)).toEqual([]);
    }, SLOW);

    it("has no devices in an organization that has none", async () => {
      await push.savePushSubscription(ada.id, device());
      expect(await push.subscriptionsInOrganization(orgB.id)).toEqual([]);
    }, SLOW);
  });
});
