/**
 * Reading a schema: fetchSchemaSnapshot opens one read-only transaction, runs
 * the catalog readers in catalog/ in a fixed order, and puts their rows
 * together into a SchemaSnapshot. Also here: the list of schema names
 * (fetchSchemaNames, MANAGED_SCHEMAS) and withoutToolTables.
 */
import type { ClientConfig, PoolClient } from "pg";
import { buildCollations, readCollations } from "./catalog/collations";
import { addConstraints, readConstraints } from "./catalog/constraints";
import {
  buildExtensions,
  buildExtensionsElsewhere,
  readExtensions,
  readExtensionsElsewhere,
} from "./catalog/extensions";
import {
  addIndexes,
  addTriggers,
  readIndexes,
  readTriggers,
  type RelationsByName,
} from "./catalog/indexes-triggers";
import { buildPrivileges, readPrivileges } from "./catalog/privileges";
import { buildRoutines, readRoutines } from "./catalog/routines";
import {
  addPolicies,
  applyRowSecurity,
  readPolicies,
  readRowSecurity,
} from "./catalog/row-security";
import { attachSequenceOptions, buildSequences, readSequences } from "./catalog/sequences";
import {
  addColumns,
  applyPartitioning,
  readColumns,
  readPartitioning,
  readTables,
  sortTableContents,
  startTables,
} from "./catalog/tables";
import { buildTypes, readTypes } from "./catalog/user-types";
import { buildViews, readViews, sortViewContents } from "./catalog/views";
import { COMPARE_IGNORED_TABLES } from "./helpers";
import { INTROSPECTION_TIMEOUT_MS, getPoolForConfig } from "./pool";
import { SNAPSHOT_FORMAT_VERSION } from "./snapshot-format";
import type { SchemaSnapshot } from "./types";

/**
 * Strip this tool's own bookkeeping out of a snapshot that was captured before
 * the ignore list covered it.
 *
 * Live snapshots already exclude these — the queries filter them out. Stored
 * ones do not: a baseline taken while `script_patch_reverted` existed still has
 * it, so comparing that baseline against a fresh capture would report the table
 * as dropped and call it drift. Filtering both sides at read time makes an old
 * baseline agree with a new capture without rewriting anything on disk.
 */
export function withoutToolTables(snapshot: SchemaSnapshot): SchemaSnapshot {
  const ignored = new Set(COMPARE_IGNORED_TABLES);
  const ownedByIgnored = (owner: string | null | undefined) => {
    if (!owner) return false;
    // `owned_by_table` is stored as PostgreSQL renders a regclass, which is
    // schema-qualified only when the schema is outside the search path.
    const bare = owner.includes(".") ? owner.slice(owner.lastIndexOf(".") + 1) : owner;
    return ignored.has(bare.replace(/^"|"$/g, ""));
  };
  const ignoredSequences = new Set(
    (snapshot.sequences ?? [])
      .filter((seq) => ownedByIgnored(seq.ownedByTable))
      .map((seq) => seq.name)
  );

  return {
    ...snapshot,
    tables: snapshot.tables.filter((t) => !ignored.has(t.name)),
    sequences: snapshot.sequences?.filter((s) => !ignoredSequences.has(s.name)),
    privileges: snapshot.privileges?.filter(
      (p) => !ignored.has(p.objectName) && !ignoredSequences.has(p.objectName)
    ),
  };
}

// Schemas that PostgreSQL or a managed provider (Supabase, Neon, RDS) own
// internally. They are never the target of a user migration, so we hide them
// from the schema pickers — only the user's own schemas (public + anything they
// created) should show. Supabase, for example, ships auth/storage/realtime/
// vault/graphql/extensions in every database.
export const MANAGED_SCHEMAS = [
  "auth",
  "storage",
  "realtime",
  "_realtime",
  "vault",
  "graphql",
  "graphql_public",
  "extensions",
  "pgbouncer",
  "pgsodium",
  "pgsodium_masks",
  "supabase_migrations",
  "supabase_functions",
  "_analytics",
  "cron",
  "net",
];

export async function fetchSchemaNames(
  cfg: ClientConfig
): Promise<{ ok: true; data: string[] } | { ok: false; error: string }> {
  const pool = getPoolForConfig(cfg);

  try {
    const result = await pool.query<{ schema_name: string }>(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name <> 'information_schema'
         AND schema_name NOT LIKE 'pg_%'
         AND schema_name <> ALL($1::text[])
       ORDER BY schema_name`,
      [MANAGED_SCHEMAS]
    );

    return {
      ok: true,
      data: result.rows.map((row) => row.schema_name),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/**
 * `options.lockTimeoutMs`, when given, caps how long any one catalog read may
 * wait for a lock. Some of these reads lock the tables they describe, so a
 * running ALTER TABLE (or anything else holding ACCESS EXCLUSIVE) makes them
 * queue until statement_timeout. A caller that would rather say "a table is
 * locked" quickly than wait 30 seconds passes this. On failure, `code` is the
 * SQLSTATE PostgreSQL sent, when it sent one (55P03 for a lock wait, 57014
 * for a timeout).
 */
export async function fetchSchemaSnapshot(
  cfg: ClientConfig,
  schemaName: string,
  options: { lockTimeoutMs?: number } = {}
): Promise<{ ok: true; data: SchemaSnapshot } | { ok: false; error: string; code?: string }> {
  const pool = getPoolForConfig(cfg);
  const database = cfg.database ?? "(unknown)";

  // Thirteen catalog queries now describe one schema, and they have to agree with
  // each other: a table that appears in the table list but whose columns were
  // read a moment later, after someone dropped it, produces a snapshot that
  // claims a table with no columns.
  //
  // The previous three queries ran on three separate pooled connections via
  // Promise.all, so each saw its own MVCC snapshot and the assembly loops
  // papered over the mismatch with `if (!table) continue`. Thirteen of those would
  // also overflow the pool's `max: 4` and start queueing anyway, so there is no
  // parallelism left to lose. One connection inside a REPEATABLE READ READ ONLY
  // transaction is both consistent and cheaper on the pool: every query below
  // sees the exact same instant, and the transaction cannot write.
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    // Catalog reads are normally milliseconds, but "normally" assumes the
    // database is answering. A sleeping serverless compute, a schema with tens
    // of thousands of objects, or a catalog read queued behind someone else's
    // DDL can all leave a query hanging with nothing to show the user, and pg's
    // own default is no limit at all. SET LOCAL scopes it to this transaction,
    // so the pooled connection goes back unchanged for the next borrower.
    await client.query(`SET LOCAL statement_timeout = ${INTROSPECTION_TIMEOUT_MS}`);
    // Only a whole number of milliseconds reaches the SQL text, so nothing a
    // caller passes can change the statement.
    const lockTimeout = options.lockTimeoutMs;
    if (typeof lockTimeout === "number" && Number.isInteger(lockTimeout) && lockTimeout > 0) {
      await client.query(`SET LOCAL lock_timeout = ${lockTimeout}`);
    }

    // The catalog reads, one after another on the one connection. Each reader
    // (catalog/*.ts) holds its own query; the order here is the order they run.
    const tableRows = await readTables(client, schemaName);
    const columnRows = await readColumns(client, schemaName);
    const constraintRows = await readConstraints(client, schemaName);
    const indexRows = await readIndexes(client, schemaName);
    const triggerRows = await readTriggers(client, schemaName);
    const partitioningRows = await readPartitioning(client, schemaName);
    const rowSecurityRows = await readRowSecurity(client, schemaName);
    const policyRows = await readPolicies(client, schemaName);
    const viewRows = await readViews(client, schemaName);
    const sequenceRows = await readSequences(client, schemaName);
    const typeRows = await readTypes(client, schemaName);
    const extensionRows = await readExtensions(client, schemaName);
    const extensionElsewhereRows = await readExtensionsElsewhere(client, schemaName);
    const collationRows = await readCollations(client, schemaName);
    const routineRows = await readRoutines(client, schemaName);
    const privilegeRows = await readPrivileges(client, schemaName);

    await client.query("COMMIT");

    // Putting the rows together. The order matters: constraints mark columns,
    // so the columns go in first, and indexes and triggers need the views.
    const tablesByName = startTables(tableRows);
    applyPartitioning(tablesByName, partitioningRows);
    applyRowSecurity(tablesByName, rowSecurityRows);
    addPolicies(tablesByName, policyRows, schemaName);
    addColumns(tablesByName, columnRows, schemaName);
    addConstraints(tablesByName, constraintRows, schemaName);

    const views = buildViews(viewRows, schemaName);

    // Built here, before the two steps that use it, because an index or a
    // trigger can hang off a view as readily as off a table and the steps
    // should not have to care which they found. A schema cannot hold a table
    // and a view of the same name, so one map over both is unambiguous.
    const relationsByName: RelationsByName = new Map();
    for (const [name, table] of tablesByName) relationsByName.set(name, table);
    for (const view of views) relationsByName.set(view.name, view);
    addIndexes(relationsByName, indexRows, schemaName);
    addTriggers(relationsByName, triggerRows, schemaName);

    sortTableContents(tablesByName);
    sortViewContents(views);

    const sequences = buildSequences(sequenceRows, schemaName);
    attachSequenceOptions(sequences, tablesByName, schemaName);

    const types = buildTypes(typeRows, schemaName);
    const collations = buildCollations(collationRows);
    const extensions = buildExtensions(extensionRows);
    const extensionsElsewhere = buildExtensionsElsewhere(extensionElsewhereRows);
    const privileges = buildPrivileges(privilegeRows, schemaName);
    const routines = buildRoutines(routineRows, schemaName);

    views.sort((a, b) => a.name.localeCompare(b.name));
    sequences.sort((a, b) => a.name.localeCompare(b.name));
    types.sort((a, b) => a.name.localeCompare(b.name));
    collations.sort((a, b) => a.name.localeCompare(b.name));
    extensions.sort((a, b) => a.name.localeCompare(b.name));
    routines.sort((a, b) => a.signature.localeCompare(b.signature));
    privileges.sort(
      (a, b) =>
        a.objectKind.localeCompare(b.objectKind) ||
        a.objectName.localeCompare(b.objectName) ||
        (a.identityArguments ?? "").localeCompare(b.identityArguments ?? "")
    );

    return {
      ok: true,
      data: {
        formatVersion: SNAPSHOT_FORMAT_VERSION,
        database,
        schema: schemaName,
        tables: Array.from(tablesByName.values()).sort((a, b) =>
          a.name.localeCompare(b.name)
        ),
        views,
        sequences,
        types,
        collations,
        routines,
        extensions,
        extensionsElsewhere,
        privileges,
      },
    };
  } catch (e) {
    // The transaction may or may not still be open depending on where this
    // threw; rolling back a finished one is harmless, so just try.
    try {
      await client.query("ROLLBACK");
    } catch {
      // Nothing useful to do — the real error is the one being returned.
    }
    const message = e instanceof Error ? e.message : String(e);
    // pg puts the SQLSTATE on the error as `code`; passed on so a caller can
    // tell a lock wait or a timeout from a broken connection.
    const code = (e as { code?: unknown } | null)?.code;
    return typeof code === "string" ? { ok: false, error: message, code } : { ok: false, error: message };
  } finally {
    client.release();
  }
}
