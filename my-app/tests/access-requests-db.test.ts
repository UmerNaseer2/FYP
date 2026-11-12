// access-requests-db: requests, and the runs waiting on someone, in a
// real metadata database.
//
// tests/requests-routes.test.ts checks what the routes do with each answer the
// stores give. Only Postgres can say whether those answers are right: whether a
// person's request really stays in their organization, whether someone who left
// really reads as gone, and whether a second answer really finds nothing to do.
// So this file drives the stores against a fresh database with two
// organizations in it.
//
// It needs a Postgres it may create and drop databases in, so it runs only when
// TEST_DATABASE_URL is set (CI sets it, and fails rather than skip without it:
// see tests/helpers/test-database.ts), and only against a database whose name
// contains "test". tests/invites-db.test.ts shows how to start one locally.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
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

describeWithDatabase("requests in a real metadata database", () => {
  const savedUrl = process.env.DATABASE_URL_A;
  const savedDesktop = process.env.SCHEMA_STUDIO_DESKTOP;
  let server: Client;
  let db: Client;
  let databaseName = "";

  // The code under test. Imported after DATABASE_URL_A points at the fresh
  // database, so it uses the one Sequelize pool made for it.
  let sequelize: typeof import("@/lib/db/sequelize").sequelize;
  let requests: typeof import("@/lib/access-requests-db");
  let approvals: typeof import("@/lib/approvals-db");

  let orgA: Org;
  let orgB: Org;
  /** An Admin of A, who answers. */
  let ada: Person;
  /** A Viewer of A, who asks. */
  let vic: Person;
  /** A Viewer of B, who should never meet the other two. */
  let bea: Person;
  let connectionA = 0;
  let connectionB = 0;

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

  async function connection(org: Org, name: string): Promise<number> {
    const [row] = await rows<{ id: number }>(
      `INSERT INTO connections (org_id, name, host, username, password)
       VALUES ($1, $2, 'db.example.test', 'reader', $3)
       RETURNING id`,
      [org.id, name, randomUUID()]
    );
    return row.id;
  }

  /** Makes a request, and insists it was made. */
  async function ask(org: Org, who: Person, permission: string | null, message: string | null = null) {
    const made = await requests.createAccessRequest({
      orgId: org.id,
      email: who.email,
      name: "Someone",
      permission,
      message,
    });
    if (made.kind !== "created") throw new Error(`Expected a new request, got "${made.kind}".`);
    return made.request;
  }

  /** A production run in the state a test needs, without the journey it took to get there. */
  async function run(
    org: Org,
    connectionId: number,
    requestedBy: string,
    over: {
      status?: string;
      decidedBy?: string | null;
      decidedAt?: string | null;
      expiresAt?: string | null;
      selfApproved?: boolean;
    } = {}
  ): Promise<number> {
    const [row] = await rows<{ id: number }>(
      `INSERT INTO deploy_approvals
         (org_id, connection_id, schema_name, script_name, target_version, run_fingerprint,
          migration_count, breaking_count, requested_by, status, decided_by, decided_at,
          expires_at, self_approved, action)
       VALUES ($1, $2, 'shop', 'add_author', '1.0.0', $3, 1, 0, $4, $5, $6, $7, $8, $9, 'deploy')
       RETURNING id`,
      [
        org.id,
        connectionId,
        randomUUID(),
        requestedBy,
        over.status ?? "pending",
        over.decidedBy ?? null,
        over.decidedAt ?? null,
        over.expiresAt ?? null,
        over.selfApproved ?? false,
      ]
    );
    return row.id;
  }

  /** Wait until the metadata pool has nothing in flight (tests/org-data-db.test.ts says why). */
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
    databaseName = `${baseName}_requests`;
    await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
    const url = urlFor(databaseName);

    jest.resetModules();
    globalThis.__metadataSequelize = undefined;
    process.env.DATABASE_URL_A = url;
    delete process.env.SCHEMA_STUDIO_DESKTOP;
    const bootstrap = await import("@/lib/db/bootstrap");
    await bootstrap.syncMetadataTables();
    ({ sequelize } = await import("@/lib/db/sequelize"));
    requests = await import("@/lib/access-requests-db");
    approvals = await import("@/lib/approvals-db");

    db = await connectTo(url);
    [orgA] = await rows<Org>(`SELECT id FROM organizations WHERE is_default`);
    [orgB] = await rows<Org>(
      `INSERT INTO organizations (slug, name) VALUES ('other-org', 'Other org') RETURNING id`
    );
    // The second organization gets its built-in roles the way any
    // organization the app finds without them does.
    await bootstrap.setUpRoles();
    ada = await person("ada", [{ org: orgA, role: "admin" }]);
    vic = await person("vic", [{ org: orgA, role: "viewer" }]);
    bea = await person("bea", [{ org: orgB, role: "viewer" }]);
    connectionA = await connection(orgA, "Bookshop A");
    connectionB = await connection(orgB, "Bookshop B");
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
    await db?.end();
    if (server) {
      if (databaseName) {
        await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
      }
      await server.end();
    }
  }, SETUP);

  // The tests share one database, and each starts with nothing asked.
  beforeEach(async () => {
    await db.query(`DELETE FROM access_requests`);
    await db.query(`DELETE FROM deploy_approvals`);
  });

  describe("asking", () => {
    it("keeps who asked, for what and why, as waiting", async () => {
      const request = await ask(orgA, vic, "deploy:run", "For the release.");
      expect(request).toMatchObject({
        requested_by: vic.email,
        requested_by_name: "Someone",
        permission: "deploy:run",
        message: "For the release.",
        status: "pending",
        decided_by: null,
        decided_at: null,
        decision_note: null,
      });
    }, SLOW);

    it("answers with the one already waiting, in any spelling of the address", async () => {
      const first = await ask(orgA, vic, "deploy:run");
      const again = await requests.createAccessRequest({
        orgId: orgA.id,
        email: vic.email.toUpperCase(),
        name: null,
        permission: "deploy:run",
        message: null,
      });
      expect(again.kind).toBe("already");
      if (again.kind === "already") expect(again.request.id).toBe(first.id);
      expect(await requests.listOwnRequests(orgA.id, vic.email)).toHaveLength(1);
    }, SLOW);

    it("lets someone ask again once the first was answered", async () => {
      const first = await ask(orgA, vic, "deploy:run");
      await requests.answerAccessRequest(orgA.id, first.id, "declined", ada.email, null);
      const second = await ask(orgA, vic, "deploy:run");
      expect(second.id).not.toBe(first.id);
    }, SLOW);

    it("adds every something else, because no two need be the same", async () => {
      const first = await ask(orgA, vic, null, "A role in between.");
      const second = await ask(orgA, vic, null, "A role in between.");
      expect(second.id).not.toBe(first.id);
    }, SLOW);

    it("keeps people and organizations apart when they ask for the same thing", async () => {
      await ask(orgA, vic, "deploy:run");
      await ask(orgA, ada, "deploy:run");
      await ask(orgB, bea, "deploy:run");
      await ask(orgB, vic, "deploy:run");
      const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM access_requests`);
      expect(n).toBe(4);
    }, SLOW);

    it("stops at 20 waiting, and starts again once one is out of the way", async () => {
      let last = 0;
      for (let index = 0; index < 20; index += 1) {
        last = (await ask(orgA, vic, null, `Number ${index}`)).id;
      }
      const tooMany = (permission: string | null) =>
        requests.createAccessRequest({
          orgId: orgA.id,
          email: vic.email,
          name: null,
          permission,
          message: "One more",
        });
      expect((await tooMany(null)).kind).toBe("too-many");
      expect((await tooMany("deploy:run")).kind).toBe("too-many");
      // Someone else is not held up by it.
      expect((await ask(orgA, ada, null, "Mine")).status).toBe("pending");

      await requests.withdrawAccessRequest(orgA.id, last, vic.email);
      expect((await tooMany(null)).kind).toBe("created");
    }, SLOW);

    it("refuses a status nothing knows, whatever writes it", async () => {
      const request = await ask(orgA, vic, "deploy:run");
      await expect(
        db.query(`UPDATE access_requests SET status = 'lost' WHERE id = $1`, [request.id])
      ).rejects.toMatchObject({ code: "23514" });
    }, SLOW);
  });

  describe("reading your own", () => {
    it("lists them newest first, answered ones too, in this organization only", async () => {
      const first = await ask(orgA, vic, "deploy:run");
      const second = await ask(orgA, vic, "drift:run");
      await requests.answerAccessRequest(orgA.id, first.id, "done", ada.email, null);
      await ask(orgB, vic, "scripts:create");
      await ask(orgA, ada, "compare:run");

      const own = await requests.listOwnRequests(orgA.id, vic.email.toUpperCase());

      expect(own.map((request) => request.id)).toEqual([second.id, first.id]);
      expect(own[1].status).toBe("done");
    }, SLOW);

    it("finds one by id only in its own organization", async () => {
      const request = await ask(orgA, vic, "deploy:run");
      expect((await requests.getAccessRequest(orgA.id, request.id))?.id).toBe(request.id);
      expect(await requests.getAccessRequest(orgB.id, request.id)).toBeNull();
      expect(await requests.getAccessRequest(orgA.id, request.id + 1000)).toBeNull();
    }, SLOW);
  });

  describe("the inbox", () => {
    it("holds what is waiting here, oldest first, without the reader's own", async () => {
      const first = await ask(orgA, vic, "deploy:run");
      const answered = await ask(orgA, vic, "drift:run");
      await requests.answerAccessRequest(orgA.id, answered.id, "done", ada.email, null);
      const withdrawn = await ask(orgA, vic, "scripts:create");
      await requests.withdrawAccessRequest(orgA.id, withdrawn.id, vic.email);
      const second = await ask(orgA, vic, null, "Something else");
      await ask(orgA, ada, "compare:run");
      await ask(orgB, bea, "deploy:run");

      const inbox = await requests.listRequestInbox(orgA.id, ada.email.toUpperCase());

      expect(inbox.map((request) => request.id)).toEqual([first.id, second.id]);
      expect(await requests.countRequestInbox(orgA.id, ada.email.toUpperCase())).toBe(2);
      expect(await requests.countRequestInbox(orgB.id, ada.email)).toBe(1);
    }, SLOW);

    it("says who the person is here now", async () => {
      await ask(orgA, vic, "deploy:run");
      const [row] = await requests.listRequestInbox(orgA.id, ada.email);
      expect(row).toMatchObject({
        member_id: vic.id,
        member_role: "viewer",
        member_role_label: "Viewer",
      });
    }, SLOW);

    it("reads the role of this organization, for someone in two", async () => {
      const both = await person("both", [
        { org: orgA, role: "viewer" },
        { org: orgB, role: "editor" },
      ]);
      await ask(orgB, both, "deploy:run");
      const [row] = await requests.listRequestInbox(orgB.id, bea.email);
      expect(row.member_role).toBe("editor");
    }, SLOW);

    it("still shows a request from someone who left, with nothing to change", async () => {
      const gone = await person("gone", [{ org: orgA, role: "viewer" }]);
      await ask(orgA, gone, "deploy:run");
      await db.query(`DELETE FROM memberships WHERE profile_id = $1`, [gone.id]);

      const [row] = await requests.listRequestInbox(orgA.id, ada.email);

      expect(row.requested_by).toBe(gone.email);
      expect(row.member_id).toBeNull();
      expect(row.member_role).toBeNull();
      expect(row.member_role_label).toBeNull();
    }, SLOW);

    it("still shows one from someone whose whole profile went", async () => {
      const gone = await person("gone", [{ org: orgA, role: "viewer" }]);
      await ask(orgA, gone, "deploy:run");
      await db.query(`DELETE FROM memberships WHERE profile_id = $1`, [gone.id]);
      await db.query(`DELETE FROM profiles WHERE id = $1`, [gone.id]);
      const [row] = await requests.listRequestInbox(orgA.id, ada.email);
      expect(row.member_id).toBeNull();
    }, SLOW);
  });

  describe("answering", () => {
    it("records the answer, who gave it, when and the note", async () => {
      const request = await ask(orgA, vic, "deploy:run");
      const answered = await requests.answerAccessRequest(
        orgA.id,
        request.id,
        "allowed",
        ada.email,
        "Yours until Friday."
      );
      expect(answered).toMatchObject({
        status: "allowed",
        decided_by: ada.email,
        decision_note: "Yours until Friday.",
      });
      expect(answered?.decided_at).toBeTruthy();
    }, SLOW);

    it("finds nothing to do the second time, and keeps the first answer", async () => {
      const request = await ask(orgA, vic, "deploy:run");
      await requests.answerAccessRequest(orgA.id, request.id, "allowed", ada.email, null);
      const second = await requests.answerAccessRequest(orgA.id, request.id, "declined", "x@test", "No");
      expect(second).toBeNull();
      const [own] = await requests.listOwnRequests(orgA.id, vic.email);
      expect(own).toMatchObject({ status: "allowed", decided_by: ada.email, decision_note: null });
    }, SLOW);

    it("can't touch another organization's", async () => {
      const request = await ask(orgA, vic, "deploy:run");
      expect(
        await requests.answerAccessRequest(orgB.id, request.id, "allowed", bea.email, null)
      ).toBeNull();
      expect((await requests.getAccessRequest(orgA.id, request.id))?.status).toBe("pending");
    }, SLOW);

    it("can't answer one that was taken back", async () => {
      const request = await ask(orgA, vic, "deploy:run");
      await requests.withdrawAccessRequest(orgA.id, request.id, vic.email);
      expect(
        await requests.answerAccessRequest(orgA.id, request.id, "allowed", ada.email, null)
      ).toBeNull();
    }, SLOW);
  });

  describe("withdrawing", () => {
    it("takes back your own, in any spelling of the address", async () => {
      const request = await ask(orgA, vic, "deploy:run");
      const withdrawn = await requests.withdrawAccessRequest(
        orgA.id,
        request.id,
        vic.email.toUpperCase()
      );
      expect(withdrawn?.status).toBe("withdrawn");
    }, SLOW);

    it("can't take back someone else's", async () => {
      const request = await ask(orgA, vic, "deploy:run");
      expect(await requests.withdrawAccessRequest(orgA.id, request.id, ada.email)).toBeNull();
      expect((await requests.getAccessRequest(orgA.id, request.id))?.status).toBe("pending");
    }, SLOW);

    it("can't take back one already answered", async () => {
      const request = await ask(orgA, vic, "deploy:run");
      await requests.answerAccessRequest(orgA.id, request.id, "allowed", ada.email, null);
      expect(await requests.withdrawAccessRequest(orgA.id, request.id, vic.email)).toBeNull();
      expect((await requests.getAccessRequest(orgA.id, request.id))?.status).toBe("allowed");
    }, SLOW);

    it("can't reach into another organization", async () => {
      const request = await ask(orgA, vic, "deploy:run");
      expect(await requests.withdrawAccessRequest(orgB.id, request.id, vic.email)).toBeNull();
    }, SLOW);
  });

  describe("answers not read yet", () => {
    it("counts answers only, and only this person's here", async () => {
      const allowed = await ask(orgA, vic, "deploy:run");
      const declined = await ask(orgA, vic, "drift:run");
      const done = await ask(orgA, vic, null, "Something");
      await ask(orgA, vic, "scripts:create");
      const withdrawn = await ask(orgA, vic, "compare:run");
      const notMine = await ask(orgA, ada, "deploy:run");
      const elsewhere = await ask(orgB, vic, "deploy:run");
      await requests.answerAccessRequest(orgA.id, allowed.id, "allowed", ada.email, null);
      await requests.answerAccessRequest(orgA.id, declined.id, "declined", ada.email, null);
      await requests.answerAccessRequest(orgA.id, done.id, "done", ada.email, null);
      await requests.withdrawAccessRequest(orgA.id, withdrawn.id, vic.email);
      await requests.answerAccessRequest(orgA.id, notMine.id, "done", vic.email, null);
      await requests.answerAccessRequest(orgB.id, elsewhere.id, "done", bea.email, null);

      expect(await requests.countRequestsAnsweredSince(orgA.id, vic.email.toUpperCase(), null)).toBe(3);
    }, SLOW);

    it("counts from when the person last looked", async () => {
      const first = await ask(orgA, vic, "deploy:run");
      await requests.answerAccessRequest(orgA.id, first.id, "done", ada.email, null);
      await db.query(
        `UPDATE access_requests SET decided_at = now() - interval '1 hour' WHERE id = $1`,
        [first.id]
      );
      const second = await ask(orgA, vic, "drift:run");
      await requests.answerAccessRequest(orgA.id, second.id, "done", ada.email, null);
      const halfAnHourAgo = new Date(Date.now() - 30 * 60 * 1000);

      expect(await requests.countRequestsAnsweredSince(orgA.id, vic.email, halfAnHourAgo)).toBe(1);
    }, SLOW);

    it("keeps when a person last looked, one organization at a time", async () => {
      const both = await person("both", [
        { org: orgA, role: "viewer" },
        { org: orgB, role: "viewer" },
      ]);
      expect(await requests.readRequestsSeen(orgA.id, both.id)).toBeNull();

      await requests.markRequestsSeen(orgA.id, both.id);

      const seen = await requests.readRequestsSeen(orgA.id, both.id);
      expect(seen).toBeTruthy();
      expect(await requests.readRequestsSeen(orgB.id, both.id)).toBeNull();
      expect(await requests.readRequestsSeen(orgA.id, vic.id)).toBeNull();
      // What comes back can be used as the "since" of the next count.
      expect(await requests.countRequestsAnsweredSince(orgA.id, both.email, seen)).toBe(0);
    }, SLOW);

    it("marks a person who is not a member as nothing at all", async () => {
      await requests.markRequestsSeen(orgB.id, ada.id);
      expect(await requests.readRequestsSeen(orgB.id, ada.id)).toBeNull();
    }, SLOW);
  });

  describe("production runs waiting on someone", () => {
    const AN_HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const IN_AN_HOUR = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

    it("lists runs to approve here, oldest first, with the connection's name", async () => {
      const first = await run(orgA, connectionA, vic.email);
      await run(orgA, connectionA, vic.email, { status: "approved", decidedBy: ada.email });
      await run(orgA, connectionA, vic.email, { status: "rejected", decidedBy: ada.email });
      const second = await run(orgA, connectionA, ada.email);
      await run(orgB, connectionB, bea.email);

      const listed = await approvals.listRunsToApprove(orgA.id, null);

      expect(listed.map((row) => row.id)).toEqual([first, second]);
      expect(listed[0].connection_name).toBe("Bookshop A");
      expect(await approvals.countRunsToApprove(orgA.id, null)).toBe(2);
    }, SLOW);

    it("leaves out the reader's own when told to, in any spelling of the address", async () => {
      const other = await run(orgA, connectionA, vic.email);
      await run(orgA, connectionA, ada.email);

      const listed = await approvals.listRunsToApprove(orgA.id, ada.email.toUpperCase());

      expect(listed.map((row) => row.id)).toEqual([other]);
      expect(await approvals.countRunsToApprove(orgA.id, ada.email.toUpperCase())).toBe(1);
    }, SLOW);

    it("lists approved runs that can still be run, and no others", async () => {
      const ready = await run(orgA, connectionA, vic.email, {
        status: "approved",
        decidedBy: ada.email,
        expiresAt: IN_AN_HOUR(),
      });
      await run(orgA, connectionA, vic.email, {
        status: "approved",
        decidedBy: ada.email,
        expiresAt: AN_HOUR_AGO(),
      });
      await run(orgA, connectionA, vic.email, { status: "used", decidedBy: ada.email });
      await run(orgA, connectionA, vic.email);
      await run(orgB, connectionB, bea.email, {
        status: "approved",
        decidedBy: ada.email,
        expiresAt: IN_AN_HOUR(),
      });

      const listed = await approvals.listRunsReadyToRun(orgA.id);

      expect(listed.map((row) => row.id)).toEqual([ready]);
      expect(listed[0].connection_name).toBe("Bookshop A");
      expect(await approvals.countRunsReadyToRun(orgA.id)).toBe(1);
    }, SLOW);

    it("lists a person's own runs newest first, at most 20, in this organization", async () => {
      const ids: number[] = [];
      for (let index = 0; index < 21; index += 1) ids.push(await run(orgA, connectionA, vic.email));
      await run(orgA, connectionA, ada.email);
      await run(orgB, connectionB, vic.email);

      const own = await approvals.listOwnRuns(orgA.id, vic.email.toUpperCase());

      expect(own.map((row) => row.id)).toEqual(ids.slice(1).reverse());
    }, SLOW);

    it("counts someone else's answers to a person's runs", async () => {
      const decided = { decidedBy: ada.email, decidedAt: AN_HOUR_AGO() };
      await run(orgA, connectionA, vic.email, { status: "approved", ...decided });
      await run(orgA, connectionA, vic.email, { status: "rejected", ...decided });
      await run(orgA, connectionA, vic.email, { status: "used", ...decided });
      await run(orgA, connectionA, vic.email);
      // A person answering their own, where the rule allows it, already knows.
      await run(orgA, connectionA, vic.email, {
        status: "approved",
        decidedBy: vic.email.toUpperCase(),
        decidedAt: AN_HOUR_AGO(),
        selfApproved: true,
      });
      await run(orgA, connectionA, ada.email, {
        status: "approved",
        decidedBy: vic.email,
        decidedAt: AN_HOUR_AGO(),
      });
      await run(orgB, connectionB, vic.email, { status: "approved", ...decided });

      expect(await approvals.countOwnRunsAnsweredSince(orgA.id, vic.email.toUpperCase(), null)).toBe(3);
    }, SLOW);

    it("counts run answers from when the person last looked", async () => {
      await run(orgA, connectionA, vic.email, {
        status: "approved",
        decidedBy: ada.email,
        decidedAt: AN_HOUR_AGO(),
      });
      await run(orgA, connectionA, vic.email, {
        status: "rejected",
        decidedBy: ada.email,
        decidedAt: new Date().toISOString(),
      });
      const halfAnHourAgo = new Date(Date.now() - 30 * 60 * 1000);

      expect(await approvals.countOwnRunsAnsweredSince(orgA.id, vic.email, halfAnHourAgo)).toBe(1);
    }, SLOW);
  });
});
