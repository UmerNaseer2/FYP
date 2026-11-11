/**
 * @jest-environment node
 */
// An approval stops counting once its saved connection is edited.
//
// An approval names a connection by id only. Before this, someone could get
// SQL approved for a production connection, point that connection at another
// database, and run the approved SQL there. See CONNECTION_NOT_EDITED_SINCE in
// lib/approvals-db.ts.
//
// This runs against a real PostgreSQL, because the rule is one SQL condition
// and a fake pool cannot say whether it is right. It is skipped unless
// TEST_DATABASE_URL is set:
//
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/schema_studio_test \
//     REQUIRE_TEST_DATABASE=1 npx jest tests/approvals-connection-edit-db.test.ts

import { Client } from "pg";
import type { ApprovalScript } from "@/lib/approval-fingerprint";
import { testDatabaseUrl } from "./helpers/test-database";

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

describeWithDatabase("an approval and a connection edited after it", () => {
  const savedUrl = process.env.DATABASE_URL_A;
  const savedDesktop = process.env.SCHEMA_STUDIO_DESKTOP;
  let server: Client;
  let db: Client;
  let databaseName = "";
  let sequelize: typeof import("@/lib/db/sequelize").sequelize;
  let approvals: typeof import("@/lib/approvals-db");

  let orgId = 0;
  let connectionId = 0;

  const scripts: ApprovalScript[] = [
    {
      scriptName: "V3__add_authors.sql",
      version: "3.0.0",
      sqlContent: "CREATE TABLE authors (id int);",
    },
  ];

  // What the Deploy screen sends when it asks for approval.
  const request = () => ({
    orgId,
    connectionId,
    schemaName: "public",
    scriptName: "V3__add_authors.sql",
    targetVersion: "3.0.0",
    scripts,
    breakingCount: 0,
    requestedBy: "editor@test",
    note: null,
    action: "deploy" as const,
  });

  // What the apply route asks before a production run.
  const run = () => ({
    orgId,
    connectionId,
    schemaName: "public",
    scripts,
    action: "deploy" as const,
  });

  const approve = (id: number) =>
    approvals.decideApproval({
      orgId,
      id,
      approve: true,
      decidedBy: "admin@test",
      selfApproved: false,
      note: null,
    });

  // What saving an edit in Connections does to the row (lib/connection-writes).
  const editConnection = () =>
    db.query(`UPDATE connections SET host = 'other.example.test', updated_at = now() WHERE id = $1`, [
      connectionId,
    ]);

  beforeAll(async () => {
    const baseName = decodeURIComponent(new URL(testUrl).pathname.slice(1));
    if (!/test/i.test(baseName)) {
      throw new Error(
        `TEST_DATABASE_URL names "${baseName}". These tests create and drop databases, ` +
          `so they only run against one whose name contains "test".`
      );
    }
    server = await connectTo(testUrl);
    databaseName = `${baseName}_approvals`;
    await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
    const url = urlFor(databaseName);

    jest.resetModules();
    globalThis.__metadataSequelize = undefined;
    process.env.DATABASE_URL_A = url;
    delete process.env.SCHEMA_STUDIO_DESKTOP;
    const { syncMetadataTables } = await import("@/lib/db/bootstrap");
    await syncMetadataTables();
    ({ sequelize } = await import("@/lib/db/sequelize"));
    approvals = await import("@/lib/approvals-db");

    db = await connectTo(url);
    const org = await db.query(`SELECT id FROM organizations WHERE is_default`);
    orgId = org.rows[0].id;
    const connection = await db.query(
      `INSERT INTO connections (org_id, name, host, username, password)
       VALUES ($1, 'Bookshop', 'db.example.test', 'reader', 'not-a-real-password')
       RETURNING id`,
      [orgId]
    );
    connectionId = connection.rows[0].id;
  }, SETUP);

  afterAll(async () => {
    if (sequelize) await sequelize.close();
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

  test(
    "an approval given before the connection was edited cannot be spent",
    async () => {
      const first = await approvals.createApprovalRequest(request());
      const firstId = first?.id as number;
      expect((await approve(firstId))?.status).toBe("approved");

      // Untouched connection: the approval is there and ready.
      expect(await approvals.findOpenApproval(run())).toBe("approved");
      expect(await approvals.countRunsReadyToRun(orgId)).toBe(1);

      await editConnection();

      // The approval was for the connection as it was. It no longer counts,
      // on any screen, and the run cannot spend it.
      expect(await approvals.findOpenApproval(run())).toBeNull();
      expect(await approvals.countRunsReadyToRun(orgId)).toBe(0);
      expect(await approvals.listRunsReadyToRun(orgId)).toEqual([]);
      expect(await approvals.claimApproval(run())).toBeNull();

      // Asking again makes a new request, not the dead one handed back.
      const second = await approvals.createApprovalRequest(request());
      const secondId = second?.id as number;
      expect(secondId).not.toBe(firstId);
      expect(second?.status).toBe("pending");

      // Approved after the edit, so the approver saw the new target: it works.
      expect((await approve(secondId))?.status).toBe("approved");
      expect((await approvals.claimApproval(run()))?.id).toBe(secondId);
    },
    SLOW
  );

  test(
    "a request still waiting is not thrown away by an edit",
    async () => {
      const other = { ...request(), schemaName: "sales" };
      const waiting = await approvals.createApprovalRequest(other);
      await editConnection();

      // Still the same open request, and the approver can still decide it.
      expect((await approvals.createApprovalRequest(other))?.id).toBe(waiting?.id);
      expect(await approvals.findOpenApproval({ ...run(), schemaName: "sales" })).toBe("pending");
    },
    SLOW
  );
});
