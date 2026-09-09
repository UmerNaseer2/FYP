import { NextRequest, NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth-guard";
import { claimApproval, releaseApproval } from "@/lib/approvals-db";
import pool, { syncMetadataTables } from "@/lib/version-db";
import type { PoolClient } from "pg";
import { getPoolForConfig } from "@/lib/postgres";
import { buildPgConfig } from "@/lib/connection-config";
import { containsTransactionControl, extractEnumAddValues } from "@/lib/sql-guard";
import { findTrackedSchema, recordAppliedMigrationToLineage } from "@/lib/lineage-db";
import {
  isProduction,
  louderEnvironment,
  productionBlockReason,
  toEnvironment,
} from "@/lib/environments";

// Valid values the script_patch table accepts for change_type
const VALID_CHANGE_TYPES = ["breaking", "additive", "patch", "unknown"] as const;
type ChangeType = (typeof VALID_CHANGE_TYPES)[number];

// script_patch.version is VARCHAR(20)
const MAX_VERSION_LENGTH = 20;

/** One migration as a caller sends it — every field still unvalidated. */
type ScriptInput = {
  script_name?: string;
  sql_content?: string;
  down_sql?: string;
  version?: string;
  title?: string;
  description?: string;
  change_type?: string;
  source_ref?: string;
};

/** One migration in a run, after validation and normalising. */
type ScriptJob = {
  scriptName: string;
  version: string;
  sqlContent: string;
  downSql: string | null;
  title: string;
  description: string | null;
  changeType: ChangeType;
  sourceRef: string | null;
};

/** What happened to one migration in a run, as reported back to the caller. */
type ScriptOutcome = {
  script_name: string;
  version: string;
  status: "applied" | "rehearsed" | "failed" | "skipped";
  /** How many statements PostgreSQL ran for it. */
  statements?: number;
  error?: string;
};

/**
 * The part of a node-postgres result the dry-run report reads.
 *
 * A query with no values array goes over the simple protocol, so one string can
 * hold many statements and the library hands back an ARRAY of results, one per
 * statement — a shape its own QueryResult type does not describe.
 */
type PgExecResult = { command?: string; rowCount?: number | null };

/**
 * PostgreSQL's "unsafe use of new value of enum type" error.
 *
 * Raised when a statement uses a label that ALTER TYPE … ADD VALUE added in the
 * same transaction. A real apply never sees it — those statements are hoisted
 * out and committed first — so under a dry run it means the rehearsal hit a
 * limit of rehearsing, not a fault in the script. The SQLSTATE only exists from
 * PostgreSQL 12, hence the message fallback for older servers.
 */
const UNSAFE_NEW_ENUM_VALUE = "55P04";

/**
 * How long a migration waits for a lock before giving up (see step 8).
 *
 * Fifteen seconds is a judgement call, not a measurement: long enough to ride
 * out the ordinary short transaction that happens to be reading the table when
 * the deploy lands, short enough that a genuinely busy table fails the deploy
 * rather than blocking everyone behind it.
 */
const LOCK_TIMEOUT_MS = 15_000;

/** PostgreSQL's SQLSTATE for "gave up waiting for a lock" (lock_not_available). */
const LOCK_NOT_AVAILABLE = "55P03";

// Safely quote a PostgreSQL identifier (schema name, table name).
// Wraps in double-quotes and escapes any internal double-quotes.
// Prevents SQL injection when the schema name comes from user input.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Create the ledger table this route writes to, and bring an older one up to
 * date. Idempotent — safe to re-run on every request.
 *
 * Called BEFORE BEGIN deliberately: DDL inside a transaction is fine in
 * PostgreSQL, but running it outside keeps the migration transaction focused on
 * the user's SQL and the audit INSERT. If any step here fails, the caller has
 * not issued BEGIN yet, so its catch block skips ROLLBACK and reports the setup
 * error as-is.
 *
 * Because it commits as it goes, a dry run must not call it — see the dryRun
 * guard at the call site.
 */
async function ensureScriptPatchTable(
  client: PoolClient,
  quotedSchema: string
): Promise<void> {
  // 7a. Create the table if it doesn't exist yet.
  //     Includes script_name so fresh installs get the full schema.
  //
  //     `CREATE TABLE IF NOT EXISTS` is NOT concurrency-safe at the catalog
  //     level: two first-time applies to the same brand-new schema can race
  //     here, and the loser gets a duplicate-key / "already exists" error even
  //     though the table now exists. Swallow exactly that race — the goal
  //     ("ensure the table exists") is met either way, and the real duplicate
  //     guard is the version check + advisory lock further down.
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${quotedSchema}.script_patch (
        id          SERIAL PRIMARY KEY,
        script_name VARCHAR(150) NOT NULL DEFAULT 'unknown',
        version     VARCHAR(20)  NOT NULL,
        title       VARCHAR(150),
        description TEXT,
        change_type VARCHAR(20)  NOT NULL
                      CHECK (change_type IN ('breaking', 'additive', 'patch', 'unknown')),
        source_ref  TEXT,
        sql_content TEXT,
        down_sql    TEXT,
        applied_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (setupError) {
    const m = (setupError instanceof Error ? setupError.message : String(setupError)).toLowerCase();
    if (!m.includes("already exists") && !m.includes("duplicate key")) {
      throw setupError;
    }
    // benign concurrent-creation race — the table exists, carry on.
  }

  // 7b. Add script_name to tables that were created by an older version of
  //     this app (before the column existed).  IF NOT EXISTS makes this safe
  //     to run when the column is already present.
  await client.query(`
    ALTER TABLE ${quotedSchema}.script_patch
    ADD COLUMN IF NOT EXISTS script_name VARCHAR(150) NOT NULL DEFAULT 'unknown'
  `);

  // 7b-2. Same back-fill for source_ref, added in a later version. Nullable
  //       so existing rows (and ad-hoc applies) need no value.
  await client.query(`
    ALTER TABLE ${quotedSchema}.script_patch
    ADD COLUMN IF NOT EXISTS source_ref TEXT
  `);

  // 7b-3. Back-fill sql_content (added for Version Sync / version replay): the
  //       exact SQL applied each time, so a behind schema can be brought up to
  //       an ahead one by replaying its ledger. Nullable — rows applied before
  //       this column existed simply have no stored script.
  await client.query(`
    ALTER TABLE ${quotedSchema}.script_patch
    ADD COLUMN IF NOT EXISTS sql_content TEXT
  `);

  // 7b-4. Back-fill down_sql: the script that undoes this one, recorded at
  //       apply time so the row carries its own rollback. Version Sync replays
  //       this ledger onto another schema and passes it along, which is what
  //       makes a replayed version revertable there too.
  await client.query(`
    ALTER TABLE ${quotedSchema}.script_patch
    ADD COLUMN IF NOT EXISTS down_sql TEXT
  `);

  // 7c. Add a UNIQUE index so the DB itself enforces one row per
  //     (script_name, version) pair — preventing race-condition duplicates
  //     even when two apply calls land simultaneously.
  //     Best-effort: if old rows have duplicate versions under the 'unknown'
  //     family (from before script_name existed), index creation fails here
  //     but uniqueness is still enforced by the SELECT check in step 8.
  try {
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS script_patch_name_version_idx
      ON ${quotedSchema}.script_patch (script_name, version)
    `);
  } catch {
    console.warn(
      "Apply — could not create unique index on script_patch " +
      "(existing rows may have duplicate versions under 'unknown'). " +
      "Uniqueness is still checked at INSERT time via the SELECT below."
    );
  }
}

/**
 * Run the script's `ALTER TYPE … ADD VALUE IF NOT EXISTS` statements on their
 * own, in autocommit, before the migration transaction opens.
 *
 * PostgreSQL will not let a value added by `ALTER TYPE … ADD VALUE` be USED
 * by another statement in the same transaction — it raises "unsafe use of
 * new value". Since step 8 runs the whole script as one transaction, a
 * perfectly correct migration that adds an enum label and then, say, builds
 * an index whose WHERE clause mentions it would fail halfway through.
 *
 * So those statements run first, on their own, in autocommit. Only the
 * ones written with IF NOT EXISTS qualify, which means the copy left in the
 * script turns into a no-op instead of an "already exists" error. Nothing
 * is lost if the migration later rolls back: an enum label nothing
 * references is inert, and the next run finds it already there.
 *
 * Committing is the whole point, so a dry run must not call it — see the dryRun
 * guard at the call site.
 */
async function addEnumValuesOutsideTransaction(
  client: PoolClient,
  quotedSchema: string,
  sqlContent: string
): Promise<void> {
  const enumAdditions = extractEnumAddValues(sqlContent);
  if (enumAdditions.length > 0) {
    // These statements name their type unqualified, so search_path has to
    // point at the target schema — and this is outside any transaction, so
    // SET LOCAL is not available and the session setting must be put back by
    // hand before the client returns to the pool.
    await client.query(`SET search_path TO ${quotedSchema}`);
    try {
      for (const statement of enumAdditions) {
        await client.query(statement);
      }
    } finally {
      await client.query("RESET search_path");
    }
  }
}

/**
 * Name a run in one phrase, for the messages and for the lineage node.
 *
 * A run of one keeps the wording the route has always used, so the screens that
 * show these messages read exactly as they did before runs of several existed.
 */
function describeRun(queue: ScriptJob[]): string {
  const last = queue[queue.length - 1];
  const tail = `${last.scriptName} v${last.version}`;
  return queue.length === 1 ? tail : `${queue.length} migrations (through ${tail})`;
}

/**
 * How loud the run is as a whole: the loudest change type any migration in it
 * carries.
 *
 * The lineage advance takes one change level for the whole run, and it decides
 * how the version bumps. A run holding one breaking migration is a breaking run
 * — averaging it down to the last script's level would record a minor bump over
 * a change that broke something. "patch" and "unknown" share a rank because
 * getNextLineageVersion treats them identically.
 */
const CHANGE_TYPE_RANK: Record<ChangeType, number> = {
  patch: 1,
  unknown: 1,
  additive: 2,
  breaking: 3,
};

function loudestChangeType(queue: ScriptJob[]): ChangeType {
  return queue.reduce<ChangeType>(
    (loudest, job) =>
      CHANGE_TYPE_RANK[job.changeType] > CHANGE_TYPE_RANK[loudest]
        ? job.changeType
        : loudest,
    "patch"
  );
}

/**
 * Report a run that rolled back: the migration that failed, and every other one
 * in the run marked skipped.
 *
 * Every other one — including the ones that had already run before the failure.
 * The run is a single transaction, so the ROLLBACK undid those too, and calling
 * them "applied" would send the reader looking for changes that are not there.
 */
function rolledBackOutcomes(
  queue: ScriptJob[],
  failed: ScriptJob | null,
  error: string
): ScriptOutcome[] {
  return queue.map((job) =>
    job === failed
      ? {
          script_name: job.scriptName,
          version: job.version,
          status: "failed" as const,
          error,
        }
      : {
          script_name: job.scriptName,
          version: job.version,
          status: "skipped" as const,
        }
  );
}

// Bare COMMIT / ROLLBACK detection lives in lib/sql-guard so the deploy page's
// client-side pre-check uses the exact same rule (and the dollar-quote-aware
// stripping) as this server route — see containsTransactionControl import above.

export async function POST(request: NextRequest) {
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  // ─── 1. Parse the request body ───────────────────────────────────────────
  //
  // Two shapes are accepted. `scripts: [...]` is a run of several migrations
  // applied together; the flat single-script fields are the original shape and
  // still the only one Version Sync's replay sends. Everything below treats the
  // flat form as a run of one, so there is a single code path from here down.
  let body: {
    connectionId: number;
    schemaName?: string;
    scripts?: ScriptInput[];
    script_name?: string;
    sql_content?: string;
    down_sql?: string;
    version?: string;
    title?: string;
    description?: string;
    change_type?: string;
    // The GitHub path the SQL came from (e.g. finance/public/add_invoices/v1.0.0.sql),
    // recorded so an applied row can point back to its source file. Optional —
    // applying ad-hoc SQL with no GitHub origin is still allowed.
    source_ref?: string;
    /**
     * Set by a screen only after somebody has ticked the production warning.
     * Absent or false against a production target is a refusal, not a default.
     */
    acknowledgeProduction?: boolean;
    /**
     * Run the scripts and then throw the work away instead of committing it.
     *
     * A rehearsal, not a review: the SQL really executes against the real target
     * inside the transaction that always ends in ROLLBACK, so what it reports is
     * what the database itself said, not what a parser guessed. Nothing is
     * written — no ledger rows, no lineage advance, and none of the setup DDL a
     * real apply does outside the transaction.
     */
    dryRun?: boolean;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in request body." },
      { status: 400 }
    );
  }

  const { connectionId } = body;

  // schemaName defaults to "public" but also guard against explicit empty string
  const schemaName =
    typeof body.schemaName === "string" && body.schemaName.trim().length > 0
      ? body.schemaName.trim()
      : "public";

  // A dry run rehearses the run and rolls it back. Absent or false means a real
  // apply — the flag has to be asked for explicitly, so a caller that knows
  // nothing about it keeps committing exactly as before.
  const dryRun = body.dryRun === true;

  // ─── 2. Validate every script in the run ─────────────────────────────────
  if (!connectionId) {
    return NextResponse.json(
      { error: "connectionId is required." },
      { status: 400 }
    );
  }

  const rawScripts: ScriptInput[] = Array.isArray(body.scripts)
    ? body.scripts
    : [body];

  if (rawScripts.length === 0) {
    return NextResponse.json(
      { error: "scripts must contain at least one migration." },
      { status: 400 }
    );
  }

  const queue: ScriptJob[] = [];
  // Two migrations in one run cannot share a (script_name, version) pair: the
  // second INSERT would hit the unique index halfway through and take the whole
  // run down with it. Catching it here says which two, before anything runs.
  const seenKeys = new Set<string>();

  for (let index = 0; index < rawScripts.length; index++) {
    const raw = rawScripts[index];
    // Only a multi-script run needs to say WHICH one is wrong; a run of one has
    // no ambiguity and the older message is what existing callers expect.
    const at = rawScripts.length > 1 ? ` (script ${index + 1} of ${rawScripts.length})` : "";

    if (!raw?.script_name?.trim()) {
      return NextResponse.json(
        { error: `script_name is required${at}.` },
        { status: 400 }
      );
    }
    if (!raw.sql_content?.trim()) {
      return NextResponse.json(
        { error: `sql_content is required and cannot be empty${at}.` },
        { status: 400 }
      );
    }
    if (!raw.version?.trim()) {
      return NextResponse.json(
        { error: `version is required (e.g. '1.2.0')${at}.` },
        { status: 400 }
      );
    }
    // script_patch.version is VARCHAR(20) — catch this before hitting the DB
    if (raw.version.trim().length > MAX_VERSION_LENGTH) {
      return NextResponse.json(
        { error: `version must be ${MAX_VERSION_LENGTH} characters or fewer${at}.` },
        { status: 400 }
      );
    }

    // ─── 3. Guard against embedded COMMIT / ROLLBACK in the script ─────────
    if (containsTransactionControl(raw.sql_content)) {
      return NextResponse.json(
        {
          error:
            `sql_content must not contain COMMIT or ROLLBACK statements${at}. ` +
            "The apply route wraps the run in its own transaction automatically.",
        },
        { status: 400 }
      );
    }
    // The rollback is stored, not run, but it is stored so the revert route can
    // run it later — and the revert route opens its own transaction too. Reject
    // it now rather than at revert time, when the user needs it to work.
    if (raw.down_sql && containsTransactionControl(raw.down_sql)) {
      return NextResponse.json(
        {
          error:
            `down_sql must not contain COMMIT or ROLLBACK statements${at}. ` +
            "The revert runs it in its own transaction.",
        },
        { status: 400 }
      );
    }

    const scriptName = raw.script_name.trim();
    const scriptVersion = raw.version.trim();
    const key = `${scriptName}|${scriptVersion}`;
    if (seenKeys.has(key)) {
      return NextResponse.json(
        {
          error:
            `This run lists ${scriptName} v${scriptVersion} twice. ` +
            "Each migration can appear only once.",
        },
        { status: 400 }
      );
    }
    seenKeys.add(key);

    queue.push({
      scriptName,
      version: scriptVersion,
      sqlContent: raw.sql_content,
      // Kept beside the SQL that ran so a schema this migration is later
      // replayed onto — by Version Sync, which reads this ledger — inherits the
      // rollback instead of becoming permanently non-revertable.
      downSql: raw.down_sql?.trim() || null,
      // title is VARCHAR(150) — truncate before INSERT so an over-long title
      // cannot roll back an otherwise-successful migration.
      title: (raw.title?.trim() || scriptVersion).slice(0, 150),
      description: raw.description?.trim() || null,
      // Normalise change_type — default to "unknown" if missing or invalid.
      changeType: VALID_CHANGE_TYPES.includes(raw.change_type as ChangeType)
        ? (raw.change_type as ChangeType)
        : "unknown",
      // Normalise source_ref — trim, and treat a blank string as "no source".
      sourceRef: raw.source_ref?.trim() || null,
    });
  }

  // Used by every message that names the run as a whole.
  const lastJob = queue[queue.length - 1];

  // ─── 4. Look up the saved connection from the app metadata database ───────
  // version-db is the same pool the Connections screen saves to, so a connection
  // created in the UI always resolves here. connection_string + ssl are read so
  // URI and SSL-required hosts (Neon, Supabase, RDS) can be deployed to.
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
    console.error("Apply — failed to fetch connection record:", message);
    return NextResponse.json(
      { error: "Could not read saved connection. Is the app database reachable?" },
      { status: 500 }
    );
  }

  // ─── 4b. Refuse an unconfirmed run against production ─────────────────────
  //
  // Before opening a single connection to the target. The label is the louder of
  // the connection's and the tracked schema's, the same rule both screens use to
  // decide whether to show the warning — so what the button demanded and what
  // this route requires can never drift apart.
  //
  // A tracked-schemas read that fails must not quietly downgrade the target to
  // "unset": that would turn an outage into permission. The connection's own
  // label still applies, and it is the one that says "prod" in practice.
  //
  // A dry run is gated too, deliberately. It commits nothing, but it really runs
  // the script: a migration that rewrites a large table holds ACCESS EXCLUSIVE on
  // it for the whole rewrite and only then rolls back, so "nothing was written"
  // is not the same as "nothing happened to production". Exempting rehearsals
  // would make the quiet way to lock a production table the one nobody has to
  // confirm.
  let schemaEnvironment = toEnvironment(null);
  try {
    const tracked = await findTrackedSchema(connectionId, schemaName);
    if (tracked) schemaEnvironment = tracked.environment;
  } catch (error) {
    console.error("Apply — could not read the tracked schema's environment:", error);
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

  // ─── 4c. Production needs a second person, not a second checkbox ──────────
  //
  // The acknowledgement above says "the operator knows this is production". It
  // does not say anyone else agreed, and it cannot: the same hand ticks it and
  // presses Deploy. A real run against production therefore also needs an
  // approval someone ELSE granted — see lib/approvals-db for the rule and the
  // CHECK constraint that backs it.
  //
  // Claimed BEFORE the run, not after. An approval authorises one run, so the
  // claim is what stops the same approved request being spent twice; taking it
  // first also means two operators pressing Deploy together cannot both proceed.
  // If the run does not commit, the claim is handed back in the finally block.
  //
  // A dry run is exempt. It writes nothing, and requiring a second person to
  // rehearse would make the careful path the expensive one — the acknowledgement
  // above already covers the locks a rehearsal really takes.
  let claimedApprovalId: number | null = null;
  if (isProduction(targetEnvironment) && !dryRun) {
    try {
      const claimed = await claimApproval({
        connectionId,
        schemaName,
        scripts: queue.map((job) => ({
          scriptName: job.scriptName,
          version: job.version,
          sqlContent: job.sqlContent,
        })),
      });
      if (!claimed) {
        return NextResponse.json(
          {
            error:
              `This target is labelled production, so the run needs an approval ` +
              `from someone other than you. Nothing here is approved for these ` +
              `exact ${queue.length} migration${queue.length === 1 ? "" : "s"} — ` +
              `request approval on the Deploy screen, or re-request it if the SQL ` +
              `has changed since it was approved.`,
            environment: targetEnvironment,
            needsApproval: true,
          },
          { status: 403 }
        );
      }
      claimedApprovalId = claimed.id;
    } catch (error) {
      console.error("Apply — could not claim a deploy approval:", error);
      return NextResponse.json(
        { error: "Could not check the deploy approval for this production target." },
        { status: 500 }
      );
    }
  }

  /**
   * Give a claimed approval back after a run that did not commit.
   *
   * Best-effort on purpose: the caller is already returning an error, and
   * failing to un-claim an approval must not turn a clear message about the
   * real problem into a confusing one about bookkeeping. The cost of a missed
   * release is that the second person is asked once more.
   */
  async function releaseClaimedApproval(): Promise<void> {
    if (claimedApprovalId === null) return;
    const id = claimedApprovalId;
    claimedApprovalId = null;
    try {
      await releaseApproval(id);
    } catch (error) {
      console.error("Apply — could not release deploy approval", id, error);
    }
  }

  // ─── 5. Build the target DB config (SSL/URI-aware via buildPgConfig) ──────
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
    console.error("Apply — could not connect to target DB:", message);
    // This return is outside the try/finally below, so the claim taken in 4c
    // would otherwise stay spent on a run that never opened a connection.
    await releaseClaimedApproval();
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

  // Derive the quoted schema identifier once — used in every query below.
  const quotedSchema = quoteIdent(schemaName);

  // ─── 6b. The schema has to be there ──────────────────────────────────────
  //
  // A real apply used to discover this on its way through the ledger, which
  // happens to produce a readable message. A dry run skips the ledger, so it
  // got as far as `SET search_path` — which PostgreSQL happily accepts for a
  // schema that does not exist — and then failed on the first CREATE with "no
  // schema has been selected to create in", which tells the reader nothing.
  // One check, before either path, so both say the same understandable thing.
  try {
    const exists = await client.query(
      "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
      [schemaName]
    );
    if (exists.rows.length === 0) {
      client.release();
      await releaseClaimedApproval();
      return NextResponse.json(
        {
          success: false,
          dryRun,
          schema: schemaName,
          results: queue.map((job) => ({
            script_name: job.scriptName,
            version: job.version,
            status: "skipped" as const,
          })),
          error:
            `Schema "${schemaName}" does not exist on ` +
            `${connRow.host}:${connRow.port}/${connRow.database_name}, so ` +
            `nothing was run. Create it first, or pick a different schema.`,
        },
        { status: 400 }
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Apply — could not check the target schema:", message);
    client.release();
    await releaseClaimedApproval();
    return NextResponse.json(
      { error: `Could not check whether schema "${schemaName}" exists: ${message}` },
      { status: 503 }
    );
  }

  // Track whether BEGIN has been issued so the catch block only ROLLBACK-s
  // when there is actually an active transaction to roll back.
  let transactionStarted = false;
  // Track whether the target-pool client has already been released, so the
  // finally block doesn't double-release it.
  let clientReleased = false;
  // Which migration was running when something threw, so the catch block can
  // name it instead of reporting the failure against the run as a whole. Null
  // means the run failed outside any single migration (setup, BEGIN, COMMIT).
  let failedJob: ScriptJob | null = null;
  // Whether the run actually committed. Only a commit spends the production
  // approval claimed in step 4c; every other outcome gives it back.
  let runCommitted = false;

  try {
    // ─── 7. Prepare the ledger and hoist enum additions ─────────────────────
    //
    // Both of these run OUTSIDE the run's transaction, which is exactly why a
    // dry run skips them: whatever they do is committed the moment it runs and
    // no ROLLBACK can take it back. See each function for what it does and why
    // it has to sit out here. The enum hoist reads every script in the run at
    // once, because a value added by script 1 and used by script 3 has the same
    // problem as one added and used by a single script.
    if (!dryRun) {
      await ensureScriptPatchTable(client, quotedSchema);
      await addEnumValuesOutsideTransaction(
        client,
        quotedSchema,
        queue.map((job) => job.sqlContent).join("\n")
      );
    }

    // ─── 8. Run every migration inside ONE transaction ──────────────────────
    //
    // All of them or none of them. The route used to open a transaction per
    // script, which meant a run that failed on script 3 left scripts 1 and 2
    // committed and no way back except a hand-written down script for each. One
    // transaction around the whole run makes a failure a non-event: PostgreSQL
    // undoes the DDL as readily as the DML, and the target is exactly as it was.
    //
    // The cost is honest and worth naming: the run holds its locks until the
    // last script commits rather than releasing them step by step, so a long run
    // blocks other writers for longer than it used to.
    await client.query("BEGIN");
    transactionStarted = true;

    // Fail fast instead of queueing behind someone else's lock.
    //
    // ALTER TABLE needs ACCESS EXCLUSIVE, and PostgreSQL's default is to wait
    // for it indefinitely. That wait is not quiet: the request holding the lock
    // may be a thirty-second report, but every statement that arrives after our
    // ALTER queues behind IT, so one blocked migration can stall writes to the
    // table for as long as the deploy is willing to wait — which, by default,
    // is forever. Giving up after fifteen seconds turns that into a clean
    // ROLLBACK and an error the deploy screen can show, and the operator
    // retries when the table is quiet.
    //
    // statement_timeout is deliberately NOT set alongside it: a migration that
    // rewrites a large table legitimately takes minutes, and cancelling it
    // half way is the thing this transaction exists to prevent.
    //
    // SET LOCAL, so the pooled connection goes back to the pool unchanged.
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);

    // Scope unqualified names in the migration SQL to the target schema ONLY.
    // `public` is deliberately NOT on the path: with it, an unqualified DROP/RENAME/
    // ALTER of a relation that is absent from the target would fall through and hit
    // public's same-named table — silent cross-schema data loss, especially on a
    // Version Sync replay to a schema that lacks the object. Target-only means a
    // missing relation cleanly no-ops under IF EXISTS instead. Built-in types
    // resolve via pg_catalog (always implicit); a migration needing a public
    // extension type must schema-qualify it. SET LOCAL lasts only this transaction.
    await client.query(
      `SET LOCAL search_path TO ${quotedSchema}`
    );

    // A dry run may be rehearsing against a schema that has never been deployed
    // to, where script_patch does not exist yet: a real apply would have created
    // it in step 7 and a dry run deliberately did not. So the dry run asks first
    // rather than letting the read fail. Asking is not squeamishness — inside an
    // open transaction PostgreSQL marks the WHOLE transaction aborted on any
    // error, so a failed read would leave every later statement returning 25P02
    // and the rehearsal would report nothing at all. A real apply skips the
    // question: step 7 just created the table.
    let ledgerReady = true;
    if (dryRun) {
      const ledgerProbe = await client.query<{ present: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [`${quotedSchema}.script_patch`]
      );
      ledgerReady = ledgerProbe.rows[0]?.present === true;
    }

    const outcomes: ScriptOutcome[] = [];
    let lastAppliedAt: string | null = null;

    for (const job of queue) {
      // Serialize concurrent runs of the SAME (schema, script_name, version).
      // The unique index in step 7c is best-effort (it can fail to create on
      // legacy tables with duplicate 'unknown' versions), so it cannot be the
      // ONLY guard against a double-apply race. This transaction-scoped advisory
      // lock makes the duplicate-check + INSERT below atomic regardless: a second
      // request for the same key blocks here until the first commits/rolls back,
      // then sees the committed row and returns a clean 409. Different scripts or
      // versions hash to different keys, so they never block each other. The lock
      // is released automatically when the transaction ends.
      failedJob = job;
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [schemaName, `${job.scriptName}|${job.version}`]
      );

      // Duplicate check scoped to this script family.
      // Two different script families can legitimately share the same version
      // number (e.g. users_migration v1.0.0 and products_migration v1.0.0
      // are completely independent — blocking one because of the other would
      // be wrong).
      if (ledgerReady) {
        const duplicateCheck = await client.query<{ id: number }>(
          `SELECT id
           FROM ${quotedSchema}.script_patch
           WHERE script_name = $1
             AND version     = $2
           LIMIT 1`,
          [job.scriptName, job.version]
        );

        if (duplicateCheck.rows.length > 0) {
          // The whole run comes back out. Committing the migrations before this
          // one and refusing this one would be the partial deploy the single
          // transaction exists to prevent.
          await client.query("ROLLBACK");
          transactionStarted = false;
          return NextResponse.json(
            {
              success: false,
              dryRun,
              schema: schemaName,
              results: rolledBackOutcomes(
                queue,
                job,
                "Already applied to this schema."
              ),
              error:
                `Version ${job.version} of "${job.scriptName}" has already been applied ` +
                `to schema "${schemaName}". ` +
                (queue.length > 1
                  ? "Nothing in this run was applied."
                  : "Check the script_patch table to confirm."),
            },
            { status: 409 }
          );
        }
      }

      // ─── Preconditions passed — run this migration's SQL ─────────────────
      //
      // No values array, so this goes over the simple query protocol and
      // PostgreSQL runs every statement in the string. node-postgres then hands
      // back one result per statement instead of a single result object, which
      // is what the statement count below reads.
      //
      // A failure here throws to the catch block, which rolls the whole run back
      // — including every migration already run in this loop.
      const execution = (await client.query(job.sqlContent)) as unknown as
        | PgExecResult
        | PgExecResult[];
      const statements = Array.isArray(execution) ? execution.length : 1;

      if (dryRun) {
        outcomes.push({
          script_name: job.scriptName,
          version: job.version,
          status: "rehearsed",
          statements,
        });
        continue;
      }

      // Record this migration in the audit log.
      const insertResult = await client.query<{ applied_at: string }>(
        `INSERT INTO ${quotedSchema}.script_patch
           (script_name, version, title, description, change_type, source_ref,
            sql_content, down_sql)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING applied_at`,
        [
          job.scriptName,
          job.version,
          job.title,
          job.description,
          job.changeType,
          job.sourceRef,
          job.sqlContent, // the exact SQL just executed — what version replay re-runs
          job.downSql, // and the script that undoes it, carried to wherever it is replayed
        ]
      );
      lastAppliedAt = insertResult.rows[0].applied_at;

      outcomes.push({
        script_name: job.scriptName,
        version: job.version,
        status: "applied",
        statements,
      });
    }

    failedJob = null;

    // ─── 8b. A dry run throws the work away instead of committing it ────────
    //
    // Everything above ran against the real target; nothing below it does. The
    // ROLLBACK undoes every script in the run, the advisory locks are released
    // with the transaction, and the two steps that would have outlived it — the
    // ledger INSERTs and the lineage advance — are simply never reached.
    if (dryRun) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      client.release();
      clientReleased = true;

      const totalStatements = outcomes.reduce((sum, o) => sum + (o.statements ?? 0), 0);
      return NextResponse.json({
        success: true,
        dryRun: true,
        version: lastJob.version,
        schema: schemaName,
        results: outcomes,
        // False means script_patch does not exist in this schema yet, so a real
        // apply would create it and this run would write its first rows.
        ledgerReady,
        // A real apply hoists these OUT of the transaction and commits them on
        // their own, because PostgreSQL refuses to let a value added by
        // ALTER TYPE … ADD VALUE be used in the transaction that added it. A dry
        // run cannot do that without leaving the values behind, so it ran them
        // inline — which is also why a run that USES one of its own new values
        // fails here and would succeed for real. See the 55P04 branch below.
        deferredEnumAdditions: extractEnumAddValues(
          queue.map((job) => job.sqlContent).join("\n")
        ).length,
        message:
          `Dry run of ${describeRun(queue)} completed on schema "${schemaName}" — ` +
          `${totalStatements} statement${totalStatements === 1 ? " was" : "s were"} ` +
          `run and rolled back. Nothing was written.`,
      });
    }

    // Commit — only reaches here if every migration in the run succeeded
    await client.query("COMMIT");
    transactionStarted = false;
    // The approval has now been spent on a run that really happened, so the
    // finally block must leave it marked used.
    runCommitted = true;

    // Release the target-pool connection BEFORE the lineage advance below: that
    // step re-introspects the target (drawing its own connection), so holding this
    // one meanwhile needlessly occupies a slot on the max-4 pool.
    client.release();
    clientReleased = true;

    // ─── 9. Advance lineage for TRACKED schemas (issue #12) ──────────────────
    // A sanctioned deploy must update the schema's expected baseline; otherwise
    // the next drift check compares live-vs-stale-snapshot and reports the tool's
    // own deploy as drift. Strictly best-effort: the run is already committed, so
    // a bookkeeping failure here must not fail the response. Skips itself (no-op)
    // when the schema isn't tracked.
    //
    // One advance for the whole run, named after the last migration in it: the
    // baseline it records is a re-introspection of the target, which already
    // reflects every script that just committed. Advancing once per script would
    // write a chain of nodes that all describe the same final state.
    try {
      const lineage = await recordAppliedMigrationToLineage({
        connectionId,
        schemaName,
        targetConfig,
        // "breaking|additive|patch|unknown" ⊆ ChangeLevel. The loudest level in
        // the run wins: a run holding one breaking migration is a breaking run.
        changeLevel: loudestChangeType(queue),
        name: describeRun(queue),
        sqlRef: lastJob.sourceRef,
      });
      if (lineage.advanced) {
        console.log(
          `Apply — lineage advanced to ${lineage.version} (seq ${lineage.seq}) ` +
          `for tracked schema "${schemaName}".`
        );
      }
    } catch (lineageError) {
      console.error(
        "Apply — lineage advance failed (run already applied, response unaffected):",
        lineageError
      );
    }

    return NextResponse.json({
      success: true,
      dryRun: false,
      version: lastJob.version,
      appliedAt: lastAppliedAt,
      schema: schemaName,
      results: outcomes,
      message:
        `${describeRun(queue)} applied successfully to schema "${schemaName}".`,
    });

  } catch (error) {
    // Only ROLLBACK if we actually issued a BEGIN — otherwise the database
    // is not in a transaction and ROLLBACK would just log a warning.
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Apply — ROLLBACK itself failed:", rollbackError);
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(
      dryRun ? "Apply — dry run failed:" : "Apply — script execution failed:",
      message
    );

    // A dry run that tripped over its own enum hoist has to say so, or the
    // reader reasonably concludes the script is broken when it is not. This is
    // only true when the script actually carries hoistable additions: a bare
    // ALTER TYPE … ADD VALUE without IF NOT EXISTS is never hoisted, so a real
    // apply would fail on it in exactly the same way and the caveat would be a
    // lie.
    const pgCode = (error as { code?: string }).code;
    if (
      dryRun &&
      (pgCode === UNSAFE_NEW_ENUM_VALUE ||
        message.toLowerCase().includes("unsafe use of new value")) &&
      extractEnumAddValues(queue.map((job) => job.sqlContent).join("\n")).length > 0
    ) {
      return NextResponse.json(
        {
          success: false,
          dryRun: true,
          dryRunLimitation: true,
          schema: schemaName,
          results: rolledBackOutcomes(queue, failedJob, message),
          error:
            `Dry run could not rehearse this script: it adds an enum value and then ` +
            `uses it, and PostgreSQL refuses that inside one transaction. A real ` +
            `apply adds the value first, on its own, so this is a limit of the ` +
            `rehearsal and not a fault in the script. PostgreSQL said: ${message}`,
        },
        { status: 422 }
      );
    }

    // Catch race-condition duplicates: two concurrent requests for the same
    // (script_name, version) can both pass the SELECT check above but then
    // race to INSERT.  The second INSERT hits the script_patch UNIQUE index and
    // throws 23505.  Translate ONLY that into a 409 (the script WAS applied, just
    // not by this request). A unique violation from the USER'S OWN migration DML
    // (a different constraint) means the script actually FAILED and rolled back —
    // it must surface as a 500 with the real message, not a misleading "already
    // applied".
    const constraint = (error as { constraint?: string }).constraint;
    if (pgCode === "23505" && constraint === "script_patch_name_version_idx") {
      const raced = failedJob
        ? `Version ${failedJob.version} of "${failedJob.scriptName}"`
        : "One of these migrations";
      return NextResponse.json(
        {
          success: false,
          dryRun,
          schema: schemaName,
          results: rolledBackOutcomes(queue, failedJob, "Applied by a concurrent request."),
          error:
            `${raced} was just applied by a concurrent request. ` +
            (queue.length > 1
              ? "Nothing in this run was applied. "
              : "") +
            `Check the script_patch table to confirm.`,
        },
        { status: 409 }
      );
    }

    // A lock timeout is not a broken script, and "canceling statement due to
    // lock timeout" does not tell the operator that. Say what actually
    // happened, and that trying again is the right response.
    if (pgCode === LOCK_NOT_AVAILABLE) {
      const blocked = failedJob
        ? `Version ${failedJob.version} of "${failedJob.scriptName}"`
        : "This run";
      return NextResponse.json(
        {
          success: false,
          dryRun,
          schema: schemaName,
          results: rolledBackOutcomes(queue, failedJob, "Timed out waiting for a lock."),
          error:
            `${blocked} waited ${LOCK_TIMEOUT_MS / 1000} seconds for a lock on a ` +
            `table in "${schemaName}" and gave up, so nothing was applied. ` +
            `Something else is holding that table — a long query, an open ` +
            `transaction, another deploy. Try again once it finishes.`,
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        dryRun,
        schema: schemaName,
        results: rolledBackOutcomes(queue, failedJob, message),
        error: message,
      },
      { status: 500 }
    );

  } finally {
    // Always release — whether we succeeded, failed, or hit the 409 branch —
    // unless the success path already released it before the lineage advance.
    // Without this the pool eventually runs out of connections and hangs.
    if (!clientReleased) client.release();
    // Every exit from here that is not a commit rolled the whole run back, so
    // the approval was not spent. Hand it back rather than making the second
    // person read the same migrations again.
    if (!runCommitted) await releaseClaimedApproval();
  }
}
