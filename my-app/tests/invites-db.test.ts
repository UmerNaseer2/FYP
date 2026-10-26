// invites-db: invitations in a real metadata database.
//
// tests/admin-invites-route.test.ts and the invitation page's suites check what
// the routes and screens do with each answer lib/invites-db.ts gives. Only
// Postgres can say whether those answers are right: whether the table really
// holds the token's hash and never the token, whether an invitation to an
// address really waits for a provider to vouch for that address, whether
// another organization's invitation really cannot be cancelled from this one,
// and whether the locks and the unique index really hold when two requests
// land at once. So this file drives the store against a fresh database with
// two organizations in it, and reads the tables back.
//
// The races are made to happen, not hoped for. The test opens a transaction
// of its own on a second connection and leaves it half done, starts the
// store's request, waits until Postgres reports that request stuck behind the
// test's lock (waitForLock below), and only then commits.
//
// It needs a Postgres it may create and drop databases in, so it runs only when
// TEST_DATABASE_URL is set (CI sets it, and fails rather than skip without it:
// see tests/helpers/test-database.ts), and only against a database whose name
// contains "test". To run it locally:
//
//   docker run -d --name ss-migration-test -p 127.0.0.1:55432:5432 \
//     -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=schema_studio_test \
//     postgres:17-alpine
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/schema_studio_test \
//     npx jest tests/invites-db.test.ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { testDatabaseUrl } from "./helpers/test-database";

type Org = { id: number; slug: string; name: string };
type Person = { id: number; email: string };
type LogRow = {
  org_id: number;
  role: string;
  kind: string;
  subject: string | null;
  detail: string | null;
  actor: string;
};

const testUrl = testDatabaseUrl();
const describeWithDatabase = testUrl ? describe : describe.skip;

const SLOW = 60_000;
const SETUP = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** The hash the invites table should hold, worked out here rather than by the code under test. */
function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A token of the right shape that no invitation has. */
function unknownToken(): string {
  return randomBytes(32).toString("base64url");
}

describeWithDatabase("invitations in a real metadata database", () => {
  const savedUrl = process.env.DATABASE_URL_A;
  const savedDesktop = process.env.SCHEMA_STUDIO_DESKTOP;
  let server: Client;
  let db: Client;
  let databaseName = "";
  let url = "";

  // The code under test. Imported after DATABASE_URL_A points at the fresh
  // database, so it uses the one Sequelize pool made for it.
  let sequelize: typeof import("@/lib/db/sequelize").sequelize;
  let invites: typeof import("@/lib/invites-db");

  let orgA: Org;
  let orgB: Org;
  /** An Admin of organization A, who makes the invitations. */
  let ada: Person;

  async function rows<T>(text: string, values: unknown[] = []): Promise<T[]> {
    return (await db.query(text, values)).rows as T[];
  }

  async function count(text: string, values: unknown[] = []): Promise<number> {
    const [row] = await rows<{ n: number }>(text, values);
    return row.n;
  }

  let addresses = 0;
  /** An address no other test uses, so the tests share one database without meeting. */
  function freshEmail(name: string): string {
    addresses += 1;
    return `${name}.${addresses}@example.test`;
  }

  /**
   * Someone with a profile under `email`, the sign-ins given, and the
   * memberships given. A sign-in's address is stored exactly as written here.
   */
  async function person(
    email: string,
    {
      signIns = [],
      memberOf = [],
    }: {
      signIns?: { email: string; verified: boolean }[];
      memberOf?: { org: Org; role: string }[];
    } = {}
  ): Promise<Person> {
    const [profile] = await rows<{ id: number }>(
      `INSERT INTO profiles (email) VALUES ($1) RETURNING id`,
      [email]
    );
    for (const signIn of signIns) {
      await db.query(
        `INSERT INTO identities (provider, subject, profile_id, email, email_verified)
         VALUES ('github', $1, $2, $3, $4)`,
        [randomUUID(), profile.id, signIn.email, signIn.verified]
      );
    }
    for (const { org, role } of memberOf) {
      await db.query(`INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, $3)`, [
        org.id,
        profile.id,
        role,
      ]);
    }
    return { id: profile.id, email };
  }

  /**
   * The person an invitation to `email` is for: one whose sign-in provider
   * vouched for that address. Their profile is under another address, so
   * only the sign-in can be what lets them in.
   */
  function ownerOf(email: string): Promise<Person> {
    return person(freshEmail("owner"), { signIns: [{ email, verified: true }] });
  }

  async function emailInvite(org: Org, email: string, role = "editor") {
    const made = await invites.createEmailInvite(org.id, {
      email,
      role,
      invitedBy: ada.id,
      actor: ada.email,
    });
    if (made.kind !== "made") throw new Error(`Expected an invitation, got "${made.kind}".`);
    return made;
  }

  function linkInvite(org: Org, days: 1 | 7 | 30 = 7) {
    return invites.createLinkInvite(org.id, { days, invitedBy: ada.id, actor: ada.email });
  }

  async function expire(inviteId: number): Promise<void> {
    await db.query(`UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      inviteId,
    ]);
  }

  async function pendingIds(org: Org): Promise<number[]> {
    return (await invites.listPendingInvites(org.id)).map((invite) => invite.id);
  }

  /** Where the change log ends now, so a test can read only what it added. */
  async function logMark(): Promise<number> {
    return count(`SELECT coalesce(max(id), 0)::int AS n FROM role_changes`);
  }

  async function logAfter(mark: number): Promise<LogRow[]> {
    return rows<LogRow>(
      `SELECT org_id, role, kind, subject, detail, actor FROM role_changes
        WHERE id > $1 ORDER BY id`,
      [mark]
    );
  }

  /**
   * Wait until another connection to the test database is waiting on a lock:
   * the store's request has reached the row or index entry the test holds.
   *
   * Asked over `server`, which is in no transaction. pg_stat_activity is read
   * once per transaction, so a connection in the middle of one (the one
   * holding the lock, say) would see the same answer however long it asked.
   */
  async function waitForLock(): Promise<void> {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const { rows: found } = await server.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock'`,
        [databaseName]
      );
      if (found[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Nothing ever waited on the lock the test was holding.");
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
    databaseName = `${baseName}_invites`;
    await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
    url = urlFor(databaseName);

    jest.resetModules();
    globalThis.__metadataSequelize = undefined;
    process.env.DATABASE_URL_A = url;
    delete process.env.SCHEMA_STUDIO_DESKTOP;
    const bootstrap = await import("@/lib/db/bootstrap");
    await bootstrap.syncMetadataTables();
    ({ sequelize } = await import("@/lib/db/sequelize"));
    invites = await import("@/lib/invites-db");

    db = await connectTo(url);
    [orgA] = await rows<Org>(`SELECT id, slug, name FROM organizations WHERE is_default`);
    [orgB] = await rows<Org>(
      `INSERT INTO organizations (slug, name) VALUES ('other-org', 'Other org')
       RETURNING id, slug, name`
    );
    // The second organization gets its built-in roles the way any
    // organization the app finds without them does.
    await bootstrap.setUpRoles();
    ada = await person("ada@example.test", { memberOf: [{ org: orgA, role: "admin" }] });
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

  // Nothing here should log an error. The page logs a failed lookup and shows
  // "unavailable", so a statement that broke would otherwise read as an
  // answer the screens know how to draw.
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error");
  });
  afterEach(() => {
    const logged = errorSpy.mock.calls.slice();
    errorSpy.mockRestore();
    expect(logged).toEqual([]);
  });

  describe("an invitation to an address", () => {
    test("stores only the token's hash, lasts a week, is listed as waiting and is logged", async () => {
      const email = freshEmail("new");
      const mark = await logMark();
      const { token, invite } = await emailInvite(orgA, email, "editor");

      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(invite).toEqual({
        id: expect.any(Number),
        kind: "email",
        email,
        role: "editor",
        roleLabel: "Editor",
        invitedBy: ada.email,
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
      });
      expect(Date.parse(invite.expiresAt) - Date.parse(invite.createdAt)).toBe(7 * DAY_MS);

      // The row holds the hash, and nothing in it or the change log holds the
      // token. Nor does the log hold the hash, which would be the next best
      // thing to a list of every invitation's link.
      const [row] = await rows<{ token_hash: string; json: string }>(
        `SELECT token_hash, row_to_json(i)::text AS json FROM invites i WHERE id = $1`,
        [invite.id]
      );
      expect(row.token_hash).toBe(sha256(token));
      expect(row.json).not.toContain(token);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM role_changes c
            WHERE strpos(row_to_json(c)::text, $1) > 0 OR strpos(row_to_json(c)::text, $2) > 0`,
          [token, sha256(token)]
        )
      ).toBe(0);

      expect(await invites.listPendingInvites(orgA.id)).toContainEqual(invite);
      expect(await logAfter(mark)).toEqual([
        {
          org_id: orgA.id,
          role: "editor",
          kind: "invite",
          subject: email,
          detail: null,
          actor: ada.email,
        },
      ]);
    }, SLOW);

    test("a second invitation to the same address replaces the first", async () => {
      const email = freshEmail("twice");
      const first = await emailInvite(orgA, email, "viewer");
      const second = await emailInvite(orgA, email, "editor");
      const someone = await person(freshEmail("someone"));

      await expect(invites.inspectInvite(first.token, someone.id)).resolves.toEqual({
        kind: "revoked",
      });
      const waiting = (await invites.listPendingInvites(orgA.id)).filter(
        (invite) => invite.email === email
      );
      expect(waiting).toEqual([second.invite]);
    }, SLOW);

    test("is refused for someone in the organization already, under their profile's address", async () => {
      // Stored with capitals, as a profile made before addresses were
      // lowercased could be. The invitation's address is always lower case.
      const member = await person(`Mixed.Case.${randomUUID()}@Example.test`, {
        memberOf: [{ org: orgA, role: "viewer" }],
      });
      const mark = await logMark();
      const before = await count(`SELECT count(*)::int AS n FROM invites`);

      await expect(
        invites.createEmailInvite(orgA.id, {
          email: member.email.toLowerCase(),
          role: "editor",
          invitedBy: ada.id,
          actor: ada.email,
        })
      ).resolves.toEqual({ kind: "member" });
      expect(await count(`SELECT count(*)::int AS n FROM invites`)).toBe(before);
      expect(await logAfter(mark)).toEqual([]);

      // Belonging to A says nothing about B.
      await expect(emailInvite(orgB, member.email.toLowerCase())).resolves.toMatchObject({
        kind: "made",
      });
    }, SLOW);

    test("is refused for a member under an address a provider vouched for, but not one it did not", async () => {
      const vouched = freshEmail("work");
      const unvouched = freshEmail("unchecked");
      await person(freshEmail("member"), {
        signIns: [
          { email: vouched, verified: true },
          { email: unvouched, verified: false },
        ],
        memberOf: [{ org: orgA, role: "viewer" }],
      });

      await expect(
        invites.createEmailInvite(orgA.id, {
          email: vouched,
          role: "editor",
          invitedBy: ada.id,
          actor: ada.email,
        })
      ).resolves.toEqual({ kind: "member" });
      // Anyone can put an address on an account without proving it, so an
      // unproven one is no sign that its owner is in already.
      await expect(emailInvite(orgA, unvouched)).resolves.toMatchObject({ kind: "made" });
    }, SLOW);

    test("is refused for a role this organization does not have, even one another organization has", async () => {
      await db.query(
        `INSERT INTO roles (org_id, name, label) VALUES ($1, 'b-only', 'Only in B')`,
        [orgB.id]
      );
      const mark = await logMark();
      for (const role of ["no-such-role", "b-only"]) {
        await expect(
          invites.createEmailInvite(orgA.id, {
            email: freshEmail("norole"),
            role,
            invitedBy: ada.id,
            actor: ada.email,
          })
        ).resolves.toEqual({ kind: "no-role" });
      }
      expect(await logAfter(mark)).toEqual([]);
    }, SLOW);

    test("when two Admins invite the same address at once, the second hears it was just invited", async () => {
      const email = freshEmail("race");
      const holder = await connectTo(url);
      let mark = 0;
      try {
        await holder.query("BEGIN");
        // The other Admin's invitation: written, not yet committed. The
        // store's own cancel of earlier invitations cannot see it, so only
        // the unique index stands between the two.
        await holder.query(
          `INSERT INTO invites (org_id, token_hash, kind, email, role, expires_at)
           VALUES ($1, $2, 'email', $3, 'viewer', now() + interval '7 days')`,
          [orgA.id, sha256(unknownToken()), email]
        );
        mark = await logMark();
        const second = invites.createEmailInvite(orgA.id, {
          email,
          role: "editor",
          invitedBy: ada.id,
          actor: ada.email,
        });
        await waitForLock();
        await holder.query("COMMIT");
        await expect(second).resolves.toEqual({ kind: "just-invited" });
      } finally {
        await holder.end();
      }

      expect(
        await rows(`SELECT role FROM invites WHERE email = $1 AND revoked_at IS NULL`, [email])
      ).toEqual([{ role: "viewer" }]);
      expect(await logAfter(mark)).toEqual([]);
    }, SLOW);

    test("the database itself refuses an address that is not in lower case, or a link with one", async () => {
      const insert = (kind: string, email: string | null) =>
        db.query(
          `INSERT INTO invites (org_id, token_hash, kind, email, role, expires_at)
           VALUES ($1, $2, $3, $4, 'viewer', now() + interval '1 day')`,
          [orgA.id, sha256(unknownToken()), kind, email]
        );
      await expect(insert("email", "Someone@Example.test")).rejects.toMatchObject({
        code: "23514",
        constraint: "invites_email_check",
      });
      await expect(insert("email", null)).rejects.toMatchObject({
        constraint: "invites_email_check",
      });
      await expect(insert("link", "someone@example.test")).rejects.toMatchObject({
        constraint: "invites_email_check",
      });
    }, SLOW);
  });

  describe("an invitation link", () => {
    test("offers Viewer for the days asked, logs them, and can run beside others", async () => {
      const mark = await logMark();
      const month = await linkInvite(orgA, 30);
      const day = await linkInvite(orgA, 1);

      expect(month.invite).toMatchObject({ kind: "link", email: null, role: "viewer" });
      expect(Date.parse(month.invite.expiresAt) - Date.parse(month.invite.createdAt)).toBe(
        30 * DAY_MS
      );
      expect(Date.parse(day.invite.expiresAt) - Date.parse(day.invite.createdAt)).toBe(DAY_MS);
      expect(await pendingIds(orgA)).toEqual(
        expect.arrayContaining([month.invite.id, day.invite.id])
      );
      const [row] = await rows<{ token_hash: string }>(
        `SELECT token_hash FROM invites WHERE id = $1`,
        [month.invite.id]
      );
      expect(row.token_hash).toBe(sha256(month.token));
      expect(await logAfter(mark)).toEqual(
        ["30", "1"].map((detail) => ({
          org_id: orgA.id,
          role: "viewer",
          kind: "invite",
          subject: null,
          detail,
          actor: ada.email,
        }))
      );
    }, SLOW);

    test("the database itself refuses a link for more than a Viewer", async () => {
      await expect(
        db.query(
          `INSERT INTO invites (org_id, token_hash, kind, email, role, expires_at)
           VALUES ($1, $2, 'link', NULL, 'editor', now() + interval '1 day')`,
          [orgA.id, sha256(unknownToken())]
        )
      ).rejects.toMatchObject({ code: "23514", constraint: "invites_link_role_check" });
    }, SLOW);
  });

  describe("cancelling", () => {
    test("cancels a waiting invitation, logs who it was for, and only once", async () => {
      const email = freshEmail("cancel");
      const { token, invite } = await emailInvite(orgA, email, "editor");
      const link = await linkInvite(orgA, 7);
      const mark = await logMark();

      await expect(invites.cancelInvite(orgA.id, invite.id, ada.email)).resolves.toEqual({
        kind: "cancelled",
      });
      await expect(invites.cancelInvite(orgA.id, link.invite.id, ada.email)).resolves.toEqual({
        kind: "cancelled",
      });
      await expect(invites.cancelInvite(orgA.id, invite.id, ada.email)).resolves.toEqual({
        kind: "not-found",
      });

      const owner = await ownerOf(email);
      await expect(invites.inspectInvite(token, owner.id)).resolves.toEqual({ kind: "revoked" });
      await expect(invites.inspectInvite(link.token, owner.id)).resolves.toEqual({
        kind: "revoked",
      });
      const waiting = await pendingIds(orgA);
      expect(waiting).not.toContain(invite.id);
      expect(waiting).not.toContain(link.invite.id);
      expect(await logAfter(mark)).toEqual([
        {
          org_id: orgA.id,
          role: "editor",
          kind: "cancel-invite",
          subject: email,
          detail: null,
          actor: ada.email,
        },
        {
          org_id: orgA.id,
          role: "viewer",
          kind: "cancel-invite",
          subject: null,
          detail: null,
          actor: ada.email,
        },
      ]);
    }, SLOW);

    test("another organization's invitation is not found from this one, and stays as it was", async () => {
      const { token, invite } = await emailInvite(orgB, freshEmail("theirs"));
      const mark = await logMark();

      await expect(invites.cancelInvite(orgA.id, invite.id, ada.email)).resolves.toEqual({
        kind: "not-found",
      });
      expect(await pendingIds(orgA)).not.toContain(invite.id);
      expect(await pendingIds(orgB)).toContain(invite.id);
      expect(await logAfter(mark)).toEqual([]);
      const someone = await person(freshEmail("someone"));
      await expect(invites.inspectInvite(token, someone.id)).resolves.toMatchObject({
        kind: "wrong-account",
      });
    }, SLOW);

    test("a used invitation cannot be cancelled", async () => {
      const email = freshEmail("taken");
      const { token, invite } = await emailInvite(orgA, email);
      await expect(invites.acceptInvite(token, (await ownerOf(email)).id)).resolves.toMatchObject({
        kind: "joined",
      });
      await expect(invites.cancelInvite(orgA.id, invite.id, ada.email)).resolves.toEqual({
        kind: "not-found",
      });
      expect(
        await rows(`SELECT revoked_at FROM invites WHERE id = $1`, [invite.id])
      ).toEqual([{ revoked_at: null }]);
    }, SLOW);
  });

  describe("what an invitation is to whoever opens it", () => {
    test("one that does not exist, or whose role was deleted since, is invalid", async () => {
      const someone = await person(freshEmail("someone"));
      await expect(invites.inspectInvite("not-a-token", someone.id)).resolves.toEqual({
        kind: "invalid",
      });
      await expect(invites.inspectInvite(unknownToken(), someone.id)).resolves.toEqual({
        kind: "invalid",
      });

      await db.query(
        `INSERT INTO roles (org_id, name, label) VALUES ($1, 'qa-lead', 'QA lead')`,
        [orgA.id]
      );
      const email = freshEmail("qa");
      const { token, invite } = await emailInvite(orgA, email, "qa-lead");
      expect(invite.roleLabel).toBe("QA lead");
      await db.query(`DELETE FROM roles WHERE org_id = $1 AND name = 'qa-lead'`, [orgA.id]);
      await expect(invites.inspectInvite(token, (await ownerOf(email)).id)).resolves.toEqual({
        kind: "invalid",
      });
    }, SLOW);

    test("a profile that is gone hears so, once the token at least has the right shape", async () => {
      const { token } = await linkInvite(orgA);
      const gone = await person(freshEmail("gone"));
      await db.query(`DELETE FROM profiles WHERE id = $1`, [gone.id]);

      await expect(invites.inspectInvite(token, gone.id)).resolves.toEqual({
        kind: "no-profile",
      });
      await expect(invites.inspectInvite("not-a-token", gone.id)).resolves.toEqual({
        kind: "invalid",
      });
    }, SLOW);

    test("one to an address waits for a sign-in whose provider vouched for that address", async () => {
      const email = freshEmail("invitee");
      const { token } = await emailInvite(orgA, email, "editor");
      const organization = { slug: orgA.slug, name: orgA.name };
      const wrong = {
        kind: "wrong-account",
        organization,
        maskedEmail: "i•••@example.test",
      };

      // A profile made under the address proves nothing on its own: no
      // provider is saying the address is theirs today.
      const byProfile = await person(email.toUpperCase());
      await expect(invites.inspectInvite(token, byProfile.id)).resolves.toEqual(wrong);
      const unverified = await person(freshEmail("unverified"), {
        signIns: [{ email, verified: false }],
      });
      await expect(invites.inspectInvite(token, unverified.id)).resolves.toEqual(wrong);

      // The vouched address may come back in capitals; it is the same address.
      const vouched = await person(freshEmail("vouched"), {
        signIns: [{ email: email.toUpperCase(), verified: true }],
      });
      await expect(invites.inspectInvite(token, vouched.id)).resolves.toEqual({
        kind: "ok",
        organization,
        role: "editor",
        roleLabel: "Editor",
        invite: "email",
      });
    }, SLOW);

    test("a link is for whoever has it, as a Viewer", async () => {
      const { token } = await linkInvite(orgA);
      const anyone = await person(freshEmail("anyone"));
      await expect(invites.inspectInvite(token, anyone.id)).resolves.toEqual({
        kind: "ok",
        organization: { slug: orgA.slug, name: orgA.name },
        role: "viewer",
        roleLabel: "Viewer",
        invite: "link",
      });
    }, SLOW);

    test("says the first of member, cancelled, run out and used that holds, and only then which account", async () => {
      const organization = { slug: orgA.slug, name: orgA.name };
      const member = await person(freshEmail("inside"), {
        memberOf: [{ org: orgA, role: "viewer" }],
      });
      const outsider = await person(freshEmail("outside"));

      // Cancelled and run out.
      const cancelled = await emailInvite(orgA, freshEmail("a"));
      await invites.cancelInvite(orgA.id, cancelled.invite.id, ada.email);
      await expire(cancelled.invite.id);
      // Used, then run out.
      const usedEmail = freshEmail("b");
      const usedThenExpired = await emailInvite(orgA, usedEmail);
      await invites.acceptInvite(usedThenExpired.token, (await ownerOf(usedEmail)).id);
      await expire(usedThenExpired.invite.id);
      // Used.
      const takenEmail = freshEmail("c");
      const used = await emailInvite(orgA, takenEmail);
      await invites.acceptInvite(used.token, (await ownerOf(takenEmail)).id);
      // For another address, and run out.
      const expired = await emailInvite(orgA, freshEmail("d"));
      await expire(expired.invite.id);

      for (const { token } of [cancelled, usedThenExpired, used, expired]) {
        await expect(invites.inspectInvite(token, member.id)).resolves.toEqual({
          kind: "member",
          organization,
        });
      }
      await expect(invites.inspectInvite(cancelled.token, outsider.id)).resolves.toEqual({
        kind: "revoked",
      });
      await expect(invites.inspectInvite(usedThenExpired.token, outsider.id)).resolves.toEqual({
        kind: "expired",
      });
      await expect(invites.inspectInvite(used.token, outsider.id)).resolves.toEqual({
        kind: "used",
      });
      // Nobody can take it, so there is no account worth switching to.
      await expect(invites.inspectInvite(expired.token, outsider.id)).resolves.toEqual({
        kind: "expired",
      });

      const waiting = await pendingIds(orgA);
      for (const { invite } of [cancelled, usedThenExpired, used, expired]) {
        expect(waiting).not.toContain(invite.id);
      }
    }, SLOW);
  });

  describe("taking an invitation", () => {
    test("joins with its role, uses it up, opens there next time, and logs the join", async () => {
      const email = freshEmail("joiner");
      const { token, invite } = await emailInvite(orgA, email, "editor");
      const joiner = await ownerOf(email);
      const organization = { slug: orgA.slug, name: orgA.name };
      const mark = await logMark();

      await expect(invites.acceptInvite(token, joiner.id)).resolves.toEqual({
        kind: "joined",
        organization,
      });
      expect(
        await rows(`SELECT org_id, role FROM memberships WHERE profile_id = $1`, [joiner.id])
      ).toEqual([{ org_id: orgA.id, role: "editor" }]);
      expect(
        await rows(
          `SELECT used_by, used_at IS NOT NULL AS used, revoked_at FROM invites WHERE id = $1`,
          [invite.id]
        )
      ).toEqual([{ used_by: joiner.id, used: true, revoked_at: null }]);
      expect(
        await rows(`SELECT last_org_id FROM profiles WHERE id = $1`, [joiner.id])
      ).toEqual([{ last_org_id: orgA.id }]);
      // The joiner is the actor: it was their doing, not the Admin's.
      expect(await logAfter(mark)).toEqual([
        {
          org_id: orgA.id,
          role: "editor",
          kind: "join",
          subject: joiner.email,
          detail: "email",
          actor: joiner.email,
        },
      ]);

      // Taken: off the list, the link says so to anyone else, and trying again
      // only says the joiner is in.
      expect(await pendingIds(orgA)).not.toContain(invite.id);
      const someone = await person(freshEmail("someone"));
      await expect(invites.inspectInvite(token, someone.id)).resolves.toEqual({ kind: "used" });
      const again = await logMark();
      await expect(invites.acceptInvite(token, joiner.id)).resolves.toEqual({
        kind: "member",
        organization,
      });
      expect(await logAfter(again)).toEqual([]);
    }, SLOW);

    test("a link stays open: everyone who has it can join, as a Viewer", async () => {
      const { token, invite } = await linkInvite(orgB, 7);
      const first = await person(freshEmail("first"));
      const second = await person(freshEmail("second"));
      const mark = await logMark();

      for (const joiner of [first, second]) {
        await expect(invites.acceptInvite(token, joiner.id)).resolves.toEqual({
          kind: "joined",
          organization: { slug: orgB.slug, name: orgB.name },
        });
      }
      expect(
        await rows(
          `SELECT profile_id, role FROM memberships WHERE org_id = $1 AND profile_id = ANY($2)
            ORDER BY profile_id`,
          [orgB.id, [first.id, second.id]]
        )
      ).toEqual([
        { profile_id: first.id, role: "viewer" },
        { profile_id: second.id, role: "viewer" },
      ]);
      expect(
        await rows(`SELECT used_at, used_by FROM invites WHERE id = $1`, [invite.id])
      ).toEqual([{ used_at: null, used_by: null }]);
      expect(await pendingIds(orgB)).toContain(invite.id);
      expect((await logAfter(mark)).map((row) => [row.kind, row.detail, row.actor])).toEqual([
        ["join", "link", first.email],
        ["join", "link", second.email],
      ]);
    }, SLOW);

    test("being in another organization does not count as being in this one", async () => {
      const { token } = await linkInvite(orgB, 1);
      const elsewhere = await person(freshEmail("elsewhere"), {
        memberOf: [{ org: orgA, role: "editor" }],
      });
      const organization = { slug: orgB.slug, name: orgB.name };

      await expect(invites.inspectInvite(token, elsewhere.id)).resolves.toEqual({
        kind: "ok",
        organization,
        role: "viewer",
        roleLabel: "Viewer",
        invite: "link",
      });
      await expect(invites.acceptInvite(token, elsewhere.id)).resolves.toEqual({
        kind: "joined",
        organization,
      });
      expect(
        await rows(`SELECT org_id, role FROM memberships WHERE profile_id = $1 ORDER BY org_id`, [
          elsewhere.id,
        ])
      ).toEqual([
        { org_id: orgA.id, role: "editor" },
        { org_id: orgB.id, role: "viewer" },
      ]);
    }, SLOW);

    test("every refusal writes nothing", async () => {
      const email = freshEmail("refused");
      const forSomeoneElse = await emailInvite(orgA, freshEmail("else"));
      const cancelled = await emailInvite(orgA, freshEmail("cancelled"));
      await invites.cancelInvite(orgA.id, cancelled.invite.id, ada.email);
      const expired = await linkInvite(orgA);
      await expire(expired.invite.id);
      const usedEmail = freshEmail("used");
      const used = await emailInvite(orgA, usedEmail);
      await invites.acceptInvite(used.token, (await ownerOf(usedEmail)).id);
      const live = await emailInvite(orgA, email);
      const member = await person(freshEmail("member"), {
        memberOf: [{ org: orgA, role: "viewer" }],
      });
      const outsider = await person(freshEmail("outsider"));
      const gone = await person(freshEmail("gone"));
      await db.query(`DELETE FROM profiles WHERE id = $1`, [gone.id]);

      const cases: [string, string, number, string][] = [
        ["a token of the wrong shape", "not-a-token", outsider.id, "invalid"],
        ["a token nobody made", unknownToken(), outsider.id, "invalid"],
        ["a profile that is gone", live.token, gone.id, "no-profile"],
        ["someone in it already", live.token, member.id, "member"],
        ["an invitation for another address", forSomeoneElse.token, outsider.id, "wrong-account"],
        ["a cancelled invitation", cancelled.token, outsider.id, "revoked"],
        ["a link that ran out", expired.token, outsider.id, "expired"],
        ["a used invitation", used.token, outsider.id, "used"],
      ];
      const snapshot = () =>
        rows(
          `SELECT (SELECT count(*) FROM memberships)::int AS memberships,
                  (SELECT count(*) FROM role_changes)::int AS log,
                  (SELECT count(*) FROM invites WHERE used_at IS NOT NULL)::int AS used,
                  (SELECT count(*) FROM profiles WHERE last_org_id IS NOT NULL)::int AS opened`
        );
      const before = await snapshot();
      for (const [what, token, profileId, kind] of cases) {
        const answer = await invites.acceptInvite(token, profileId);
        expect({ what, kind: answer.kind }).toEqual({ what, kind });
      }
      expect(await snapshot()).toEqual(before);
    }, SLOW);

    test("two clicks at once join once", async () => {
      const email = freshEmail("double");
      const { token } = await emailInvite(orgA, email);
      const joiner = await ownerOf(email);
      const mark = await logMark();

      const answers = await Promise.all([
        invites.acceptInvite(token, joiner.id),
        invites.acceptInvite(token, joiner.id),
      ]);
      expect(answers.map((answer) => answer.kind).sort()).toEqual(["joined", "member"]);
      expect(
        await count(`SELECT count(*)::int AS n FROM memberships WHERE profile_id = $1`, [
          joiner.id,
        ])
      ).toBe(1);
      expect((await logAfter(mark)).map((row) => row.kind)).toEqual(["join"]);
    }, SLOW);

    test("a cancel that commits while someone is joining wins, and they are told it was cancelled", async () => {
      const email = freshEmail("slow");
      const { token, invite } = await emailInvite(orgA, email);
      const joiner = await ownerOf(email);
      const holder = await connectTo(url);
      try {
        await holder.query("BEGIN");
        // An Admin's cancel, half done: the row is changed and locked, not
        // yet committed. Joining has to wait for it and then read the row
        // as it ended up, not as it was when joining began.
        await holder.query(`UPDATE invites SET revoked_at = now() WHERE id = $1`, [invite.id]);
        const joining = invites.acceptInvite(token, joiner.id);
        await waitForLock();
        await holder.query("COMMIT");
        await expect(joining).resolves.toEqual({ kind: "revoked" });
      } finally {
        await holder.end();
      }
      expect(
        await count(`SELECT count(*)::int AS n FROM memberships WHERE profile_id = $1`, [
          joiner.id,
        ])
      ).toBe(0);
    }, SLOW);
  });
});
