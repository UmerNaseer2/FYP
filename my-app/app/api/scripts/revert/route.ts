import { NextRequest, NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { getPoolForConfig } from "@/lib/postgres";
import { buildPgConfig } from "@/lib/connection-config";
import { containsTransactionControl } from "@/lib/sql-guard";
import { compareVersions } from "@/lib/script-status";
import { findTrackedSchema, recordAppliedMigrationToLineage } from "@/lib/lineage-db";
import {
  louderEnvironment,
  productionBlockReason,
  toEnvironment,
} from "@/lib/environments";
import type { ChangeLevel } from "@/lib/version-detection";

// ---------------------------------------------------------------------------
// POST /api/scripts/revert — undo ONE applied migration.
//
// The mirror image of /api/scripts/apply. It takes the rollback ("down") SQL
// that was generated alongside the migration and stored beside it in the
// registry as v<version>.down.sql, runs it inside one transaction, and removes
// that version's row from the target's script_patch ledger so the version goes
// back to "pending" and can be deployed again.
//
// Two rules keep this from corrupting a target's history:
//   1. You can only revert a version this database actually applied.
//   2. You can only revert the NEWEST applied version of its script family.
//      Reverting v1.0.0 while v2.0.0 is still applied would run v1.0.0's undo
//      against structure that v2.0.0 has since changed.
//
// What it does NOT do: bring data back. A rollback restores structure. Rows
// that a DROP removed are gone, and the UI says so before you press the button.
// ---------------------------------------------------------------------------

// Safely quote a PostgreSQL identifier (schema name, table name).
// Same helper as the apply route — wraps in double-quotes, escapes internal ones.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// script_patch.change_type is a constrained VARCHAR; these are its legal values,
// which are also exactly the ChangeLevel union the lineage helper accepts.
const VALID_CHANGE_TYPES: ChangeLevel[] = ["breaking", "additive", "patch", "unknown"];

function asChangeLevel(value: string | null): ChangeLevel {
  return VALID_CHANGE_TYPES.includes(value as ChangeLevel)
    ? (value as ChangeLevel)
    : "unknown";
}

export async function POST(request: NextRequest) {
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  // ─── 1. Parse the request body ───────────────────────────────────────────
  let body: {
    connectionId: number;
    script_name: string;
    version: string;
    /**
     * The rollback SQL to run — v<version>.down.sql from the registry. Optional:
     * a version that reached this database without a registry file (a Version
     * Sync replay) stored its rollback in script_patch.down_sql instead, and
     * that row is used when this is absent.
     */
    sql_content?: string;
    schemaName?: string;
    /**
     * Set by a screen only after somebody has ticked the production warning.
     * Absent or false against a production target is a refusal, not a default.
     */
    acknowledgeProduction?: boolean;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in request body." },
      { status: 400 }
    );
  }

  const { connectionId, script_name, version, sql_content } = body;

  const schemaName =
    typeof body.schemaName === "string" && body.schemaName.trim().length > 0
      ? body.schemaName.trim()
      : "public";

  // ─── 2. Validate required fields ─────────────────────────────────────────
  if (!connectionId) {
    return NextResponse.json({ error: "connectionId is required." }, { status: 400 });
  }

  if (!script_name?.trim()) {
    return NextResponse.json({ error: "script_name is required." }, { status: 400 });
  }

  if (!version?.trim()) {
    return NextResponse.json(
      { error: "version is required (the applied version to undo, e.g. '1.2.0')." },
      { status: 400 }
    );
  }

  // sql_content is deliberately NOT required here — see step 8b, which falls
  // back to the rollback the apply route stored on the ledger row itself.

  // ─── 3. Guard against embedded COMMIT / ROLLBACK in the down script ──────
  // Same rule as apply: this route owns the transaction, so a bare COMMIT
  // inside the script would end it early and leave the ledger DELETE outside
  // the rollback boundary. The stored fallback is checked the same way once it
  // is read, since an old row could predate this guard.
  if (sql_content?.trim() && containsTransactionControl(sql_content)) {
    return NextResponse.json(
      {
        error:
          "sql_content must not contain COMMIT or ROLLBACK statements. " +
          "The revert route wraps the rollback in its own transaction automatically.",
      },
      { status: 400 }
    );
  }

  const name = script_name.trim();
  const ver = version.trim();

  // ─── 4. Look up the saved connection from the app metadata database ──────
  let connRow: {
    host: string;
    port: number;
    database_name: string;
    username: string;
    password: string;
    connection_string: string | null;
    ssl: boolean | null;
    ssl_mode: string | null;
    environment: string | null;
  };

  try {
    // The ssl_mode column is added lazily; make sure it exists before selecting it.
    await syncMetadataTables();
    const result = await pool.query(
      `SELECT host, port, database_name, username, password, connection_string, ssl, ssl_mode, environment
       FROM connections
       WHERE id = $1`,
      [connectionId]
    );

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: `No saved connection found with id ${connectionId}.` },
        { status: 404 }
      );
    }

    connRow = result.rows[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Revert — failed to fetch connection record:", message);
    return NextResponse.json(
      { error: "Could not read saved connection. Is the app database reachable?" },
      { status: 500 }
    );
  }

  // ─── 4b. Refuse an unconfirmed run against production ─────────────────────
  //
  // Same rule and same reasoning as the apply route — see productionBlockReason.
  // A rollback is not the gentler of the two: it drops what the migration added,
  // so on a live database it is the one that loses rows.
  let schemaEnvironment = toEnvironment(null);
  try {
    const tracked = await findTrackedSchema(connectionId, schemaName);
    if (tracked) schemaEnvironment = tracked.environment;
  } catch (error) {
    console.error("Revert — could not read the tracked schema's environment:", error);
  }
  const targetEnvironment = louderEnvironment(
    toEnvironment(connRow.environment),
    schemaEnvironment
  );
  const blocked = productionBlockReason(
    targetEnvironment,
    body.acknowledgeProduction === true
  );
  if (blocked) {
    return NextResponse.json({ error: blocked, environment: targetEnvironment }, { status: 409 });
  }

  // ─── 5. Build the target DB config (SSL/URI-aware via buildPgConfig) ─────
  const targetConfig = buildPgConfig({
    host: connRow.host,
    port: connRow.port,
    database: connRow.database_name,
    user: connRow.username,
    password: connRow.password,
    connectionString: connRow.connection_string,
    ssl: Boolean(connRow.ssl),
    sslMode: connRow.ssl_mode,
  });
  const targetPool = getPoolForConfig(targetConfig);

  // ─── 6. Connect to the target database ───────────────────────────────────
  let client;
  try {
    client = await targetPool.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Revert — could not connect to target DB:", message);
    return NextResponse.json(
      {
        error:
          `Could not connect to target database ` +
          `(${connRow.host}:${connRow.port}/${connRow.database_name}). ` +
          `Check that the database is running and the credentials are correct. ` +
          `Details: ${message}`,
      },
      { status: 503 }
    );
  }

  const quotedSchema = quoteIdent(schemaName);

  let transactionStarted = false;
  let clientReleased = false;
  // Filled in from the ledger row before it is deleted, then used for the
  // best-effort lineage advance after COMMIT.
  let revertedChangeLevel: ChangeLevel = "unknown";

  try {
    // ─── 7. Run the rollback inside a transaction ─────────────────────────
    await client.query("BEGIN");
    transactionStarted = true;

    // Same lock key as the apply route, so a revert and a re-apply of the same
    // (schema, script, version) can never interleave. Released at COMMIT.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [schemaName, `${name}|${ver}`]
    );

    // Scope unqualified names in the rollback SQL to the target schema ONLY —
    // `public` is deliberately off the path for the same reason as apply: an
    // unqualified DROP of a relation missing from the target must no-op, not
    // fall through and hit public's same-named table.
    await client.query(`SET LOCAL search_path TO ${quotedSchema}`);

    // 8a. Is there a ledger at all? A schema with no script_patch has had
    //     nothing applied by this tool, so there is nothing to undo.
    const tableCheck = await client.query<{ reg: string | null }>(
      `SELECT to_regclass($1) AS reg`,
      [`${quotedSchema}.script_patch`]
    );
    if (!tableCheck.rows[0]?.reg) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return NextResponse.json(
        {
          error:
            `Schema "${schemaName}" has no script_patch ledger, so no migration ` +
            `has been applied there. Nothing to revert.`,
        },
        { status: 409 }
      );
    }

    // 8b. Was THIS version applied here?
    //     down_sql is read alongside so a version with no registry file still
    //     has something to run — see downSql below. The column is added lazily
    //     by the apply route, so ask the catalog before selecting it.
    const colCheck = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'script_patch'
          AND column_name = 'down_sql'`,
      [schemaName]
    );
    const downExpr =
      colCheck.rows.length > 0 ? "down_sql" : "NULL::text AS down_sql";

    const target = await client.query<{
      id: number;
      title: string | null;
      change_type: string | null;
      applied_at: string | null;
      down_sql: string | null;
    }>(
      `SELECT id, title, change_type, applied_at, ${downExpr}
       FROM ${quotedSchema}.script_patch
       WHERE script_name = $1 AND version = $2
       LIMIT 1`,
      [name, ver]
    );

    if (target.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return NextResponse.json(
        {
          error:
            `Version ${ver} of "${name}" is not applied to schema "${schemaName}", ` +
            `so there is nothing to revert.`,
        },
        { status: 409 }
      );
    }

    const row = target.rows[0];
    revertedChangeLevel = asChangeLevel(row.change_type);

    // The rollback to run: the registry file the caller sent, else the one the
    // apply route recorded on this row. Version Sync replays a version onto a
    // second schema without writing any file for it, so the stored copy is the
    // only rollback such a version will ever have.
    const downSql = sql_content?.trim() ? sql_content : (row.down_sql ?? "");

    if (!downSql.trim()) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return NextResponse.json(
        {
          error:
            `v${ver} of "${name}" has no rollback script. It can be reverted ` +
            `only if it was pushed with a v${ver}.down.sql, or applied with a ` +
            `rollback recorded alongside it.`,
        },
        { status: 409 }
      );
    }

    // A row written before this guard existed could still hold a COMMIT.
    if (containsTransactionControl(downSql)) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return NextResponse.json(
        {
          error:
            `The stored rollback for v${ver} of "${name}" contains a COMMIT or ` +
            `ROLLBACK statement, so it cannot be run inside this route's ` +
            `transaction. Run it by hand, or push a corrected v${ver}.down.sql.`,
        },
        { status: 409 }
      );
    }

    // 8c. Is it the newest applied version of its family?
    //     Rolling back out of order would run this version's undo against
    //     structure a later migration has since changed. Refuse, and name the
    //     versions that have to come off first so the message is actionable.
    const family = await client.query<{ version: string }>(
      `SELECT version FROM ${quotedSchema}.script_patch WHERE script_name = $1`,
      [name]
    );
    const newer = family.rows
      .map((r) => r.version)
      .filter((v) => compareVersions(v, ver) > 0)
      .sort(compareVersions);

    if (newer.length > 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      const list = newer.map((v) => `v${v}`).join(", ");
      return NextResponse.json(
        {
          error:
            `v${ver} is not the newest applied version of "${name}" in schema ` +
            `"${schemaName}". Revert ${list} first, newest to oldest, then come ` +
            `back to v${ver}.`,
        },
        { status: 409 }
      );
    }

    // ─── All preconditions passed — now run the rollback SQL ──────────────
    await client.query(downSql);

    // Copy the row to the audit table, then remove it from the live ledger.
    //
    // The DELETE is what makes the version deployable again — the apply route's
    // duplicate check and its UNIQUE (script_name, version) index would both
    // reject a re-deploy if the row stayed. But deleting outright would erase
    // the fact that this version was ever applied here, and a schema versioning
    // tool should not quietly lose history. So the row is copied into
    // script_patch_reverted first. Nothing else reads that table; it exists
    // purely as an audit trail you can query by hand.
    //
    // Created here, inside the transaction and after every check has passed, so
    // a refused revert leaves no trace in the target schema. Postgres runs DDL
    // transactionally, so this is undone with everything else if the rollback
    // SQL below fails. Two reverts of DIFFERENT versions in the same schema
    // hash to different lock keys and can reach this concurrently, and
    // `IF NOT EXISTS` is not race-proof at the catalog level — swallow exactly
    // that collision, since the goal (the table exists) is met either way.
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${quotedSchema}.script_patch_reverted (
          id          SERIAL PRIMARY KEY,
          script_name VARCHAR(150),
          version     VARCHAR(20),
          title       VARCHAR(150),
          change_type VARCHAR(20),
          applied_at  TIMESTAMP,
          reverted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          down_sql    TEXT
        )
      `);
    } catch (setupError) {
      const m = (setupError instanceof Error ? setupError.message : String(setupError)).toLowerCase();
      if (!m.includes("already exists") && !m.includes("duplicate key")) throw setupError;
    }

    await client.query(
      `INSERT INTO ${quotedSchema}.script_patch_reverted
         (script_name, version, title, change_type, applied_at, down_sql)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [name, ver, row.title, row.change_type, row.applied_at, downSql]
    );

    const deleted = await client.query(
      `DELETE FROM ${quotedSchema}.script_patch WHERE id = $1`,
      [row.id]
    );

    if (deleted.rowCount !== 1) {
      // Should be unreachable — we hold the advisory lock and selected this id
      // in the same transaction. Fail loudly rather than commit a rollback that
      // left the version still marked as applied.
      throw new Error(
        `Expected to remove 1 ledger row for v${ver}, removed ${deleted.rowCount}.`
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;

    // Release the target-pool connection BEFORE the lineage advance, which
    // re-introspects the target on its own connection.
    client.release();
    clientReleased = true;

    // ─── 8. Advance lineage for TRACKED schemas ──────────────────────────
    // A rollback changes the live structure just as much as a deploy does, so
    // the tracked baseline has to move with it — otherwise the next drift check
    // compares live-against-pre-rollback and reports our own revert as drift.
    // The change level is the one the reverted migration carried: undoing an
    // additive change is itself a structural change of the same weight.
    // Strictly best-effort — the rollback is already committed, so a
    // bookkeeping failure here must not fail the response.
    let lineageNote: string | null = null;
    try {
      const lineage = await recordAppliedMigrationToLineage({
        connectionId,
        schemaName,
        targetConfig,
        changeLevel: revertedChangeLevel,
        name: `Revert ${name} v${ver}`,
        sqlRef: null,
      });
      if (lineage.advanced) {
        lineageNote = `Lineage advanced to ${lineage.version}.`;
        console.log(
          `Revert — lineage advanced to ${lineage.version} (seq ${lineage.seq}) ` +
          `for tracked schema "${schemaName}".`
        );
      }
    } catch (lineageError) {
      console.error(
        "Revert — lineage advance failed (rollback already committed, response unaffected):",
        lineageError
      );
    }

    return NextResponse.json({
      success: true,
      version: ver,
      schema: schemaName,
      message:
        `Rolled back v${ver} of "${name}" in schema "${schemaName}". ` +
        `The version is pending again and can be deployed.` +
        (lineageNote ? ` ${lineageNote}` : ""),
    });

  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Revert — ROLLBACK itself failed:", rollbackError);
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error("Revert — rollback execution failed:", message);

    return NextResponse.json(
      {
        error:
          `Rollback of v${ver} failed and nothing was changed — the transaction ` +
          `was rolled back, so v${ver} is still applied. Details: ${message}`,
      },
      { status: 500 }
    );
  } finally {
    if (!clientReleased) client.release();
  }
}
