import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { requireEditor } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { getPoolForConfig } from "@/lib/postgres";
import { buildPgConfig } from "@/lib/connection-config";
import { containsTransactionControl } from "@/lib/sql-guard";
import { compareVersions, isValidSemver, normalizeVersion } from "@/lib/script-status";
import {
  checkNewestFirst,
  listVersions,
  loudestChangeLevel,
  MAX_ROLLBACK_VERSIONS,
  resolveRollback,
  vLabel,
} from "@/lib/rollback-plan";
import { lockScriptFamilies, lockScriptVersion } from "@/lib/family-lock";
import { analyseRunRisk } from "@/lib/deploy-risk";
import { claimApproval, releaseApproval } from "@/lib/approvals-db";
import { findTrackedSchema, recordAppliedMigrationToLineage } from "@/lib/lineage-db";
import {
  isProduction,
  louderEnvironment,
  productionBlockReason,
  toEnvironment,
} from "@/lib/environments";
import type { ChangeLevel } from "@/lib/change-level";

// ---------------------------------------------------------------------------
// POST /api/scripts/revert — undo one or more applied versions of ONE script
// family, newest first, in ONE transaction.
//
// The mirror image of /api/scripts/apply. For each version it runs the
// rollback ("down") SQL, copies the ledger row into script_patch_reverted and
// deletes it from script_patch, so the version shows as pending again and can
// be deployed again. "Roll back to v1.0.0" sends every version above v1.0.0;
// they all come off, or none do.
//
// Which rollback runs (lib/rollback-plan.ts resolveRollback): the copy stored
// on the ledger row wins, because it was written in the same transaction as
// the migration it undoes. The registry copy the page sends (v<ver>.down.sql)
// is used only when the row has none. This route never calls GitHub.
//
// The rules that keep a target's history honest:
//   1. Only versions this database actually applied can be undone.
//   2. Only the NEWEST applied versions can be undone. Undoing v2 while v3 is
//      still applied would run v2's undo under structure v3 has changed.
//   3. Other families applied after the oldest version being undone are
//      listed, and the caller has to confirm it checked them
//      (acknowledgeProduction's sibling, acknowledgeOtherScripts).
//   4. On production, a real run needs a second person's approval, exactly
//      like a deploy (deploy_approvals rows with action 'revert').
//
// What it does NOT do: bring data back. A rollback restores structure. Rows
// that a DROP removed are gone, and the Deploy screen says so first.
// ---------------------------------------------------------------------------

// Safely quote a PostgreSQL identifier (schema name, column name).
// Same helper as the apply route — wraps in double-quotes, escapes internal ones.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Twins of LOCK_TIMEOUT_MS and LOCK_NOT_AVAILABLE in app/api/scripts/apply/route.ts
// (lines 94-98), repeated here the same way quoteIdent is. A rollback waits
// for a lock exactly as long as a deploy does.
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_NOT_AVAILABLE = "55P03";

// script_patch.change_type is a constrained VARCHAR; these are its legal values,
// which are also exactly the ChangeLevel union the lineage helper accepts.
const VALID_CHANGE_TYPES: ChangeLevel[] = ["breaking", "additive", "patch", "unknown"];

function asChangeLevel(value: string | null): ChangeLevel {
  return VALID_CHANGE_TYPES.includes(value as ChangeLevel)
    ? (value as ChangeLevel)
    : "unknown";
}

/** Newest version first, the order rollbacks must run in. */
function newestFirst(left: string, right: string): number {
  return compareVersions(right, left);
}

/** Every refusal has the same shape: ok/success false plus a readable error. */
function fail(status: number, payload: Record<string, unknown> & { error: string }) {
  return NextResponse.json({ ok: false, success: false, ...payload }, { status });
}

// ─── Request body ──────────────────────────────────────────────────────────

type RevertBody = {
  connectionId?: unknown;
  schemaName?: unknown;
  script_name?: unknown;
  /** The versions to undo. Order does not matter; they run newest first. */
  versions?: unknown;
  /** Legacy single-version form, read only when `versions` is absent. */
  version?: unknown;
  /** Legacy registry rollback for `version`, read only when `versions` is absent. */
  sql_content?: unknown;
  /** v<ver>.down.sql from the registry, per version. Used only when the ledger row has no rollback. */
  registryRollbacks?: unknown;
  /** Run everything, then ROLLBACK: reports what would happen and changes nothing. */
  dryRun?: unknown;
  /** Set by a screen only after somebody ticked the production warning. */
  acknowledgeProduction?: unknown;
  /** Set by a screen only after somebody checked the later scripts from other families. */
  acknowledgeOtherScripts?: unknown;
  /**
   * Set by a screen only after somebody ticked the warning that the rollback
   * deletes rows. Needed whenever the rollback SQL that will run holds a
   * TRUNCATE, DELETE or a DROP that takes rows with it, dry runs included.
   */
  acknowledgeDataLoss?: unknown;
};

type RevertRequest = {
  connectionId: number;
  schemaName: string;
  scriptName: string;
  /** Validated, de-duplicated, newest first. */
  versions: string[];
  registry: { version: string; downSql: string }[];
  dryRun: boolean;
  acknowledgeProduction: boolean;
  acknowledgeOtherScripts: boolean;
  acknowledgeDataLoss: boolean;
};

/**
 * Check the body and turn it into a RevertRequest, or return the reason it
 * cannot be one. Everything here is checked before any database is touched.
 */
function parseRequest(body: RevertBody): RevertRequest | string {
  const connectionId = Number(body.connectionId);
  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    return "Pick a connection first: connectionId must be a positive whole number.";
  }

  const scriptName = typeof body.script_name === "string" ? body.script_name.trim() : "";
  if (!scriptName) return "Say which script to roll back: script_name is required.";
  if (scriptName.length > 150) {
    return "script_name is longer than 150 characters, so it cannot name a script in the ledger.";
  }

  const schemaName =
    typeof body.schemaName === "string" && body.schemaName.trim().length > 0
      ? body.schemaName.trim()
      : "public";

  // The legacy body ({version, sql_content}) is the one-version case of the
  // new one. It is read only when `versions` is absent, so a caller that sends
  // both gets the new meaning.
  const legacy = body.versions === undefined;
  const rawVersions: unknown = legacy
    ? typeof body.version === "string" ? [body.version] : undefined
    : body.versions;
  const rawRegistry: unknown =
    legacy && typeof body.version === "string" && typeof body.sql_content === "string"
      ? [{ version: body.version, down_sql: body.sql_content }]
      : body.registryRollbacks;

  if (!Array.isArray(rawVersions) || rawVersions.length === 0) {
    return `Say which versions to roll back: versions must list 1 to ${MAX_ROLLBACK_VERSIONS} versions, like ["2.0.0", "1.1.0"].`;
  }
  // The cap lives in lib/rollback-plan.ts, shared with the Deploy page and
  // the approvals route: the page never offers a longer rollback, and no
  // approval is recorded for one this route would refuse. A family further
  // back than the cap is rolled back in several steps.
  if (rawVersions.length > MAX_ROLLBACK_VERSIONS) {
    return (
      `A rollback can undo at most ${MAX_ROLLBACK_VERSIONS} versions at a time, and this request ` +
      `lists ${rawVersions.length}. Nothing was rolled back. Roll back in steps: undo the newest ` +
      `${MAX_ROLLBACK_VERSIONS} first, then roll back again.`
    );
  }

  const versions: string[] = [];
  for (const raw of rawVersions) {
    const version = typeof raw === "string" ? raw.trim() : "";
    if (!isValidSemver(version)) {
      return `"${String(raw)}" is not a version number. Use numbers like 1.2.0.`;
    }
    // "1.2" and "1.2.0" are the same version, as everywhere else.
    if (versions.some((seen) => compareVersions(seen, version) === 0)) {
      return `${vLabel(version)} is listed twice. List each version once.`;
    }
    versions.push(version);
  }
  versions.sort(newestFirst);

  const registry: { version: string; downSql: string }[] = [];
  if (rawRegistry !== undefined && rawRegistry !== null) {
    if (!Array.isArray(rawRegistry)) {
      return "registryRollbacks must be a list of {version, down_sql}.";
    }
    for (const entry of rawRegistry) {
      const item = (entry ?? {}) as { version?: unknown; down_sql?: unknown };
      const version = typeof item.version === "string" ? item.version.trim() : "";
      if (!version || !versions.some((wanted) => compareVersions(wanted, version) === 0)) {
        return (
          `The registry rollback for "${String(item.version)}" is for a version this ` +
          `request does not undo. Send rollbacks only for the versions being rolled back.`
        );
      }
      if (typeof item.down_sql !== "string") {
        return `The registry rollback for ${vLabel(version)} has no down_sql text.`;
      }
      // This route owns the transaction. A COMMIT inside the rollback would end
      // it early and make half of the undo permanent, so refuse before any
      // connection is opened. The stored copy is checked the same way once it
      // is read (resolveRollback).
      if (containsTransactionControl(item.down_sql)) {
        return (
          `The registry rollback for ${vLabel(version)} contains COMMIT or ROLLBACK, so it ` +
          `cannot run inside the transaction that protects this rollback. Nothing was run. ` +
          `Remove those statements from the rollback in the Script Editor, or run it by hand ` +
          `from a SQL console.`
        );
      }
      registry.push({ version, downSql: item.down_sql });
    }
  }

  return {
    connectionId,
    schemaName,
    scriptName,
    versions,
    registry,
    dryRun: body.dryRun === true,
    acknowledgeProduction: body.acknowledgeProduction === true,
    acknowledgeOtherScripts: body.acknowledgeOtherScripts === true,
    acknowledgeDataLoss: body.acknowledgeDataLoss === true,
  };
}

// ─── Ledger rows ───────────────────────────────────────────────────────────

type LedgerRow = {
  id: number;
  version: string;
  title: string | null;
  change_type: string | null;
  applied_at: Date | string | null;
  down_sql: string | null;
};

type OtherScript = { script_name: string; version: string; applied_at: Date | string | null };

/** One version that passed every check, with the rollback that will run for it. */
type PlannedStep = { row: LedgerRow; sql: string; source: "ledger" | "registry" };

export async function POST(request: NextRequest) {
  // ─── 1. Editors only ─────────────────────────────────────────────────────
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  // ─── 2. Parse and validate the body ──────────────────────────────────────
  let body: RevertBody;
  try {
    body = (await request.json()) ?? {};
  } catch {
    return fail(400, { error: "The request body is not valid JSON. Nothing was changed." });
  }

  const parsed = parseRequest(body);
  if (typeof parsed === "string") return fail(400, { error: parsed });

  const { connectionId, schemaName, scriptName: name, versions, dryRun } = parsed;
  const registryCopyFor = (version: string): string | null =>
    parsed.registry.find((entry) => compareVersions(entry.version, version) === 0)?.downSql ??
    null;

  // ─── 3. Saved connection, then the production gate ───────────────────────
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
    name: string | null;
  };

  try {
    // The ssl_mode column is added lazily; make sure it exists before selecting it.
    await syncMetadataTables();
    const result = await pool.query(
      `SELECT host, port, database_name, username, password, connection_string, ssl, ssl_mode, environment, name
       FROM connections
       WHERE id = $1`,
      [connectionId]
    );
    if (result.rows.length === 0) {
      return fail(404, { error: `No saved connection found with id ${connectionId}.` });
    }
    connRow = result.rows[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Revert — failed to fetch connection record:", message);
    return fail(500, {
      error: "Could not read the saved connection, so nothing was run. Is the app database reachable?",
    });
  }

  // Same rule as the apply route (productionBlockReason), and it applies to a
  // dry run too: a dry run still runs the rollback SQL on production, it only
  // undoes it afterwards. A rollback is not the gentler of the two operations:
  // it drops what the migration added, so on a live database it loses rows.
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
  const blocked = productionBlockReason(targetEnvironment, parsed.acknowledgeProduction);
  if (blocked) return fail(409, { error: blocked, environment: targetEnvironment });

  // ─── 4. Connect, and start collecting NOTICEs ────────────────────────────
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

  let connected: PoolClient;
  try {
    connected = await getPoolForConfig(targetConfig).connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Revert — could not connect to target DB:", message);
    return fail(503, {
      error:
        `Could not connect to target database ` +
        `(${connRow.host}:${connRow.port}/${connRow.database_name}). ` +
        `Check that the database is running and the credentials are correct. ` +
        `Details: ${message}`,
    });
  }
  const client = connected;

  // PostgreSQL reports cascaded drops ("drop cascades to view x") and skipped
  // IF EXISTS drops as NOTICEs, which are exactly what an operator wants to see
  // after a rollback, or before one in a dry run. Only notices raised while a
  // version's rollback runs are kept; the route's own bookkeeping (CREATE TABLE
  // IF NOT EXISTS says "already exists, skipping") is not the operator's news.
  const notices: { version: string | null; message: string }[] = [];
  let runningVersion: string | null = null;
  const onNotice = (notice: { message?: string }) => {
    if (runningVersion !== null) {
      notices.push({ version: runningVersion, message: notice.message ?? "" });
    }
  };
  client.on("notice", onNotice);

  const quotedSchema = quoteIdent(schemaName);
  const connectionName = connRow.name?.trim() || `${connRow.host}/${connRow.database_name}`;

  let transactionStarted = false;
  let clientReleased = false;
  // A connection whose COMMIT or ROLLBACK failed is in an unknown state; it is
  // destroyed rather than handed back to the pool for the next request.
  let brokenConnection = false;
  // Approval bookkeeping: a claimed approval goes back to "approved" unless a
  // COMMIT was attempted. Once COMMIT was sent, the rollback may have taken
  // effect, and the approval must not be spent a second time.
  let claimedApprovalId: number | null = null;
  let commitAttempted = false;

  // Refuse from inside the transaction: undo it (nothing ran yet), then answer.
  const refuse = async (status: number, payload: Record<string, unknown> & { error: string }) => {
    await client.query("ROLLBACK");
    transactionStarted = false;
    return fail(status, payload);
  };

  try {
    // ─── 5. The schema has to exist ────────────────────────────────────────
    // Checked before BEGIN so the "no ledger" message below is only ever about
    // a real schema that has no ledger, never about a typo.
    const schemaCheck = await client.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [
      schemaName,
    ]);
    if (schemaCheck.rows.length === 0) {
      return fail(404, {
        code: "no_schema",
        error: `Schema "${schemaName}" does not exist on "${connectionName}". Pick another schema.`,
      });
    }

    // ─── 6. Transaction, lock timeout, locks, search_path ──────────────────
    await client.query("BEGIN");
    transactionStarted = true;

    // Bounded waits: without this a rollback queues forever behind any open
    // transaction on the tables it touches. It also bounds the advisory-lock
    // waits below. 55P03 is turned into a readable message in the catch.
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);

    // The family lock is the same key the apply route takes (lib/family-lock.ts),
    // so a deploy and a rollback of the same script never interleave. The
    // per-version locks match apply's per-version keys too; they are taken only
    // while the family lock is held, in sorted order, so they cannot deadlock.
    await lockScriptFamilies(client, schemaName, [name]);
    for (const version of [...versions].sort(compareVersions)) {
      await lockScriptVersion(client, schemaName, name, normalizeVersion(version) ?? version);
    }

    // Scope unqualified names in the rollback SQL to the target schema ONLY —
    // `public` is deliberately off the path for the same reason as apply: an
    // unqualified DROP of a relation missing from the target must no-op, not
    // fall through and hit public's same-named table.
    await client.query(`SET LOCAL search_path TO ${quotedSchema}`);

    // ─── 7. Ledger checks ──────────────────────────────────────────────────
    // 7a. A schema with no script_patch has had nothing applied by this tool.
    const tableCheck = await client.query<{ reg: string | null }>(
      `SELECT to_regclass($1) AS reg`,
      [`${quotedSchema}.script_patch`]
    );
    if (!tableCheck.rows[0]?.reg) {
      return await refuse(409, {
        code: "no_ledger",
        error:
          `Schema "${schemaName}" has no script_patch ledger, so no migration ` +
          `has been applied there. Nothing to revert.`,
      });
    }

    // 7b. down_sql is added lazily by the apply route, so ask the catalog
    //     before selecting it.
    const colCheck = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'script_patch'
          AND column_name = 'down_sql'`,
      [schemaName]
    );
    const downExpr = colCheck.rows.length > 0 ? "down_sql" : "NULL::text AS down_sql";

    // 7c. Read the whole family once: the newest-first check needs every
    //     applied version, not only the requested ones. Read inside the
    //     transaction, under the family lock, so nothing changes it until COMMIT.
    const family = await client.query<LedgerRow>(
      `SELECT id, version, title, change_type, applied_at, ${downExpr}
         FROM ${quotedSchema}.script_patch
        WHERE script_name = $1`,
      [name]
    );

    const findRow = (version: string) =>
      family.rows.find((row) => compareVersions(row.version, version) === 0);

    const missing = versions.filter((version) => !findRow(version));
    if (missing.length > 0) {
      return await refuse(409, {
        code: "not_applied",
        notApplied: missing,
        // From the Deploy page this means its copy of the ledger is out of
        // date; the page reads it again when it gets this code.
        error:
          `${listVersions(missing)} of "${name}" ${missing.length === 1 ? "is" : "are"} not ` +
          `applied to schema "${schemaName}", so ${missing.length === 1 ? "it" : "they"} can't be ` +
          `rolled back. Nothing was rolled back. Someone may have rolled ` +
          `${missing.length === 1 ? "it" : "them"} back already: check the database again and ` +
          `plan the rollback from what is applied now.`,
      });
    }

    // 7d. Newest first: the request must be exactly the top N applied versions.
    const order = checkNewestFirst(
      family.rows.map((row) => row.version),
      versions
    );
    if (!order.ok && order.mustAlsoUndo.length > 0) {
      const lowest = versions[versions.length - 1];
      const many = order.mustAlsoUndo.length > 1;
      return await refuse(409, {
        code: "not_newest",
        mustAlsoUndo: order.mustAlsoUndo,
        // The Deploy page always sends the newest versions of the ledger it
        // read, so from there this means someone deployed since; the page
        // reads the ledger again when it gets this code.
        error:
          `${listVersions(order.mustAlsoUndo)} of "${name}" ${many ? "are" : "is"} newer than ` +
          `${vLabel(lowest)} and ${many ? "were" : "was"} built on top of it, so ` +
          `${many ? "they have" : "it has"} to be rolled back too, in the same rollback. Nothing ` +
          `was rolled back. This usually means the list of applied versions was out of date: ` +
          `check the database again and plan the rollback from what is applied now.`,
      });
    }

    // ─── 8. Which rollback runs for each version ───────────────────────────
    const plan: PlannedStep[] = [];
    for (const version of versions) {
      const row = findRow(version) as LedgerRow;
      const resolved = resolveRollback(row.down_sql, registryCopyFor(version));
      if ("problem" in resolved) {
        if (resolved.problem === "transaction_control") {
          return await refuse(409, {
            code: "transaction_control",
            version: row.version,
            error:
              `The rollback stored for ${vLabel(row.version)} contains COMMIT or ROLLBACK, so it ` +
              `cannot run inside the transaction that protects this rollback. Run it by hand ` +
              `from a SQL console.`,
          });
        }
        return await refuse(409, {
          code: "no_rollback",
          version: row.version,
          error:
            `${vLabel(row.version)} of "${name}" has no rollback to run. If it is in the GitHub ` +
            `registry, add one in the Script Editor (Add a missing rollback), then reload ` +
            `Deploy. If it was replayed here by Version Sync without one, undo it by hand or ` +
            `fix it forward with a new version.`,
        });
      }
      plan.push({ row, sql: resolved.sql, source: resolved.source });
    }

    // ─── 8b. A rollback that deletes rows needs a tick ─────────────────────
    // Undoing a version often means DROP TABLE or DROP COLUMN, and the rows
    // those take go with them: deploying the version again brings the
    // structure back, not the rows. The Deploy screen asks for a tick about
    // that before either button. This is the same check on the same SQL (the
    // rollback text that will run, picked above) with the same helper
    // (lib/deploy-risk), so a caller that skipped the warning cannot run past
    // it. A dry run needs the tick too: it really runs the SQL. Checked before
    // the approval claim in step 10, so a refusal here spends nothing.
    const lost = analyseRunRisk(
      plan.map((step) => ({ scriptName: name, version: step.row.version, sqlContent: step.sql }))
    ).dataLoss;
    if (lost.length > 0 && !parsed.acknowledgeDataLoss) {
      const named = lost.map((entry) => `${vLabel(entry.version)} runs ${entry.kinds.join(", ")}`);
      return await refuse(409, {
        code: "data_loss",
        needsAcknowledgement: ["data_loss"],
        dataLoss: lost.map((entry) => ({ version: entry.version, kinds: entry.kinds })),
        error:
          `Rolling back ${listVersions(lost.map((entry) => entry.version))} of "${name}" ` +
          `deletes rows (${named.join("; ")}), and deploying again brings back the ` +
          `structure, not the rows. Nothing was rolled back. Tick the box about deleted ` +
          `rows, then ${dryRun ? "start the dry run" : "roll back"} again.`,
      });
    }

    // ─── 9. Later scripts from other families ──────────────────────────────
    // Another family applied after the oldest version being undone may use
    // what this rollback removes, and a DROP ... CASCADE takes its objects
    // with it. List them; a real run needs the caller to confirm it checked
    // them. A dry run returns the list without refusing, so the screen can
    // show it before asking.
    //
    // "After" is decided in SQL from the ledger ids being undone: a later
    // applied_at, or the same applied_at and a higher id. Every row one deploy
    // run writes shares one applied_at (the transaction's start time), so a
    // family deployed in the same run would be missed by applied_at alone, and
    // a timestamp sent back from JS would lose its microseconds. The
    // pre-flight route uses the same rule, so its list and this refusal agree.
    // When none of the rows has an applied_at, "oldest" is empty and nothing
    // is listed.
    const later = await client.query<OtherScript>(
      `SELECT other.script_name, other.version, other.applied_at
         FROM ${quotedSchema}.script_patch AS other
         JOIN (SELECT applied_at, id
                 FROM ${quotedSchema}.script_patch
                WHERE id = ANY($2::int[]) AND applied_at IS NOT NULL
                ORDER BY applied_at, id
                LIMIT 1) AS oldest ON true
        WHERE other.script_name <> $1
          AND (other.applied_at > oldest.applied_at
               OR (other.applied_at = oldest.applied_at AND other.id > oldest.id))
        ORDER BY other.applied_at, other.id
        LIMIT 200`,
      [name, plan.map((step) => step.row.id)]
    );
    const otherScripts: OtherScript[] = later.rows;
    if (otherScripts.length > 0 && !parsed.acknowledgeOtherScripts && !dryRun) {
      const shown = otherScripts
        .slice(0, 5)
        .map((other) => `${other.script_name} ${vLabel(other.version)}`);
      const more = otherScripts.length > 5 ? `, and ${otherScripts.length - 5} more` : "";
      return await refuse(409, {
        code: "other_scripts_after",
        otherScripts,
        error:
          `Other scripts were applied to schema "${schemaName}" after ` +
          `${vLabel(plan[plan.length - 1].row.version)} (${shown.join(", ")}${more}). They may ` +
          `depend on what this rollback removes, and a DROP ... CASCADE would remove their ` +
          `objects too. Tick the box once you have checked them.`,
      });
    }

    // ─── 10. Production: spend a second person's approval ──────────────────
    // After the ledger read, because the approved text is the resolved,
    // ledger-first rollback SQL, newest version first — the same list the
    // Deploy screen hashes with rollbackFingerprintBody when it asks.
    if (isProduction(targetEnvironment) && !dryRun) {
      let claimed;
      try {
        claimed = await claimApproval({
          connectionId,
          schemaName,
          scripts: plan.map((step) => ({
            scriptName: name,
            version: step.row.version,
            sqlContent: step.sql,
          })),
          action: "revert",
        });
      } catch (claimError) {
        console.error("Revert — could not read the approval:", claimError);
        return await refuse(500, {
          error:
            "Could not check the approval for this rollback, so nothing was run and nothing " +
            "changed. Is the app database reachable? Try again.",
        });
      }
      if (!claimed) {
        return await refuse(403, {
          needsApproval: true,
          error:
            "Rolling back on production needs a second person's approval. Ask for it in the " +
            "Approvals panel, then press Roll back again.",
        });
      }
      claimedApprovalId = claimed.id;
    }

    // ─── 11. Run the rollbacks ─────────────────────────────────────────────
    // The audit table: the DELETE below is what makes a version deployable
    // again (apply's duplicate check and the UNIQUE (script_name, version)
    // index would both refuse it otherwise), but deleting outright would erase
    // the fact that it was ever applied. So each row is copied here first.
    // Deploy's "Rolled back" history reads this table through
    // /api/scripts/preflight.
    //
    // Created here, after every check, so a refused rollback leaves no trace.
    // Rollbacks of two DIFFERENT families in one schema can reach this at the
    // same time, and IF NOT EXISTS is not race-proof in the catalog. The
    // SAVEPOINT matters: swallowing an error inside a transaction would leave
    // it aborted (25P02) without it.
    await client.query("SAVEPOINT script_patch_reverted_setup");
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${quotedSchema}.script_patch_reverted (
          id          SERIAL PRIMARY KEY,
          script_name VARCHAR(150),
          version     VARCHAR(20),
          title       VARCHAR(150),
          change_type VARCHAR(20),
          applied_at  TIMESTAMPTZ,
          reverted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          down_sql    TEXT
        )
      `);
      await client.query("RELEASE SAVEPOINT script_patch_reverted_setup");
    } catch (setupError) {
      const m = (setupError instanceof Error ? setupError.message : String(setupError)).toLowerCase();
      if (!m.includes("already exists") && !m.includes("duplicate key")) throw setupError;
      await client.query("ROLLBACK TO SAVEPOINT script_patch_reverted_setup");
    }

    // Both columns were TIMESTAMP in earlier builds — a wall clock with the
    // offset discarded — so an audit table meant to say WHEN something was
    // undone could be off by the zone difference. No USING clause: Postgres
    // reads the stored wall clock in the session's zone, the zone that wrote it.
    const oldTypes = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'script_patch_reverted'
          AND column_name IN ('applied_at', 'reverted_at')
          AND data_type = 'timestamp without time zone'`,
      [schemaName]
    );
    for (const { column_name } of oldTypes.rows) {
      await client.query(
        `ALTER TABLE ${quotedSchema}.script_patch_reverted
         ALTER COLUMN ${quoteIdent(column_name)} TYPE TIMESTAMPTZ`
      );
    }

    // Newest first. Every row of one batch gets the same reverted_at, because
    // CURRENT_TIMESTAMP is the start of the transaction — which is also how the
    // history can tell that they came off together.
    for (const step of plan) {
      runningVersion = step.row.version;
      await client.query(step.sql);

      await client.query(
        `INSERT INTO ${quotedSchema}.script_patch_reverted
           (script_name, version, title, change_type, applied_at, down_sql)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [name, step.row.version, step.row.title, step.row.change_type, step.row.applied_at, step.sql]
      );

      const deleted = await client.query(`DELETE FROM ${quotedSchema}.script_patch WHERE id = $1`, [
        step.row.id,
      ]);
      if (deleted.rowCount !== 1) {
        // Should be unreachable — the family lock is held and this id was read
        // in the same transaction. Fail loudly rather than commit a rollback
        // that left the version still marked as applied.
        throw new Error(
          `Expected to remove 1 ledger row for ${vLabel(step.row.version)}, removed ${deleted.rowCount}.`
        );
      }
    }
    runningVersion = null;

    const undone = plan.map((step) => step.row.version);
    const results = plan.map((step) => ({ version: step.row.version, source: step.source }));
    const noticeNote =
      notices.length > 0
        ? ` PostgreSQL also reported: ${notices
            .slice(0, 10)
            .map((n) => (n.version ? `${vLabel(n.version)}: ${n.message}` : n.message))
            .join("; ")}${notices.length > 10 ? `; and ${notices.length - 10} more` : ""}.`
        : "";

    // ─── 12. Dry run: undo everything and report ───────────────────────────
    if (dryRun) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return NextResponse.json({
        ok: true,
        success: true,
        dryRun: true,
        schema: schemaName,
        versions: undone,
        results,
        notices,
        otherScripts,
        message:
          `Dry run passed: the rollback of ${listVersions(undone)} ran without errors and was ` +
          `then undone. Nothing changed.${noticeNote}`,
      });
    }

    // ─── 13. Real run: COMMIT ──────────────────────────────────────────────
    // If COMMIT itself throws (the connection dropped), the server may or may
    // not have committed. Saying "nothing was changed" could be false, so say
    // what is known, and keep the approval spent.
    commitAttempted = true;
    try {
      await client.query("COMMIT");
    } catch (commitError) {
      transactionStarted = false;
      brokenConnection = true;
      console.error("Revert — COMMIT failed, outcome unknown:", commitError);
      return fail(500, {
        outcomeUnknown: true,
        error:
          `The connection dropped while committing the rollback, so it is not known whether ` +
          `it took effect. Reload Deploy - if ${vLabel(undone[undone.length - 1])} shows as ` +
          `pending, the rollback went through.`,
      });
    }
    transactionStarted = false;

    // ─── 14. Release the client, then advance lineage ──────────────────────
    // Released BEFORE the lineage advance, which re-introspects the target on
    // its own connection. The notice listener comes off first: the client goes
    // back to a pool, and the listener must not follow it to the next request.
    client.off("notice", onNotice);
    client.release();
    clientReleased = true;

    // A rollback changes the live structure as much as a deploy does, so a
    // tracked baseline moves with it — otherwise the next drift check reports
    // our own rollback as drift. One lineage entry for the whole batch, at the
    // loudest level among the versions undone. Best-effort: the rollback is
    // already committed, so a bookkeeping failure must not fail the response.
    let lineageNote = "";
    try {
      const lineage = await recordAppliedMigrationToLineage({
        connectionId,
        schemaName,
        targetConfig,
        changeLevel: loudestChangeLevel(plan.map((step) => asChangeLevel(step.row.change_type))),
        name: `Revert ${name} ${undone.map(vLabel).join(", ")}`,
        sqlRef: null,
      });
      if (lineage.advanced) lineageNote = ` Lineage advanced to ${lineage.version}.`;
    } catch (lineageError) {
      console.error(
        "Revert — lineage advance failed (rollback already committed, response unaffected):",
        lineageError
      );
    }

    // ─── 15. Tell the operator where the script stands now ─────────────────
    const remaining = family.rows
      .map((row) => row.version)
      .filter((version) => !undone.some((gone) => compareVersions(gone, version) === 0))
      .sort(newestFirst);
    const where =
      undone.length === 1
        ? `Rolled back ${vLabel(undone[0])} of "${name}" in schema "${schemaName}". It shows as ` +
          `pending again and can be deployed.`
        : `Rolled back ${listVersions(undone)} of "${name}" in schema "${schemaName}" - ` +
          (remaining.length > 0
            ? `this script is back at ${vLabel(remaining[0])}.`
            : `no version of this script is applied now.`);

    return NextResponse.json({
      ok: true,
      success: true,
      dryRun: false,
      // The oldest version undone: the one the page shows as pending first.
      version: undone[undone.length - 1],
      versions: undone,
      schema: schemaName,
      results,
      notices,
      message: `${where}${lineageNote}${noticeNote}`,
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        brokenConnection = true;
        console.error("Revert — ROLLBACK itself failed:", rollbackError);
      }
      transactionStarted = false;
    }

    const message = error instanceof Error ? error.message : String(error);
    const pgCode = (error as { code?: string }).code;
    console.error("Revert — rollback failed:", message);

    // A lock timeout is not a broken rollback, and "canceling statement due to
    // lock timeout" does not tell the operator that trying again is the fix.
    if (pgCode === LOCK_NOT_AVAILABLE) {
      return fail(503, {
        error:
          `The rollback waited ${LOCK_TIMEOUT_MS / 1000} seconds for another session to ` +
          `release a table it needs and gave up. Nothing was changed. Try again when the ` +
          `database is quiet, or check whether a deploy or rollback of this script is running.`,
      });
    }

    // Before any rollback SQL ran, name the first (newest) version.
    return fail(500, {
      error:
        `The rollback of ${vLabel(runningVersion ?? versions[0])} failed, so nothing was ` +
        `changed - every version in this rollback is still applied. PostgreSQL said: ${message}`,
    });
  } finally {
    // An approval spent on a run that never reached COMMIT goes back to
    // "approved", so the operator can fix the problem and press Roll back
    // again without asking a second time. Best-effort.
    if (claimedApprovalId !== null && !commitAttempted) {
      try {
        await releaseApproval(claimedApprovalId);
      } catch (releaseError) {
        console.error("Revert — could not return the approval:", releaseError);
      }
    }
    if (!clientReleased) {
      client.off("notice", onNotice);
      client.release(brokenConnection || undefined);
    }
  }
}
