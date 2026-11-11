// agent-db: linked computers and their questions, in a real metadata database.
//
// tests/agent-routes.test.ts checks what the routes do with each answer. Only
// Postgres can say whether these statements run at all, whether a person leaving
// ends a link, and whether a question really cannot be seen by someone else.
//
// It needs a Postgres it may create and drop databases in, so it runs only when
// TEST_DATABASE_URL is set (CI sets it, and fails rather than skip without it:
// see tests/helpers/test-database.ts), and only against a database whose name
// contains "test". tests/invites-db.test.ts shows how to start one locally.
import { Client } from "pg";
import { QUEUED_FOR_SECONDS, RUNNING_FOR_SECONDS, TOKEN_PREFIX } from "@/lib/agent-rules";
import { testDatabaseUrl } from "./helpers/test-database";

type Org = { id: number };
type Person = { id: number };

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

describeWithDatabase("linked computers in a real metadata database", () => {
  const savedUrl = process.env.DATABASE_URL_A;
  const savedDesktop = process.env.SCHEMA_STUDIO_DESKTOP;
  const savedKey = process.env.APP_ENCRYPTION_KEY;
  let server: Client;
  let db: Client;
  let databaseName = "";

  let sequelize: typeof import("@/lib/db/sequelize").sequelize;
  let agents: typeof import("@/lib/agent-db");

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
    const [profile] = await rows<{ id: number }>(`INSERT INTO profiles (email) VALUES ($1) RETURNING id`, [
      `${name}.${addresses}@example.test`,
    ]);
    for (const { org, role } of memberOf) {
      await db.query(`INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, $3)`, [
        org.id,
        profile.id,
        role,
      ]);
    }
    return { id: profile.id };
  }

  /** Link a computer the whole way through and say it was just heard from. */
  async function linked(org: Org, who: Person, name = "Ada's laptop") {
    const opened = await agents.openLink(name);
    if (opened === null) throw new Error("No link opened.");
    expect(await agents.approveLink(opened.userCode, org.id, who.id)).toBe(true);
    const claimed = await agents.claimLink(opened.deviceCode);
    if (claimed.kind !== "linked") throw new Error(`Link ${claimed.kind}.`);
    const caller = await agents.findAgent(claimed.token);
    if (caller === null) throw new Error("Link not found.");
    await db.query(`UPDATE agents SET last_seen_at = now() WHERE id = $1`, [caller.id]);
    return { token: claimed.token, caller };
  }

  const LIST = { method: "schemas.list" as const, params: { connectionId: 1 } };

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
    databaseName = `${baseName}_agents`;
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
    agents = await import("@/lib/agent-db");

    db = await connectTo(url);
    [orgA] = await rows<Org>(`SELECT id FROM organizations WHERE is_default`);
    [orgB] = await rows<Org>(
      `INSERT INTO organizations (slug, name) VALUES ('other-org', 'Other org') RETURNING id`
    );
    await bootstrap.setUpRoles();
    ada = await person("ada", [{ org: orgA, role: "admin" }]);
    bea = await person("bea", [{ org: orgA, role: "admin" }, { org: orgB, role: "admin" }]);
  }, SETUP);

  afterAll(async () => {
    await settle().catch(() => undefined);
    await sequelize?.close().catch(() => undefined);
    await db?.end().catch(() => undefined);
    if (databaseName) {
      await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`).catch(() => undefined);
    }
    await server?.end().catch(() => undefined);
    globalThis.__metadataSequelize = undefined;
    if (savedUrl === undefined) delete process.env.DATABASE_URL_A;
    else process.env.DATABASE_URL_A = savedUrl;
    if (savedDesktop === undefined) delete process.env.SCHEMA_STUDIO_DESKTOP;
    else process.env.SCHEMA_STUDIO_DESKTOP = savedDesktop;
    if (savedKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = savedKey;
  }, SETUP);

  beforeEach(async () => {
    await db.query(`DELETE FROM agents`);
    await db.query(`DELETE FROM agent_links`);
  });

  describe("linking", () => {
    it("waits, then hands over a token once, and keeps only hashes", async () => {
      const opened = await agents.openLink("Ada's laptop");
      if (opened === null) throw new Error("No link opened.");
      const waiting = await agents.readLink(opened.userCode);
      expect(waiting?.computerName).toBe("Ada's laptop");
      // When it was opened, for the person approving to check: just now.
      const openedAgo = Date.now() - new Date(waiting?.openedAt ?? "").getTime();
      expect(Math.abs(openedAgo)).toBeLessThan(60_000);
      expect(await agents.claimLink(opened.deviceCode)).toEqual({ kind: "waiting" });

      expect(await agents.approveLink(opened.userCode, orgA.id, ada.id)).toBe(true);
      // Approved already, so it can be neither read nor approved by anyone else.
      expect(await agents.readLink(opened.userCode)).toBeNull();
      expect(await agents.approveLink(opened.userCode, orgA.id, bea.id)).toBe(false);

      const claimed = await agents.claimLink(opened.deviceCode);
      if (claimed.kind !== "linked") throw new Error(claimed.kind);
      expect(claimed.token.startsWith(TOKEN_PREFIX)).toBe(true);
      expect(claimed.org.slug).toBeTruthy();

      expect(await agents.claimLink(opened.deviceCode)).toEqual({ kind: "gone" });
      const [row] = await rows<{ token_hash: string; profile_id: number; org_id: number }>(
        `SELECT token_hash, profile_id, org_id FROM agents`
      );
      expect(row).toMatchObject({ profile_id: ada.id, org_id: orgA.id });
      expect(row.token_hash).toBe(agents.hashSecret(claimed.token));
      expect(row.token_hash).not.toContain(claimed.token);
    }, SLOW);

    it("hands over one token when the same code is claimed twice at once", async () => {
      const opened = await agents.openLink("Ada's laptop");
      if (opened === null) throw new Error("No link opened.");
      await agents.approveLink(opened.userCode, orgA.id, ada.id);
      const results = await Promise.all([
        agents.claimLink(opened.deviceCode),
        agents.claimLink(opened.deviceCode),
        agents.claimLink(opened.deviceCode),
      ]);
      expect(results.filter((each) => each.kind === "linked")).toHaveLength(1);
      expect(await rows(`SELECT id FROM agents`)).toHaveLength(1);
    }, SLOW);

    it("goes when someone turns it away", async () => {
      const opened = await agents.openLink("Not mine");
      if (opened === null) throw new Error("No link opened.");
      await agents.denyLink(opened.userCode);
      expect(await agents.readLink(opened.userCode)).toBeNull();
      expect(await agents.claimLink(opened.deviceCode)).toEqual({ kind: "gone" });
    }, SLOW);

    it("expires, approved or not", async () => {
      const opened = await agents.openLink("Slow");
      if (opened === null) throw new Error("No link opened.");
      await agents.approveLink(opened.userCode, orgA.id, ada.id);
      await db.query(`UPDATE agent_links SET expires_at = now() - interval '1 second'`);
      expect(await agents.claimLink(opened.deviceCode)).toEqual({ kind: "gone" });
      expect(await agents.approveLink(opened.userCode, orgA.id, ada.id)).toBe(false);
      expect(await rows(`SELECT id FROM agents`)).toHaveLength(0);
    }, SLOW);

    it("links nothing if the person left between approving and the computer collecting", async () => {
      const leaver = await person("leaver", [{ org: orgB, role: "admin" }]);
      const opened = await agents.openLink("Theirs");
      if (opened === null) throw new Error("No link opened.");
      await agents.approveLink(opened.userCode, orgB.id, leaver.id);
      await db.query(`DELETE FROM memberships WHERE profile_id = $1`, [leaver.id]);
      expect(await agents.claimLink(opened.deviceCode)).toEqual({ kind: "gone" });
      expect(await rows(`SELECT id FROM agents`)).toHaveLength(0);
    }, SLOW);

    it("stops opening new links past the cap", async () => {
      await db.query(
        `INSERT INTO agent_links (device_code_hash, user_code, computer_name, expires_at)
         SELECT 'h' || n, 'CODE' || n, 'x', now() + interval '5 minutes' FROM generate_series(1, 100) n`
      );
      expect(await agents.openLink("One too many")).toBeNull();
      await db.query(`UPDATE agent_links SET expires_at = now() - interval '1 second'`);
      // Old links are cleared first, so the cap only counts ones still open.
      expect(await agents.openLink("Next")).not.toBeNull();
    }, SLOW);

    it("lets one caller hold five waiting links, and leaves room for everyone else", async () => {
      for (let n = 1; n <= 5; n++) {
        expect(await agents.openLink(`Flood ${n}`, "203.0.113.9")).not.toBeNull();
      }
      expect(await agents.openLink("Flood 6", "203.0.113.9")).toBeNull();
      // Someone else, and a caller whose address is not known, still get in.
      expect(await agents.openLink("Ada's laptop", "198.51.100.7")).not.toBeNull();
      expect(await agents.openLink("No address")).not.toBeNull();
      // Only a hash of the address is kept.
      const kept = await rows<{ caller_hash: string | null }>(`SELECT DISTINCT caller_hash FROM agent_links`);
      expect(JSON.stringify(kept)).not.toContain("203.0.113.9");
    }, SLOW);

    it("stops counting a link against its caller once somebody approved it", async () => {
      const opened = [];
      for (let n = 1; n <= 5; n++) opened.push(await agents.openLink(`Office ${n}`, "203.0.113.9"));
      expect(await agents.openLink("Office 6", "203.0.113.9")).toBeNull();
      await db.query(`UPDATE agent_links SET approved_at = now() WHERE user_code = $1`, [opened[0]?.userCode]);
      expect(await agents.openLink("Office 6", "203.0.113.9")).not.toBeNull();
    }, SLOW);

    it("keeps a person's ten newest computers", async () => {
      const first = await linked(orgA, ada, "Oldest");
      for (let count = 0; count < 10; count += 1) await linked(orgA, ada, `Computer ${count}`);
      expect(await rows(`SELECT id FROM agents WHERE profile_id = $1`, [ada.id])).toHaveLength(10);
      expect(await agents.findAgent(first.token)).toBeNull();
    }, SLOW);
  });

  describe("a computer's token", () => {
    it("names the computer until it is unlinked", async () => {
      const { token, caller } = await linked(orgA, ada);
      expect(caller).toMatchObject({ orgId: orgA.id, profileId: ada.id });
      await agents.removeAgent(caller.id);
      expect(await agents.findAgent(token)).toBeNull();
    }, SLOW);

    it("stops working the moment its person leaves the organization", async () => {
      const leaver = await person("leaver", [{ org: orgB, role: "admin" }]);
      const { token } = await linked(orgB, leaver);
      expect(await agents.findAgent(token)).not.toBeNull();
      await db.query(`DELETE FROM memberships WHERE profile_id = $1`, [leaver.id]);
      expect(await agents.findAgent(token)).toBeNull();
    }, SLOW);

    it("means nothing when it is not one", async () => {
      expect(await agents.findAgent(`${TOKEN_PREFIX}made-up`)).toBeNull();
    }, SLOW);

    it("stops working once its computer has not called for ninety days", async () => {
      const { token, caller } = await linked(orgA, ada);
      await db.query(`UPDATE agents SET last_seen_at = now() - interval '89 days' WHERE id = $1`, [caller.id]);
      expect(await agents.findAgent(token)).not.toBeNull();
      await db.query(`UPDATE agents SET last_seen_at = now() - interval '91 days' WHERE id = $1`, [caller.id]);
      expect(await agents.findAgent(token)).toBeNull();
      // A computer never heard from counts from the day it was linked.
      await db.query(`UPDATE agents SET last_seen_at = NULL WHERE id = $1`, [caller.id]);
      expect(await agents.findAgent(token)).not.toBeNull();
      await db.query(`UPDATE agents SET created_at = now() - interval '91 days' WHERE id = $1`, [caller.id]);
      expect(await agents.findAgent(token)).toBeNull();
    }, SLOW);

    it("stays alive while its computer keeps calling", async () => {
      const { token, caller } = await linked(orgA, ada);
      await db.query(
        `UPDATE agents SET created_at = now() - interval '200 days', last_seen_at = now() - interval '89 days' WHERE id = $1`,
        [caller.id]
      );
      await agents.nextAgentJob(caller.id);
      await db.query(`UPDATE agents SET last_seen_at = last_seen_at - interval '2 days' WHERE id = $1`, [caller.id]);
      expect(await agents.findAgent(token)).not.toBeNull();
    }, SLOW);

    it("is cleared away with the other old rows once it has ended that way", async () => {
      const kept = await linked(orgA, ada, "In use");
      const left = await linked(orgA, bea, "Put away");
      await db.query(`UPDATE agents SET last_seen_at = now() - interval '91 days' WHERE id = $1`, [left.caller.id]);
      await agents.sweepAgentRows();
      expect(await rows<{ id: number }>(`SELECT id FROM agents`)).toEqual([{ id: kept.caller.id }]);
    }, SLOW);
  });

  describe("the connections a computer shares", () => {
    it("replaces the list, and keeps no more than names, environments, sharing and drift results", async () => {
      const { caller } = await linked(orgA, ada);
      await agents.replaceAgentConnections(caller.id, [
        { id: 2, name: "Bookshop prod", environment: "prod" },
        { id: 1, name: "Bookshop dev", environment: "dev" },
      ]);
      await agents.replaceAgentConnections(caller.id, [
        { id: 1, name: "Bookshop dev renamed", environment: "staging" },
        { id: 3, name: "New", environment: "unset" },
      ]);
      const [computer] = await agents.listComputers(orgA.id, ada.id);
      // A list from before computers said which they share counts every one as shared.
      expect(computer.connections).toEqual([
        { id: 1, name: "Bookshop dev renamed", environment: "staging", shared: true, drift: [] },
        { id: 3, name: "New", environment: "unset", shared: true, drift: [] },
      ]);
      const columns = await rows<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_connections'`
      );
      expect(columns.map((column) => column.column_name).sort()).toEqual([
        "agent_id",
        "drift",
        "environment",
        "id",
        "local_id",
        "name",
        "shared",
      ]);
      await agents.replaceAgentConnections(caller.id, []);
      expect((await agents.listComputers(orgA.id, ada.id))[0].connections).toEqual([]);
    }, SLOW);

    it("shows a computer only to the person who linked it, in that organization", async () => {
      await linked(orgA, ada);
      expect(await agents.listComputers(orgA.id, ada.id)).toHaveLength(1);
      expect(await agents.listComputers(orgA.id, bea.id)).toEqual([]);
      expect(await agents.listComputers(orgB.id, ada.id)).toEqual([]);
    }, SLOW);

    it("lists every computer in the organization by name, with whose it is", async () => {
      const { caller } = await linked(orgA, ada);
      await agents.replaceAgentConnections(caller.id, [{ id: 7, name: "Laptop DB", environment: "dev", shared: false }]);
      await db.query(`UPDATE profiles SET name = 'Ada' WHERE id = $1`, [ada.id]);
      // Bea sees Ada's computer and what it holds, by name and environment only.
      const [seen] = await agents.listOrgComputers(orgA.id, bea.id);
      expect(seen).toMatchObject({ name: "Ada's laptop", owner: "Ada", mine: false });
      expect(seen.connections).toEqual([{ id: 7, name: "Laptop DB", environment: "dev" }]);
      expect((await agents.listOrgComputers(orgA.id, ada.id))[0].mine).toBe(true);
      // Nobody signed in still gets the list, marked as no one's.
      expect((await agents.listOrgComputers(orgA.id, null))[0].mine).toBe(false);
      // Another organization sees none of it.
      expect(await agents.listOrgComputers(orgB.id, bea.id)).toEqual([]);
    }, SLOW);

    it("says whether a computer was heard from lately", async () => {
      const { caller } = await linked(orgA, ada);
      expect((await agents.listComputers(orgA.id, ada.id))[0].online).toBe(true);
      await db.query(`UPDATE agents SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`, [caller.id]);
      expect((await agents.listComputers(orgA.id, ada.id))[0].online).toBe(false);
      await db.query(`UPDATE agents SET last_seen_at = NULL WHERE id = $1`, [caller.id]);
      const [never] = await agents.listComputers(orgA.id, ada.id);
      expect(never).toMatchObject({ online: false, lastSeenAt: null });
    }, SLOW);

    it("lets only its owner remove it", async () => {
      const { caller } = await linked(orgA, ada);
      expect(await agents.removeComputer(orgA.id, bea.id, caller.id)).toBe(false);
      expect(await agents.removeComputer(orgB.id, ada.id, caller.id)).toBe(false);
      expect(await agents.removeComputer(orgA.id, ada.id, caller.id)).toBe(true);
      expect(await agents.listComputers(orgA.id, ada.id)).toEqual([]);
    }, SLOW);

    it("lets an Admin's route remove any computer of the organization, and no other's", async () => {
      const { token, caller } = await linked(orgA, ada);
      // Not from another organization, whoever asks.
      expect(await agents.removeOrgComputer(orgB.id, caller.id)).toBe(false);
      expect(await agents.findAgent(token)).not.toBeNull();
      // From its own, without being its owner. The token is dead at once.
      expect(await agents.removeOrgComputer(orgA.id, caller.id)).toBe(true);
      expect(await agents.findAgent(token)).toBeNull();
      expect(await agents.listOrgComputers(orgA.id, bea.id)).toEqual([]);
      expect(await agents.removeOrgComputer(orgA.id, caller.id)).toBe(false);
    }, SLOW);
  });

  describe("questions", () => {
    async function shared() {
      const link = await linked(orgA, ada);
      await agents.replaceAgentConnections(link.caller.id, [{ id: 1, name: "One", environment: "dev" }]);
      return link;
    }

    it("go from the person to the computer and back", async () => {
      const { caller } = await shared();
      const created = await agents.createAgentJob(orgA.id, ada.id, caller.id, LIST, [1]);
      if (created.kind !== "created") throw new Error(created.kind);
      expect(await agents.readAgentJobFor(orgA.id, ada.id, created.id)).toEqual({ status: "waiting" });

      const job = await agents.nextAgentJob(caller.id);
      expect(job).toEqual({ id: created.id, method: "schemas.list", params: { connectionId: 1 } });
      // Picked up already, so it is not handed out twice.
      expect(await agents.nextAgentJob(caller.id)).toBeNull();
      expect(await agents.runningJobMethod(caller.id, created.id)).toBe("schemas.list");
      expect(await agents.readAgentJobFor(orgA.id, ada.id, created.id)).toEqual({ status: "waiting" });

      expect(await agents.finishAgentJob(caller.id, created.id, { result: { schemas: ["shop"] } })).toBe(true);
      expect(await agents.readAgentJobFor(orgA.id, ada.id, created.id)).toEqual({
        status: "done",
        result: { schemas: ["shop"] },
      });
      // Answered already.
      expect(await agents.finishAgentJob(caller.id, created.id, { refusal: "failed" })).toBe(false);
      expect(await agents.runningJobMethod(caller.id, created.id)).toBeNull();
    }, SLOW);

    it("keep a computer's refusal", async () => {
      const { caller } = await shared();
      const created = await agents.createAgentJob(orgA.id, ada.id, caller.id, LIST, [1]);
      if (created.kind !== "created") throw new Error(created.kind);
      await agents.nextAgentJob(caller.id);
      await agents.finishAgentJob(caller.id, created.id, { refusal: "unreachable" });
      expect(await agents.readAgentJobFor(orgA.id, ada.id, created.id)).toEqual({
        status: "failed",
        refusal: "unreachable",
      });
    }, SLOW);

    it("cannot be left for someone else's computer, or read by anyone else", async () => {
      const { caller } = await shared();
      expect(await agents.createAgentJob(orgA.id, bea.id, caller.id, LIST, [1])).toEqual({ kind: "no-computer" });
      expect(await agents.createAgentJob(orgB.id, ada.id, caller.id, LIST, [1])).toEqual({ kind: "no-computer" });
      const created = await agents.createAgentJob(orgA.id, ada.id, caller.id, LIST, [1]);
      if (created.kind !== "created") throw new Error(created.kind);
      expect(await agents.readAgentJobFor(orgA.id, bea.id, created.id)).toBeNull();
      expect(await agents.readAgentJobFor(orgB.id, ada.id, created.id)).toBeNull();
    }, SLOW);

    it("cannot be answered by another computer", async () => {
      const { caller } = await shared();
      const other = await linked(orgA, bea, "Bea's laptop");
      const created = await agents.createAgentJob(orgA.id, ada.id, caller.id, LIST, [1]);
      if (created.kind !== "created") throw new Error(created.kind);
      expect(await agents.nextAgentJob(other.caller.id)).toBeNull();
      await agents.nextAgentJob(caller.id);
      expect(await agents.finishAgentJob(other.caller.id, created.id, { result: { schemas: ["false"] } })).toBe(false);
      expect(await agents.runningJobMethod(other.caller.id, created.id)).toBeNull();
    }, SLOW);

    it("wait for a computer that is on, and name only what it shares", async () => {
      const { caller } = await shared();
      expect(await agents.createAgentJob(orgA.id, ada.id, caller.id, LIST, [2])).toEqual({ kind: "not-shared" });
      await db.query(`UPDATE agents SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`, [caller.id]);
      expect(await agents.createAgentJob(orgA.id, ada.id, caller.id, LIST, [1])).toEqual({ kind: "off" });
    }, SLOW);

    it("stop at twenty waiting, not counting any given up on", async () => {
      const { caller } = await shared();
      for (let count = 0; count < 20; count += 1) {
        const created = await agents.createAgentJob(orgA.id, ada.id, caller.id, LIST, [1]);
        expect(created.kind).toBe("created");
      }
      expect(await agents.createAgentJob(orgA.id, ada.id, caller.id, LIST, [1])).toEqual({ kind: "too-many" });
      await db.query(`UPDATE agent_jobs SET created_at = now() - make_interval(secs => $1)`, [QUEUED_FOR_SECONDS + 1]);
      expect((await agents.createAgentJob(orgA.id, ada.id, caller.id, LIST, [1])).kind).toBe("created");
    }, SLOW);

    it("are given up on, and a computer waking later runs nothing stale", async () => {
      const { caller } = await shared();
      const queued = await agents.createAgentJob(orgA.id, ada.id, caller.id, LIST, [1]);
      if (queued.kind !== "created") throw new Error(queued.kind);
      await db.query(`UPDATE agent_jobs SET created_at = now() - make_interval(secs => $1) WHERE id = $2`, [
        QUEUED_FOR_SECONDS + 1,
        queued.id,
      ]);
      expect(await agents.readAgentJobFor(orgA.id, ada.id, queued.id)).toEqual({ status: "timed-out" });
      expect(await agents.nextAgentJob(caller.id)).toBeNull();

      const running = await agents.createAgentJob(orgA.id, ada.id, caller.id, LIST, [1]);
      if (running.kind !== "created") throw new Error(running.kind);
      await agents.nextAgentJob(caller.id);
      await db.query(`UPDATE agent_jobs SET picked_at = now() - make_interval(secs => $1) WHERE id = $2`, [
        RUNNING_FOR_SECONDS + 1,
        running.id,
      ]);
      expect(await agents.readAgentJobFor(orgA.id, ada.id, running.id)).toEqual({ status: "timed-out" });
    }, SLOW);

    it("go with the computer, and with its person", async () => {
      const { caller } = await shared();
      const created = await agents.createAgentJob(orgA.id, ada.id, caller.id, LIST, [1]);
      if (created.kind !== "created") throw new Error(created.kind);
      await agents.removeAgent(caller.id);
      expect(await rows(`SELECT id FROM agent_jobs WHERE id = $1`, [created.id])).toEqual([]);
      expect(await rows(`SELECT id FROM agent_connections WHERE agent_id = $1`, [caller.id])).toEqual([]);
    }, SLOW);

    it("are swept once old, with links nobody approved", async () => {
      const { caller } = await shared();
      const created = await agents.createAgentJob(orgA.id, ada.id, caller.id, LIST, [1]);
      if (created.kind !== "created") throw new Error(created.kind);
      const opened = await agents.openLink("Forgotten");
      if (opened === null) throw new Error("No link opened.");
      await agents.sweepAgentRows();
      expect(await rows(`SELECT id FROM agent_jobs`)).toHaveLength(1);
      await db.query(`UPDATE agent_jobs SET created_at = now() - interval '11 minutes'`);
      await db.query(`UPDATE agent_links SET expires_at = now() - interval '1 second'`);
      await agents.sweepAgentRows();
      expect(await rows(`SELECT id FROM agent_jobs`)).toEqual([]);
      expect(await rows(`SELECT id FROM agent_links`)).toEqual([]);
    }, SLOW);

    it("counts a computer's poll as hearing from it, without writing on every call", async () => {
      const { caller } = await shared();
      await db.query(`UPDATE agents SET last_seen_at = now() - interval '1 hour' WHERE id = $1`, [caller.id]);
      await agents.nextAgentJob(caller.id);
      expect((await agents.listComputers(orgA.id, ada.id))[0].online).toBe(true);
      const [before] = await rows<{ last_seen_at: Date }>(`SELECT last_seen_at FROM agents WHERE id = $1`, [caller.id]);
      await agents.nextAgentJob(caller.id);
      const [after] = await rows<{ last_seen_at: Date }>(`SELECT last_seen_at FROM agents WHERE id = $1`, [caller.id]);
      expect(after.last_seen_at).toEqual(before.last_seen_at);
    }, SLOW);
  });
});
