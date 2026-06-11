import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/version-db";
import { getPoolForConfig } from "@/lib/postgres";
import { buildPgConfig } from "@/lib/connection-config";
import { containsTransactionControl } from "@/lib/sql-guard";

// Valid values the script_patch table accepts for change_type
const VALID_CHANGE_TYPES = ["breaking", "additive", "patch", "unknown"] as const;
type ChangeType = (typeof VALID_CHANGE_TYPES)[number];

// script_patch.version is VARCHAR(20)
const MAX_VERSION_LENGTH = 20;

// Safely quote a PostgreSQL identifier (schema name, table name).
// Wraps in double-quotes and escapes any internal double-quotes.
// Prevents SQL injection when the schema name comes from user input.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Bare COMMIT / ROLLBACK detection lives in lib/sql-guard so the deploy page's
// client-side pre-check uses the exact same rule (and the dollar-quote-aware
// stripping) as this server route — see containsTransactionControl import above.

export async function POST(request: NextRequest) {
  // ─── 1. Parse the request body ───────────────────────────────────────────
  let body: {
    connectionId: number;
    script_name: string;
    sql_content: string;
    version: string;
    title?: string;
    description?: string;
    change_type?: string;
    schemaName?: string;
    // The GitHub path the SQL came from (e.g. finance/public/add_invoices/v1.0.0.sql),
    // recorded so an applied row can point back to its source file. Optional —
    // applying ad-hoc SQL with no GitHub origin is still allowed.
    source_ref?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in request body." },
      { status: 400 }
    );
  }

  const {
    connectionId,
    script_name,
    sql_content,
    version,
    title,
    description,
    change_type,
  } = body;

  // schemaName defaults to "public" but also guard against explicit empty string
  const schemaName =
    typeof body.schemaName === "string" && body.schemaName.trim().length > 0
      ? body.schemaName.trim()
      : "public";

  // ─── 2. Validate required fields ─────────────────────────────────────────
  if (!connectionId) {
    return NextResponse.json(
      { error: "connectionId is required." },
      { status: 400 }
    );
  }

  if (!script_name?.trim()) {
    return NextResponse.json(
      { error: "script_name is required." },
      { status: 400 }
    );
  }

  if (!sql_content?.trim()) {
    return NextResponse.json(
      { error: "sql_content is required and cannot be empty." },
      { status: 400 }
    );
  }

  if (!version?.trim()) {
    return NextResponse.json(
      { error: "version is required (e.g. '1.2.0')." },
      { status: 400 }
    );
  }

  // script_patch.version is VARCHAR(20) — catch this before hitting the DB
  if (version.trim().length > MAX_VERSION_LENGTH) {
    return NextResponse.json(
      { error: `version must be ${MAX_VERSION_LENGTH} characters or fewer.` },
      { status: 400 }
    );
  }

  // ─── 3. Guard against embedded COMMIT / ROLLBACK in the script ───────────
  if (containsTransactionControl(sql_content)) {
    return NextResponse.json(
      {
        error:
          "sql_content must not contain COMMIT or ROLLBACK statements. " +
          "The apply route wraps the script in its own transaction automatically.",
      },
      { status: 400 }
    );
  }

  // Normalise change_type — default to "unknown" if missing or invalid
  const resolvedChangeType: ChangeType = VALID_CHANGE_TYPES.includes(
    change_type as ChangeType
  )
    ? (change_type as ChangeType)
    : "unknown";

  // Normalise source_ref — trim, and treat a blank string as "no source".
  const resolvedSourceRef = body.source_ref?.trim() || null;

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
  };

  try {
    const result = await pool.query(
      `SELECT host, port, database_name, username, password, connection_string, ssl
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

  // ─── 5. Build the target DB config (SSL/URI-aware via buildPgConfig) ──────
  const targetPool = getPoolForConfig(
    buildPgConfig({
      host: connRow.host,
      port: connRow.port,
      database: connRow.database_name,
      user: connRow.username,
      password: connRow.password,
      connectionString: connRow.connection_string,
      ssl: Boolean(connRow.ssl),
    })
  );

  // ─── 6. Connect to the target database ───────────────────────────────────
  let client;
  try {
    client = await targetPool.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Apply — could not connect to target DB:", message);
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

  // Track whether BEGIN has been issued so the catch block only ROLLBACK-s
  // when there is actually an active transaction to roll back.
  let transactionStarted = false;

  try {
    // ─── 7. Ensure script_patch is ready (OUTSIDE the migration transaction) ─
    //
    // These three steps are idempotent — safe to re-run on every request.
    // They run BEFORE BEGIN deliberately: DDL inside a transaction is fine in
    // PostgreSQL, but running it outside keeps the migration transaction focused
    // on the user's SQL and the audit INSERT.  If any setup step fails, the
    // catch block skips ROLLBACK (transactionStarted is still false) and the
    // error message explains what went wrong.

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

    // ─── 8. Run the migration inside a transaction ────────────────────────
    await client.query("BEGIN");
    transactionStarted = true;

    // Serialize concurrent applies of the SAME (schema, script_name, version).
    // The unique index in step 7c is best-effort (it can fail to create on
    // legacy tables with duplicate 'unknown' versions), so it cannot be the
    // ONLY guard against a double-apply race. This transaction-scoped advisory
    // lock makes the duplicate-check + INSERT below atomic regardless: a second
    // request for the same key blocks here until the first commits/rolls back,
    // then sees the committed row and returns a clean 409. Different scripts or
    // versions hash to different keys, so they never block each other. The lock
    // is released automatically when the transaction ends.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [schemaName, `${script_name.trim()}|${version.trim()}`]
    );

    // Scope unqualified table names in the migration SQL to the target schema.
    // SET LOCAL lasts only for this transaction — no side effects on the pool.
    await client.query(
      `SET LOCAL search_path TO ${quotedSchema}, public`
    );

    // Duplicate check scoped to this script family.
    // Two different script families can legitimately share the same version
    // number (e.g. users_migration v1.0.0 and products_migration v1.0.0
    // are completely independent — blocking one because of the other would
    // be wrong).
    const duplicateCheck = await client.query<{ id: number }>(
      `SELECT id
       FROM ${quotedSchema}.script_patch
       WHERE script_name = $1
         AND version     = $2
       LIMIT 1`,
      [script_name.trim(), version.trim()]
    );

    if (duplicateCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return NextResponse.json(
        {
          error:
            `Version ${version.trim()} of "${script_name.trim()}" has already been applied ` +
            `to schema "${schemaName}". Check the script_patch table to confirm.`,
        },
        { status: 409 }
      );
    }

    // ─── All preconditions passed — now run the actual migration SQL ──────
    await client.query(sql_content);

    // Record this migration in the audit log.
    // title is VARCHAR(150) — truncate before INSERT to prevent a DB error
    // from rolling back an otherwise-successful migration.
    const resolvedTitle = (title?.trim() || version.trim()).slice(0, 150);

    const insertResult = await client.query<{ applied_at: string }>(
      `INSERT INTO ${quotedSchema}.script_patch
         (script_name, version, title, description, change_type, source_ref, sql_content)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING applied_at`,
      [
        script_name.trim(),
        version.trim(),
        resolvedTitle,
        description?.trim() || null,
        resolvedChangeType,
        resolvedSourceRef,
        sql_content, // the exact SQL just executed — what version replay re-runs
      ]
    );

    // Commit — only reaches here if every step above succeeded
    await client.query("COMMIT");
    transactionStarted = false;

    const appliedAt = insertResult.rows[0].applied_at;

    return NextResponse.json({
      success: true,
      version: version.trim(),
      appliedAt,
      schema: schemaName,
      message: `Script v${version.trim()} applied successfully to schema "${schemaName}".`,
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
    console.error("Apply — script execution failed:", message);

    // Catch race-condition duplicates: two concurrent requests for the same
    // (script_name, version) can both pass the SELECT check above but then
    // race to INSERT.  The second INSERT hits the UNIQUE index and throws a
    // PostgreSQL "duplicate key" / "unique constraint" error.  Translate that
    // into a 409 so the caller knows the script WAS applied, just not by this
    // request — rather than a confusing 500.
    const lc = message.toLowerCase();
    if (lc.includes("unique constraint") || lc.includes("duplicate key")) {
      return NextResponse.json(
        {
          success: false,
          error:
            `Version ${version.trim()} of "${script_name.trim()}" was just applied ` +
            `by a concurrent request. Check the script_patch table to confirm.`,
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );

  } finally {
    // Always release — whether we succeeded, failed, or hit the 409 branch.
    // Without this the pool eventually runs out of connections and hangs.
    client.release();
  }
}
