import { parseIntoClientConfig } from "pg-connection-string";
import type { ClientConfig, PoolClient } from "pg";
import { Pool } from "pg";

declare global {
  var __comparePgPoolMap: Map<string, Pool> | undefined;
}

function poolMap(): Map<string, Pool> {
  if (!globalThis.__comparePgPoolMap) {
    globalThis.__comparePgPoolMap = new Map();
  }
  return globalThis.__comparePgPoolMap;
}

function poolKey(cfg: ClientConfig): string {
  return [
    cfg.host ?? "",
    String(cfg.port ?? ""),
    cfg.database ?? "",
    cfg.user ?? "",
    cfg.password ?? "",
    // Encode the FULL ssl shape, not just on/off: { rejectUnauthorized: false }
    // (accept any cert) and {} (verify the cert) are different TLS behaviours
    // for the same host, so they must NOT share a pool — otherwise whichever
    // pool was created first silently wins for both callers.
    JSON.stringify(cfg.ssl ?? false),
  ].join("\0");
}

// Normalize a parsed-from-URL config's SSL so it behaves like the saved-
// connection path (buildPgConfig): when a URL carries `sslmode=require`,
// pg-connection-string yields `ssl: {}`, which makes Node verify the cert chain
// and rejects hosted providers (Neon/Supabase/RDS) that present untrusted
// chains. We only read schema metadata, so accept the cert instead — matching
// the Connections screen, which sets { rejectUnauthorized: false }.
function normalizeCompareSsl(cfg: ClientConfig): ClientConfig {
  return cfg.ssl ? { ...cfg, ssl: { rejectUnauthorized: false } } : cfg;
}

export function getPoolForConfig(cfg: ClientConfig): Pool {
  const key = poolKey(cfg);
  const map = poolMap();
  let p = map.get(key);
  if (!p) {
    p = new Pool({ ...cfg, max: 4 });
    map.set(key, p);
  }
  return p;
}

function normalizeDefinition(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// pg_get_expr renders a column DEFAULT with every referenced object schema-
// qualified when the object's schema isn't on the introspection session's
// search_path — which it never is here. So `'active'::order_status`,
// `gen_code()`, and `nextval('s')` come back as `'active'::<schema>.order_status`,
// `<schema>.gen_code()`, `nextval('<schema>.s'::regclass)`. That qualifier is
// pure noise when comparing two schemas (the same logical default differs only by
// schema name), and if emitted into a migration it binds the target column to the
// SOURCE schema's object. Strip the column's OWN schema qualifier so defaults are
// stored schema-relative; genuine cross-schema references (a different schema)
// keep their qualifier. Only strips a qualifier that directly precedes an
// identifier, in both quoted and unquoted form (pg doubles embedded quotes).
export function stripSchemaFromExpr(expr: string | null, schema: string): string | null {
  if (expr === null || !schema) return expr;
  const unquoted = schema.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = schema.replace(/"/g, '""').replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return expr
    .replace(new RegExp(`(^|[^\\w"])"${quoted}"\\.`, "g"), "$1")
    .replace(new RegExp(`(^|[^\\w"])${unquoted}\\.`, "g"), "$1");
}

/**
 * Read a `json_agg(...)` column back as an array.
 *
 * node-postgres parses a json column into real JavaScript values, but PGlite
 * (used for local verification) hands the same column back as text — the same
 * split coerceTextArray exists for.
 */
function coerceJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function coerceTextArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "{}") {
    return [];
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) {
      return [];
    }

    return inner
      .split(",")
      .map((entry) => entry.replace(/^"(.*)"$/, "$1").trim())
      .filter((entry) => entry.length > 0);
  }

  return [trimmed];
}

function formatAction(code: string | null): string {
  switch (code) {
    case "a":
      return "NO ACTION";
    case "r":
      return "RESTRICT";
    case "c":
      return "CASCADE";
    case "n":
      return "SET NULL";
    case "d":
      return "SET DEFAULT";
    default:
      return "UNKNOWN";
  }
}

/**
 * pg_constraint.confmatchtype as SQL writes it. Anything unrecognised falls
 * back to SIMPLE, which is what the parser assumes when no MATCH is written,
 * so an unknown code produces a key Postgres accepts rather than a syntax
 * error.
 */
function formatMatchType(code: string | null): "SIMPLE" | "FULL" | "PARTIAL" {
  if (code === "f") return "FULL";
  if (code === "p") return "PARTIAL";
  return "SIMPLE";
}

export type CompareTarget = {
  /**
   * A stable id for this target inside one comparison — a React key, and the
   * key its schema list is cached under while the page builds.
   *
   * This used to be the literal union "a" | "b", which made "exactly two sides"
   * a rule of the type system rather than a property of one screen. Compare now
   * runs one source against as many targets as you add, so it is a plain
   * string: "source", "target-0", "target-1", and so on.
   */
  id: string;
  config: ClientConfig;
  displayName: string;
};

/**
 * A column whose value PostgreSQL computes rather than stores what you wrote.
 *
 * This is `GENERATED ALWAYS AS (expr) STORED`, not an identity column and not a
 * serial — those two are recorded on ColumnSnapshot.identity and in the default
 * respectively. It is a separate field because the expression lives in
 * pg_attrdef, exactly where an ordinary DEFAULT lives, so reading the default
 * alone cannot tell the two apart: a generated column captured as a DEFAULT is
 * re-emitted as `DEFAULT (price * qty)`, which PostgreSQL rejects with "cannot
 * use column reference in DEFAULT expression" and aborts the whole migration.
 */
export type GeneratedColumn = {
  /**
   * STORED writes the computed value to disk. VIRTUAL (PostgreSQL 18+) computes
   * it on every read. The word is carried through rather than assumed because
   * the two are not interchangeable in DDL.
   */
  storage: "STORED" | "VIRTUAL";
  /** The expression, schema-relative, as it goes back inside GENERATED ALWAYS AS (…). */
  expression: string;
};

export type ColumnSnapshot = {
  name: string;
  ordinalPosition: number;
  typeDisplay: string;
  nullable: boolean;
  columnDefault: string | null;
  /**
   * The generation expression when this is a computed column, null otherwise.
   *
   * When this is set, columnDefault is null even though the catalog stores the
   * expression in pg_attrdef — the two are mutually exclusive in SQL and
   * splitting them here is what stops the generator writing DEFAULT.
   *
   * Optional: a snapshot stored before this field existed says nothing about
   * generated columns rather than claiming there are none, and its computed
   * columns are still sitting in columnDefault where they were captured.
   */
  generated?: GeneratedColumn | null;
  /**
   * An identity column's flavour, or null for an ordinary column.
   *
   * An identity column has NO entry in pg_attrdef, so without this it looks
   * exactly like a plain integer with no default. That made a generated
   * CREATE TABLE ... GENERATED BY DEFAULT AS IDENTITY compare as "default
   * removed" against its own source forever after.
   *
   * Optional: a snapshot stored before this field existed says nothing about
   * identity rather than claiming there is none.
   */
  identity?: "ALWAYS" | "BY DEFAULT" | null;
  isPrimaryKey: boolean;
  uniqueConstraintNames: string[];
  foreignKeyConstraintNames: string[];
};

export type ConstraintKind =
  | "PRIMARY KEY"
  | "UNIQUE"
  | "CHECK"
  | "EXCLUDE";

export type ConstraintSnapshot = {
  name: string;
  kind: ConstraintKind;
  columns: string[];
  definition: string;
  normalizedDefinition: string;
};

export type ForeignKeySnapshot = {
  name: string;
  kind: "FOREIGN KEY";
  columns: string[];
  definition: string;
  normalizedDefinition: string;
  referencedSchema: string | null;
  referencedTable: string | null;
  referencedColumns: string[];
  onUpdate: string;
  onDelete: string;
  /**
   * MATCH FULL / MATCH PARTIAL / MATCH SIMPLE, and whether the constraint is
   * deferrable or still unvalidated.
   *
   * Optional because a snapshot written before this app read them has no record
   * of them, and `undefined` has to keep meaning "not recorded" rather than
   * "SIMPLE, not deferrable, validated" — the generator would otherwise rewrite
   * an old baseline's deferrable key as a plain one.
   *
   * The comparator never looks at these: it diffs normalizedDefinition, which
   * comes from pg_get_constraintdef and already spells them out. They are here
   * for the generator, which rebuilds the key from parts and used to drop every
   * one of these clauses — so applying the migration did not remove the
   * difference and the next comparison reported it again.
   */
  matchType?: "SIMPLE" | "FULL" | "PARTIAL";
  deferrable?: boolean;
  initiallyDeferred?: boolean;
  validated?: boolean;
};

/**
 * A non-constraint index. Indexes that merely back a PRIMARY KEY or UNIQUE
 * constraint are deliberately NOT recorded here — they already appear as
 * constraints, and recording them twice makes every primary key read as two
 * separate differences.
 *
 * `columns` is a hint, not the authority: an expression index (`lower(email)`)
 * has no column entry at all, so `normalizedDefinition` is what the comparator
 * diffs on.
 */
export type IndexSnapshot = {
  name: string;
  definition: string;
  normalizedDefinition: string;
  columns: string[];
  isUnique: boolean;
  /** btree, hash, gin, gist, brin, spgist. */
  method: string;
  /** The WHERE of a partial index, schema-stripped. Null for a full index. */
  predicate: string | null;
};

/** A user trigger. Internal (constraint-implementing) triggers are excluded. */
export type TriggerSnapshot = {
  name: string;
  definition: string;
  normalizedDefinition: string;
  /** The function the trigger calls — the dependency that must exist first. */
  functionName: string;
  /** False when the trigger is disabled (pg_trigger.tgenabled = 'D'). */
  enabled: boolean;
};

/**
 * One row-level security policy: the rule that decides which rows a query is
 * allowed to see or write.
 *
 * On Supabase — which is the environment MANAGED_SCHEMAS above is written for —
 * policies ARE the authorization model for every table the anon key can reach.
 * A schema promoted as "in sync" while its policies were never compared is a
 * schema whose access rules were never checked, which is the opposite of what
 * the word "sync" promises.
 */
export type PolicySnapshot = {
  name: string;
  /** The table the policy guards. Policies are per-table, never schema-wide. */
  table: string;
  /** PERMISSIVE policies OR together; RESTRICTIVE ones AND on top. */
  permissive: boolean;
  /** ALL, SELECT, INSERT, UPDATE or DELETE. */
  command: string;
  /** The roles it applies to. `["public"]` means everybody. */
  roles: string[];
  /** The USING expression — which existing rows are visible. */
  using: string | null;
  /** The WITH CHECK expression — which new rows may be written. */
  withCheck: string | null;
  /**
   * Everything after `CREATE POLICY <name> ON <table> `, so the generator can
   * write the statement by concatenation and never has to re-derive the
   * clause order.
   */
  definition: string;
  normalizedDefinition: string;
};

/**
 * Whether row-level security is switched on for one table, and the policies
 * attached to it.
 *
 * The enable flag is separate from the policies on purpose: a table with three
 * policies and RLS switched OFF enforces none of them, and a table with RLS ON
 * and no policies denies everything to everybody except its owner. Both are
 * silent in every other part of a snapshot.
 */
export type RowSecuritySnapshot = {
  /** pg_class.relrowsecurity — ALTER TABLE … ENABLE ROW LEVEL SECURITY. */
  enabled: boolean;
  /** pg_class.relforcerowsecurity — policies apply to the table owner too. */
  forced: boolean;
  policies: PolicySnapshot[];
};

/**
 * Role names as `TO ...` wants them.
 *
 * `public` is a keyword here, not a role: PostgreSQL has no role called public,
 * so `TO "public"` fails with `role "public" does not exist` while `TO public`
 * is the "everybody" form pg_policies reports for an unrestricted policy. Same
 * for the CURRENT_USER family. Everything else is a real role name and gets
 * quoted like any other identifier.
 */
const UNQUOTED_ROLE_SPECS = new Set([
  "public",
  "current_role",
  "current_user",
  "session_user",
]);

function quoteRole(role: string): string {
  if (UNQUOTED_ROLE_SPECS.has(role.toLowerCase())) {
    return role.toLowerCase();
  }
  return `"${role.replace(/"/g, '""')}"`;
}

/**
 * Everything after `CREATE POLICY <name> ON <table> `, in the order the grammar
 * requires: AS, FOR, TO, USING, WITH CHECK.
 */
function buildPolicyDefinition(policy: {
  permissive: boolean;
  command: string;
  roles: string[];
  using: string | null;
  withCheck: string | null;
}): string {
  const parts = [
    `AS ${policy.permissive ? "PERMISSIVE" : "RESTRICTIVE"}`,
    `FOR ${policy.command}`,
  ];
  // An empty role list should never come back from the catalog, but writing
  // `TO ` with nothing after it is a syntax error rather than a wrong answer,
  // so fall back to the value pg_policies uses for "everybody".
  parts.push(`TO ${(policy.roles.length > 0 ? policy.roles : ["public"]).map(quoteRole).join(", ")}`);
  if (policy.using !== null) parts.push(`USING (${policy.using})`);
  if (policy.withCheck !== null) parts.push(`WITH CHECK (${policy.withCheck})`);
  return parts.join(" ");
}

/** A view or materialized view. */
export type ViewSnapshot = {
  name: string;
  materialized: boolean;
  definition: string;
  normalizedDefinition: string;
  columns: string[];
  /**
   * Own-schema tables and views this view reads, from pg_depend — not parsed
   * out of the definition text.
   *
   * This is what lets a generated `DROP TABLE ... CASCADE` name the views it is
   * about to take with it instead of destroying them silently.
   */
  dependsOn: string[];
};

/**
 * A sequence. Numeric fields are strings because Postgres returns int8 as a
 * string and we never do arithmetic on them — only equality.
 *
 * `ownedByTable` matters for generation: a sequence owned by a serial column is
 * created by the column's type, so emitting CREATE SEQUENCE for it would fail.
 */
export type SequenceSnapshot = {
  name: string;
  dataType: string;
  startValue: string;
  increment: string;
  minValue: string;
  maxValue: string;
  cycles: boolean;
  cacheSize: string;
  ownedByTable: string | null;
  ownedByColumn: string | null;
};

export type TypeKind = "ENUM" | "DOMAIN" | "COMPOSITE" | "RANGE";

/**
 * A user-defined type. Until this existed an enum was only a type *name*, so
 * adding a label to an enum produced no difference at all.
 */
/** One CHECK constraint on a domain: its name and its `CHECK (...)` clause. */
export type DomainCheck = {
  name: string;
  expression: string;
};

export type TypeSnapshot = {
  name: string;
  kind: TypeKind;
  /** ENUM only, in sort order. Order is significant — Postgres compares by it. */
  labels: string[];
  /** DOMAIN only. */
  baseType: string | null;
  /** DOMAIN only. */
  notNull: boolean;
  /**
   * DOMAIN only: the CHECK constraints, schema-stripped.
   *
   * The name is carried alongside the expression because ALTER DOMAIN drops a
   * check BY NAME. Without it a domain whose check changed could only ever be
   * reported as "needs manual work".
   */
  checks: DomainCheck[];
  /** COMPOSITE only: "field type" pairs in attribute order. */
  attributes: string[];
  /** A one-line human-readable rendering; this is what the comparator diffs. */
  definition: string;
  normalizedDefinition: string;
};

/**
 * A function or procedure. `signature` (name + identity arguments) is the
 * identity: Postgres allows overloads, so the name alone is not unique.
 */
export type RoutineSnapshot = {
  name: string;
  kind: "FUNCTION" | "PROCEDURE";
  identityArguments: string;
  signature: string;
  returnType: string | null;
  /**
   * Every argument name, in order — including OUT parameters and the columns of
   * a RETURNS TABLE, because renaming any of them is refused by CREATE OR
   * REPLACE just as loudly as changing the return type.
   *
   * Optional on purpose — see the note on SchemaSnapshot. `undefined` means the
   * snapshot was captured before names were recorded; `[]` means no argument
   * has one. An unnamed argument alongside named ones is an empty string.
   */
  argumentNames?: string[];
  language: string;
  definition: string;
  normalizedDefinition: string;
};

export type TableSnapshot = {
  name: string;
  columns: ColumnSnapshot[];
  primaryKey: ConstraintSnapshot | null;
  uniqueConstraints: ConstraintSnapshot[];
  foreignKeys: ForeignKeySnapshot[];
  checkConstraints: ConstraintSnapshot[];
  excludeConstraints: ConstraintSnapshot[];
  /**
   * Optional on purpose — see the note on SchemaSnapshot. `undefined` means the
   * snapshot was captured before indexes were recorded; `[]` means there are none.
   */
  indexes?: IndexSnapshot[];
  /** Optional on purpose — see the note on SchemaSnapshot. */
  triggers?: TriggerSnapshot[];
  /**
   * Row-level security for this table. Optional on purpose — see the note on
   * SchemaSnapshot: a snapshot captured before this existed must not read as
   * "RLS was off", or every tracked schema would show phantom drift.
   */
  rowSecurity?: RowSecuritySnapshot;
};

/**
 * Everything Compare knows about one schema.
 *
 * The collections added after the first release (indexes, triggers, views,
 * sequences, types, routines) are OPTIONAL, and that is load-bearing rather
 * than lazy typing.
 *
 * Lineage stores snapshots as JSONB (lib/lineage-db.ts) and nothing ever
 * rewrites a stored row, so a snapshot captured last month genuinely has no
 * record of, say, views. If a missing collection were read as `[]` the drift
 * check would compare "no views" against a live schema that has three and
 * report every one of them as newly added — every tracked schema in the system
 * would show permanent phantom drift on the day this shipped.
 *
 * So the rule the comparator follows is: a category is compared only when BOTH
 * sides recorded it. `undefined` means "not recorded, say nothing"; `[]` means
 * "recorded, and there are none". Never collapse the two with `?? []`.
 */
export type SchemaSnapshot = {
  database: string;
  schema: string;
  tables: TableSnapshot[];
  /** Views and materialized views. See the optionality note above. */
  views?: ViewSnapshot[];
  /** See the optionality note above. */
  sequences?: SequenceSnapshot[];
  /** Enums, domains, composites and ranges. See the optionality note above. */
  types?: TypeSnapshot[];
  /** Functions and procedures. See the optionality note above. */
  routines?: RoutineSnapshot[];
};

type ConstraintRow = {
  table_name: string;
  constraint_name: string;
  contype: "p" | "u" | "f" | "c" | "x";
  definition: string;
  columns: string[] | null;
  referenced_schema: string | null;
  referenced_table: string | null;
  referenced_columns: string[] | null;
  confupdtype: string | null;
  confdeltype: string | null;
  confmatchtype: string | null;
  condeferrable: boolean | null;
  condeferred: boolean | null;
  convalidated: boolean | null;
};

const COMPARE_IGNORED_TABLES = ["script_patch"];

function trimEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : undefined;
}

/**
 * The environment-variable fallback for Compare, used when there are no saved
 * connections yet. Two ways to configure:
 *
 * 1) DATABASE_URL_A + DATABASE_URL_B — full URLs, possibly different hosts/users.
 * 2) DATABASE_URL (or DATABASE_URL_A) only — same server/user/password; opens
 *    COMPARE_DATABASE_A (default "postgres") and COMPARE_DATABASE_B (default: A).
 *
 * Returns an ordered list instead of a fixed { a, b } pair. Environment
 * variables still only ever describe two databases, but the caller compares one
 * source against N targets and should not have to know where the ceiling is:
 * the first entry is the source, everything after it is a target.
 */
export function resolveCompareTargets():
  | { ok: true; targets: CompareTarget[] }
  | { ok: false; error: string } {
  const urlA = trimEnv("DATABASE_URL_A") || trimEnv("DATABASE_URL");
  const urlB = trimEnv("DATABASE_URL_B");

  if (!urlA) {
    return {
      ok: false,
      error:
        "Set DATABASE_URL in .env.local (or DATABASE_URL_A + DATABASE_URL_B for two full URLs).",
    };
  }

  try {
    if (urlB) {
      const cfgA = normalizeCompareSsl(parseIntoClientConfig(urlA));
      const cfgB = normalizeCompareSsl(parseIntoClientConfig(urlB));
      return {
        ok: true,
        targets: [
          {
            id: "env-a",
            config: cfgA,
            displayName: cfgA.database ?? "database A",
          },
          {
            id: "env-b",
            config: cfgB,
            displayName: cfgB.database ?? "database B",
          },
        ],
      };
    }

    const base = normalizeCompareSsl(parseIntoClientConfig(urlA));
    const dbA = trimEnv("COMPARE_DATABASE_A") || "postgres";
    // Default the second compare database to the first. A single-database server
    // (e.g. a Supabase project, which only exposes the "postgres" database)
    // would otherwise try to reach a non-existent "TEST" database and error. Set
    // COMPARE_DATABASE_B explicitly to compare two databases on the same server;
    // for the normal case, compare two real connections from the Connections page.
    const dbB = trimEnv("COMPARE_DATABASE_B") || dbA;
    const cfgA = { ...base, database: dbA };
    const cfgB = { ...base, database: dbB };
    return {
      ok: true,
      targets: [
        { id: "env-a", config: cfgA, displayName: dbA },
        { id: "env-b", config: cfgB, displayName: dbB },
      ],
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Invalid connection URL: ${message}` };
  }
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

export async function fetchSchemaSnapshot(
  cfg: ClientConfig,
  schemaName: string
): Promise<{ ok: true; data: SchemaSnapshot } | { ok: false; error: string }> {
  const pool = getPoolForConfig(cfg);
  const database = cfg.database ?? "(unknown)";

  type TableRow = {
    table_name: string;
  };

  type ColumnRow = {
    table_name: string;
    column_name: string;
    ordinal_position: number;
    type_display: string;
    is_nullable: boolean;
    column_default: string | null;
    /** pg_attribute.attidentity: 'a' ALWAYS, 'd' BY DEFAULT, '' not identity. */
    identity: string | null;
    /** pg_attribute.attgenerated: 's' STORED, 'v' VIRTUAL, '' not generated. */
    generated: string | null;
  };

  type IndexRow = {
    table_name: string;
    index_name: string;
    definition: string;
    is_unique: boolean;
    method: string;
    columns: string[] | null;
    predicate: string | null;
  };

  type TriggerRow = {
    table_name: string;
    name: string;
    definition: string;
    function_name: string;
    enabled: boolean;
  };

  type RowSecurityRow = {
    table_name: string;
    enabled: boolean;
    forced: boolean;
  };

  type PolicyRow = {
    table_name: string;
    name: string;
    permissive: boolean;
    command: string;
    roles: string[] | null;
    using: string | null;
    with_check: string | null;
  };

  type ViewRow = {
    name: string;
    kind: "v" | "m";
    definition: string | null;
    columns: string[] | null;
    depends_on: string[] | null;
  };

  type SequenceRow = {
    name: string;
    start_value: string;
    increment: string;
    min_value: string;
    max_value: string;
    cycles: boolean;
    cache_size: string;
    data_type: string;
    owned_by_table: string | null;
    owned_by_column: string | null;
  };

  type TypeRow = {
    name: string;
    kind: "enum" | "domain" | "composite" | "range";
    enum_labels: string[] | null;
    base_type: string | null;
    range_subtype: string | null;
    domain_not_null: boolean | null;
    domain_checks: DomainCheck[] | string | null;
    composite_fields: string[] | null;
  };

  type RoutineRow = {
    name: string;
    kind: "function" | "procedure";
    args: string;
    arg_types: string | null;
    arg_names: string[] | null;
    definition: string;
    language: string;
    returns: string | null;
  };

  // Eleven catalog queries now describe one schema, and they have to agree with
  // each other: a table that appears in the table list but whose columns were
  // read a moment later, after someone dropped it, produces a snapshot that
  // claims a table with no columns.
  //
  // The previous three queries ran on three separate pooled connections via
  // Promise.all, so each saw its own MVCC snapshot and the assembly loops
  // papered over the mismatch with `if (!table) continue`. Eleven of those would
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

    const tableResult = await client.query<TableRow>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
           AND table_type = 'BASE TABLE'
           AND table_name <> ALL($2)
         ORDER BY table_name`,
      [schemaName, COMPARE_IGNORED_TABLES]
    );

    const columnResult = await client.query<ColumnRow>(
        `SELECT
           c.table_name,
           c.column_name,
           c.ordinal_position,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS type_display,
           (c.is_nullable = 'YES') AS is_nullable,
           pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
           a.attidentity AS identity,
           a.attgenerated AS generated
         FROM information_schema.columns c
         JOIN pg_namespace n
           ON n.nspname = c.table_schema
         JOIN pg_class cls
           ON cls.relnamespace = n.oid
          AND cls.relname = c.table_name
          AND cls.relkind IN ('r', 'p')
         JOIN pg_attribute a
           ON a.attrelid = cls.oid
          AND a.attname = c.column_name
          AND a.attnum > 0
          AND NOT a.attisdropped
         LEFT JOIN pg_attrdef ad
           ON ad.adrelid = cls.oid
          AND ad.adnum = a.attnum
         WHERE c.table_schema = $1
           AND c.table_name <> ALL($2)
         ORDER BY c.table_name, c.ordinal_position`,
      [schemaName, COMPARE_IGNORED_TABLES]
    );

    const constraintResult = await client.query<ConstraintRow>(
        `SELECT
           tbl.relname AS table_name,
           con.conname AS constraint_name,
           con.contype,
           pg_get_constraintdef(con.oid, true) AS definition,
           COALESCE(
             array_agg(att.attname ORDER BY key_cols.ordinality)
             FILTER (WHERE att.attname IS NOT NULL),
             ARRAY[]::text[]
           ) AS columns,
           ref_ns.nspname AS referenced_schema,
           ref_tbl.relname AS referenced_table,
           COALESCE(
             array_agg(ref_att.attname ORDER BY ref_cols.ordinality)
             FILTER (WHERE ref_att.attname IS NOT NULL),
             ARRAY[]::text[]
           ) AS referenced_columns,
           con.confupdtype,
           con.confdeltype,
           con.confmatchtype,
           con.condeferrable,
           con.condeferred,
           con.convalidated
         FROM pg_constraint con
         JOIN pg_class tbl
           ON tbl.oid = con.conrelid
         JOIN pg_namespace ns
           ON ns.oid = tbl.relnamespace
         LEFT JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_cols(attnum, ordinality)
           ON true
         LEFT JOIN pg_attribute att
           ON att.attrelid = tbl.oid
          AND att.attnum = key_cols.attnum
         LEFT JOIN pg_class ref_tbl
           ON ref_tbl.oid = con.confrelid
         LEFT JOIN pg_namespace ref_ns
           ON ref_ns.oid = ref_tbl.relnamespace
         LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS ref_cols(attnum, ordinality)
           ON ref_cols.ordinality = key_cols.ordinality
         LEFT JOIN pg_attribute ref_att
           ON ref_att.attrelid = ref_tbl.oid
          AND ref_att.attnum = ref_cols.attnum
         WHERE ns.nspname = $1
           AND con.contype IN ('p', 'u', 'f', 'c', 'x')
           AND tbl.relname <> ALL($2)
         GROUP BY
           tbl.relname,
           con.conname,
           con.contype,
           con.oid,
           ref_ns.nspname,
           ref_tbl.relname,
           con.confupdtype,
           con.confdeltype,
           con.confmatchtype,
           con.condeferrable,
           con.condeferred,
           con.convalidated
         ORDER BY tbl.relname, con.contype, con.conname`,
      [schemaName, COMPARE_IGNORED_TABLES]
    );

    // Non-constraint indexes only. An index that backs a PRIMARY KEY or UNIQUE
    // constraint is already reported as that constraint, so including it here
    // would make every primary key show up as two separate differences — and
    // the generated migration would try to drop an index Postgres owns.
    const indexResult = await client.query<IndexRow>(
      `SELECT
         c.relname AS table_name,
         i.relname AS index_name,
         pg_get_indexdef(x.indexrelid) AS definition,
         x.indisunique AS is_unique,
         am.amname AS method,
         (SELECT array_agg(a.attname ORDER BY k.ord)
            FROM unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
            LEFT JOIN pg_attribute a
              ON a.attrelid = c.oid AND a.attnum = k.attnum) AS columns,
         pg_get_expr(x.indpred, x.indrelid) AS predicate
       FROM pg_index x
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_am am ON am.oid = i.relam
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND c.relkind IN ('r', 'p')
         AND c.relname <> ALL($2)
         AND NOT EXISTS (
           SELECT 1 FROM pg_constraint con WHERE con.conindid = x.indexrelid
         )
       ORDER BY c.relname, i.relname`,
      [schemaName, COMPARE_IGNORED_TABLES]
    );

    // NOT tgisinternal skips the hidden triggers Postgres creates to enforce
    // foreign keys — those are the FK, and are already recorded as one.
    const triggerResult = await client.query<TriggerRow>(
      `SELECT
         c.relname AS table_name,
         t.tgname AS name,
         pg_get_triggerdef(t.oid, true) AS definition,
         p.proname AS function_name,
         (t.tgenabled <> 'D') AS enabled
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = $1
         AND NOT t.tgisinternal
         AND c.relname <> ALL($2)
       ORDER BY c.relname, t.tgname`,
      [schemaName, COMPARE_IGNORED_TABLES]
    );

    // Two queries for row-level security, because the switch and the rules live
    // in different places: relrowsecurity says whether policies are enforced at
    // all, pg_policy holds the policies themselves. Reading only one of them
    // gives an answer that is confidently wrong — three policies with the
    // switch off enforce nothing.
    const rowSecurityResult = await client.query<RowSecurityRow>(
      `SELECT
         c.relname AS table_name,
         c.relrowsecurity AS enabled,
         c.relforcerowsecurity AS forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND c.relkind IN ('r', 'p')
         AND c.relname <> ALL($2)
       ORDER BY c.relname`,
      [schemaName, COMPARE_IGNORED_TABLES]
    );

    // pg_policies rather than pg_policy: it already resolves role OIDs to names
    // and runs pg_get_expr for us, and being a view owned by a superuser it is
    // readable by an ordinary login role — pg_authid underneath it is not.
    const policyResult = await client.query<PolicyRow>(
      `SELECT
         p.tablename AS table_name,
         p.policyname AS name,
         (p.permissive = 'PERMISSIVE') AS permissive,
         p.cmd AS command,
         p.roles AS roles,
         p.qual AS "using",
         p.with_check AS with_check
       FROM pg_policies p
       WHERE p.schemaname = $1
         AND p.tablename <> ALL($2)
       ORDER BY p.tablename, p.policyname`,
      [schemaName, COMPARE_IGNORED_TABLES]
    );

    // relkind 'v' = view, 'm' = materialized view. The table query above asks
    // information_schema for BASE TABLE only, which is exactly what has always
    // excluded both from the snapshot.
    const viewResult = await client.query<ViewRow>(
      `SELECT
         c.relname AS name,
         c.relkind AS kind,
         pg_get_viewdef(c.oid, true) AS definition,
         (SELECT array_agg(a.attname ORDER BY a.attnum)
            FROM pg_attribute a
           WHERE a.attrelid = c.oid
             AND a.attnum > 0
             AND NOT a.attisdropped) AS columns,
         (SELECT array_agg(DISTINCT src.relname)
            FROM pg_rewrite rw
            JOIN pg_depend dp
              ON dp.objid = rw.oid
             AND dp.classid = 'pg_rewrite'::regclass
             AND dp.refclassid = 'pg_class'::regclass
             AND dp.refobjid <> c.oid
            JOIN pg_class src
              ON src.oid = dp.refobjid
             AND src.relnamespace = c.relnamespace
           WHERE rw.ev_class = c.oid) AS depends_on
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND c.relkind IN ('v', 'm')
       ORDER BY c.relname`,
      [schemaName]
    );

    // deptype 'a' (auto) is a serial column's sequence, 'i' (internal) is an
    // IDENTITY column's. Both mean "this sequence is created by its column, do
    // not emit a CREATE SEQUENCE for it".
    const sequenceResult = await client.query<SequenceRow>(
      `SELECT
         c.relname AS name,
         s.seqstart::text AS start_value,
         s.seqincrement::text AS increment,
         s.seqmin::text AS min_value,
         s.seqmax::text AS max_value,
         s.seqcycle AS cycles,
         s.seqcache::text AS cache_size,
         format_type(s.seqtypid, NULL) AS data_type,
         d.refobjid::regclass::text AS owned_by_table,
         (SELECT a.attname
            FROM pg_attribute a
           WHERE a.attrelid = d.refobjid
             AND a.attnum = d.refobjsubid) AS owned_by_column
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_sequence s ON s.seqrelid = c.oid
       LEFT JOIN pg_depend d
         ON d.objid = c.oid
        AND d.classid = 'pg_class'::regclass
        AND d.deptype IN ('a', 'i')
       WHERE n.nspname = $1
       ORDER BY c.relname`,
      [schemaName]
    );

    // Every table has a row in pg_type for its own row type; the typrelid check
    // removes those. The pg_depend check removes types owned by an extension
    // (pgcrypto, postgis), which are installed, not authored, and would
    // otherwise diff against any schema without that extension.
    const typeResult = await client.query<TypeRow>(
      `SELECT
         t.typname AS name,
         CASE t.typtype
           WHEN 'e' THEN 'enum'
           WHEN 'd' THEN 'domain'
           WHEN 'c' THEN 'composite'
           ELSE 'range'
         END AS kind,
         CASE WHEN t.typtype = 'e' THEN (
           SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
             FROM pg_enum e WHERE e.enumtypid = t.oid
         ) END AS enum_labels,
         CASE WHEN t.typtype = 'd'
           THEN format_type(t.typbasetype, t.typtypmod) END AS base_type,
         CASE WHEN t.typtype = 'r' THEN (
           SELECT format_type(r.rngsubtype, NULL)
             FROM pg_range r WHERE r.rngtypid = t.oid
         ) END AS range_subtype,
         CASE WHEN t.typtype = 'd' THEN t.typnotnull END AS domain_not_null,
         CASE WHEN t.typtype = 'd' THEN (
           SELECT json_agg(json_build_object(
                    'name', con.conname,
                    'expression', pg_get_constraintdef(con.oid)
                  ) ORDER BY con.conname)
             -- contype 'c' only. PostgreSQL 17 records a domain's NOT NULL in
             -- pg_constraint as well as in typnotnull, and picking it up here
             -- made the generator emit both SET NOT NULL and an
             -- ADD CONSTRAINT ... NOT NULL for the same domain — the second of
             -- which is not valid syntax before 17.
             FROM pg_constraint con
            WHERE con.contypid = t.oid AND con.contype = 'c'
         ) END AS domain_checks,
         CASE WHEN t.typtype = 'c' THEN (
           SELECT array_agg(quote_ident(a.attname) || ' ' ||
                            format_type(a.atttypid, a.atttypmod)
                            ORDER BY a.attnum)
             FROM pg_attribute a
            WHERE a.attrelid = t.typrelid
              AND a.attnum > 0
              AND NOT a.attisdropped
         ) END AS composite_fields
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1
         AND t.typtype IN ('e', 'd', 'c', 'r')
         AND NOT EXISTS (
           SELECT 1 FROM pg_class c
            WHERE c.oid = t.typrelid AND c.relkind <> 'c'
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend dep
            WHERE dep.objid = t.oid AND dep.deptype = 'e'
         )
       ORDER BY t.typname`,
      [schemaName]
    );

    // prokind 'f'/'p' only: aggregates and window functions are declared, not
    // defined, and pg_get_functiondef() raises an error on them.
    const routineResult = await client.query<RoutineRow>(
      `SELECT
         p.proname AS name,
         CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
         pg_get_function_identity_arguments(p.oid) AS args,
         -- The argument TYPES on their own. pg_get_function_identity_arguments
         -- above prints the names too ("a integer"), and building the identity
         -- out of that made a function whose argument was renamed look like one
         -- function added and a different one dropped — so the script created
         -- it before dropping it and PostgreSQL refused the whole migration.
         (SELECT string_agg(format_type(u.t, NULL), ', ' ORDER BY u.ord)
            FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)) AS arg_types,
         -- proargnames rather than the printed argument list: it is already an
         -- array, so no parsing, and it stays clear of DEFAULT expressions —
         -- adding a default is something CREATE OR REPLACE is happy with.
         p.proargnames AS arg_names,
         pg_get_functiondef(p.oid) AS definition,
         l.lanname AS language,
         pg_get_function_result(p.oid) AS returns
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
       WHERE n.nspname = $1
         AND p.prokind IN ('f', 'p')
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend dep
            WHERE dep.objid = p.oid AND dep.deptype = 'e'
         )
       ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)`,
      [schemaName]
    );

    await client.query("COMMIT");

    const tablesByName = new Map<string, TableSnapshot>();

    for (const row of tableResult.rows) {
      tablesByName.set(row.table_name, {
        name: row.table_name,
        columns: [],
        primaryKey: null,
        uniqueConstraints: [],
        foreignKeys: [],
        checkConstraints: [],
        excludeConstraints: [],
        indexes: [],
        triggers: [],
        // Filled in by the two row-security loops below. Starting at
        // "off, no policies" is not a guess: every table the catalog did not
        // report a flag for genuinely has RLS off.
        rowSecurity: { enabled: false, forced: false, policies: [] },
      });
    }

    for (const row of rowSecurityResult.rows) {
      const table = tablesByName.get(row.table_name);
      if (!table?.rowSecurity) {
        continue;
      }
      table.rowSecurity.enabled = row.enabled;
      table.rowSecurity.forced = row.forced;
    }

    for (const row of policyResult.rows) {
      const table = tablesByName.get(row.table_name);
      if (!table?.rowSecurity) {
        continue;
      }

      // A policy expression names tables and functions the same way a CHECK
      // does, so it carries the same own-schema qualifier that would make two
      // identical policies in two schemas read as different.
      const using = stripSchemaFromExpr(row.using, schemaName);
      const withCheck = stripSchemaFromExpr(row.with_check, schemaName);
      const roles = coerceTextArray(row.roles);
      const definition = buildPolicyDefinition({
        permissive: row.permissive,
        command: row.command,
        roles,
        using,
        withCheck,
      });

      table.rowSecurity.policies.push({
        name: row.name,
        table: row.table_name,
        permissive: row.permissive,
        command: row.command,
        roles,
        using,
        withCheck,
        definition,
        normalizedDefinition: normalizeDefinition(definition),
      });
    }

    for (const row of columnResult.rows) {
      const table = tablesByName.get(row.table_name);
      if (!table) {
        continue;
      }

      const columnExpression = stripSchemaFromExpr(row.column_default ?? null, schemaName);
      // 'v' only ever appears on PostgreSQL 18 and up; older servers return ''
      // for every column, which reads as "not generated" and is correct there.
      const generatedStorage =
        row.generated === "s" ? "STORED" : row.generated === "v" ? "VIRTUAL" : null;

      table.columns.push({
        name: row.column_name,
        ordinalPosition: row.ordinal_position,
        // format_type() schema-qualifies a user-defined type (enum/domain/composite)
        // whose schema isn't on the introspection search_path, so `dev.order_status`
        // would falsely differ from `staging.order_status` and a generated ALTER
        // would pin the column to the SOURCE schema's type. Strip the own-schema
        // qualifier so types are schema-relative (built-in types are never qualified).
        typeDisplay: stripSchemaFromExpr(row.type_display, schemaName) ?? row.type_display,
        nullable: row.is_nullable,
        // A generated column keeps its expression in pg_attrdef, the same place a
        // DEFAULT lives, so the two are separated HERE and nowhere else. Leaving
        // it in columnDefault is what made every migration touching a generated
        // column emit `DEFAULT (price * qty)` and abort.
        columnDefault: generatedStorage === null ? columnExpression : null,
        generated:
          generatedStorage === null
            ? null
            : { storage: generatedStorage, expression: columnExpression ?? "" },
        identity:
          row.identity === "a" ? "ALWAYS" : row.identity === "d" ? "BY DEFAULT" : null,
        isPrimaryKey: false,
        uniqueConstraintNames: [],
        foreignKeyConstraintNames: [],
      });
    }

    for (const row of constraintResult.rows) {
      const table = tablesByName.get(row.table_name);
      if (!table) {
        continue;
      }

      const columns = coerceTextArray(row.columns);
      // pg_get_constraintdef schema-qualifies user types/functions and the FK's
      // referenced table. Strip the own-schema qualifier so a CHECK/EXCLUDE/FK is
      // compared and EMITTED schema-relative (else it falsely differs across two
      // schemas and pins the constraint to the source schema on apply/replay).
      const definition = stripSchemaFromExpr(row.definition, schemaName) ?? row.definition;
      const normalizedDefinition = normalizeDefinition(definition);

      if (row.contype === "p") {
        table.primaryKey = {
          name: row.constraint_name,
          kind: "PRIMARY KEY",
          columns,
          definition,
          normalizedDefinition,
        };

        for (const name of columns) {
          const column = table.columns.find((entry) => entry.name === name);
          if (column) {
            column.isPrimaryKey = true;
          }
        }
        continue;
      }

      if (row.contype === "u") {
        table.uniqueConstraints.push({
          name: row.constraint_name,
          kind: "UNIQUE",
          columns,
          definition,
          normalizedDefinition,
        });

        for (const name of columns) {
          const column = table.columns.find((entry) => entry.name === name);
          if (column) {
            column.uniqueConstraintNames.push(row.constraint_name);
          }
        }
        continue;
      }

      if (row.contype === "f") {
        const foreignKey: ForeignKeySnapshot = {
          name: row.constraint_name,
          kind: "FOREIGN KEY",
          columns,
          definition,
          normalizedDefinition,
          referencedSchema: row.referenced_schema,
          referencedTable: row.referenced_table,
          referencedColumns: coerceTextArray(row.referenced_columns),
          onUpdate: formatAction(row.confupdtype),
          onDelete: formatAction(row.confdeltype),
          matchType: formatMatchType(row.confmatchtype),
          deferrable: row.condeferrable === true,
          initiallyDeferred: row.condeferred === true,
          validated: row.convalidated !== false,
        };
        table.foreignKeys.push(foreignKey);

        for (const name of columns) {
          const column = table.columns.find((entry) => entry.name === name);
          if (column) {
            column.foreignKeyConstraintNames.push(row.constraint_name);
          }
        }
        continue;
      }

      const constraint: ConstraintSnapshot = {
        name: row.constraint_name,
        kind: row.contype === "c" ? "CHECK" : "EXCLUDE",
        columns,
        definition,
        normalizedDefinition,
      };

      if (row.contype === "c") {
        table.checkConstraints.push(constraint);
      } else {
        table.excludeConstraints.push(constraint);
      }
    }

    for (const row of indexResult.rows) {
      const table = tablesByName.get(row.table_name);
      if (!table) {
        continue;
      }

      // pg_get_indexdef() qualifies the table and any user function or type it
      // mentions, for the same reason pg_get_constraintdef() does: nothing sets
      // a search_path here. Strip the own-schema qualifier so the same index in
      // two schemas compares equal and replays into either one.
      const definition = stripSchemaFromExpr(row.definition, schemaName) ?? row.definition;

      table.indexes?.push({
        name: row.index_name,
        definition,
        normalizedDefinition: normalizeDefinition(definition),
        columns: coerceTextArray(row.columns),
        isUnique: row.is_unique,
        method: row.method,
        predicate: stripSchemaFromExpr(row.predicate ?? null, schemaName),
      });
    }

    for (const row of triggerResult.rows) {
      const table = tablesByName.get(row.table_name);
      if (!table) {
        continue;
      }

      const definition = stripSchemaFromExpr(row.definition, schemaName) ?? row.definition;

      table.triggers?.push({
        name: row.name,
        definition,
        normalizedDefinition: normalizeDefinition(definition),
        functionName: row.function_name,
        enabled: row.enabled,
      });
    }

    for (const table of tablesByName.values()) {
      table.columns.sort((a, b) => a.ordinalPosition - b.ordinalPosition);
      for (const column of table.columns) {
        column.uniqueConstraintNames.sort();
        column.foreignKeyConstraintNames.sort();
      }
      table.uniqueConstraints.sort((a, b) => a.name.localeCompare(b.name));
      table.foreignKeys.sort((a, b) => a.name.localeCompare(b.name));
      table.checkConstraints.sort((a, b) => a.name.localeCompare(b.name));
      table.excludeConstraints.sort((a, b) => a.name.localeCompare(b.name));
      table.indexes?.sort((a, b) => a.name.localeCompare(b.name));
      table.triggers?.sort((a, b) => a.name.localeCompare(b.name));
      table.rowSecurity?.policies.sort((a, b) => a.name.localeCompare(b.name));
    }

    const views: ViewSnapshot[] = viewResult.rows.map((row) => {
      const raw = row.definition ?? "";
      const definition = stripSchemaFromExpr(raw, schemaName) ?? raw;
      return {
        name: row.name,
        materialized: row.kind === "m",
        definition,
        normalizedDefinition: normalizeDefinition(definition),
        columns: coerceTextArray(row.columns),
        dependsOn: coerceTextArray(row.depends_on).sort(),
      };
    });

    const sequences: SequenceSnapshot[] = sequenceResult.rows.map((row) => ({
      name: row.name,
      dataType: row.data_type,
      startValue: row.start_value,
      increment: row.increment,
      minValue: row.min_value,
      maxValue: row.max_value,
      cycles: row.cycles,
      cacheSize: row.cache_size,
      // regclass renders as "schema.table" because nothing is on the search_path.
      ownedByTable: stripSchemaFromExpr(row.owned_by_table, schemaName),
      ownedByColumn: row.owned_by_column,
    }));

    const types: TypeSnapshot[] = typeResult.rows.map((row) => {
      const labels = coerceTextArray(row.enum_labels);
      const checks = coerceJsonArray<DomainCheck>(row.domain_checks).map((check) => ({
        name: check.name,
        expression: stripSchemaFromExpr(check.expression, schemaName) ?? check.expression,
      }));
      const attributes = coerceTextArray(row.composite_fields).map(
        (attr) => stripSchemaFromExpr(attr, schemaName) ?? attr
      );
      const baseTypeRaw = row.base_type ?? row.range_subtype;
      const baseType = stripSchemaFromExpr(baseTypeRaw, schemaName);
      const notNull = row.domain_not_null === true;

      // One readable line per type, because that is what the comparator diffs
      // and what the report shows. An enum's labels are ordered: Postgres
      // compares enum values by that order, so reordering them is a real change.
      let definition: string;
      if (row.kind === "enum") {
        definition = `ENUM (${labels.join(", ")})`;
      } else if (row.kind === "domain") {
        const parts = [`DOMAIN ${baseType ?? "?"}`];
        if (notNull) parts.push("NOT NULL");
        parts.push(...checks.map((check) => check.expression));
        definition = parts.join(" ");
      } else if (row.kind === "composite") {
        definition = `COMPOSITE (${attributes.join(", ")})`;
      } else {
        definition = `RANGE (${baseType ?? "?"})`;
      }

      return {
        name: row.name,
        kind:
          row.kind === "enum"
            ? "ENUM"
            : row.kind === "domain"
              ? "DOMAIN"
              : row.kind === "composite"
                ? "COMPOSITE"
                : "RANGE",
        labels,
        baseType,
        notNull,
        checks,
        attributes,
        definition,
        normalizedDefinition: normalizeDefinition(definition),
      } satisfies TypeSnapshot;
    });

    const routines: RoutineSnapshot[] = routineResult.rows.map((row) => {
      const definition = stripSchemaFromExpr(row.definition, schemaName) ?? row.definition;
      const identityArguments = stripSchemaFromExpr(row.args, schemaName) ?? row.args;
      // A function with no arguments has no rows to aggregate, so the subquery
      // hands back NULL rather than an empty string.
      const argumentTypes = stripSchemaFromExpr(row.arg_types ?? "", schemaName) ?? "";
      return {
        name: row.name,
        kind: row.kind === "procedure" ? "PROCEDURE" : "FUNCTION",
        identityArguments,
        // Postgres allows overloads, so the name alone is not an identity — but
        // the argument NAMES are not part of it either. Two functions cannot
        // differ by those alone, so a rename has to read as one function that
        // changed, not as two.
        signature: `${row.name}(${argumentTypes})`,
        returnType: stripSchemaFromExpr(row.returns, schemaName),
        // NULL means no argument is named at all, which is a recorded fact and
        // not a missing one — hence [] rather than undefined.
        argumentNames: row.arg_names ?? [],
        language: row.language,
        definition,
        normalizedDefinition: normalizeDefinition(definition),
      } satisfies RoutineSnapshot;
    });

    views.sort((a, b) => a.name.localeCompare(b.name));
    sequences.sort((a, b) => a.name.localeCompare(b.name));
    types.sort((a, b) => a.name.localeCompare(b.name));
    routines.sort((a, b) => a.signature.localeCompare(b.signature));

    return {
      ok: true,
      data: {
        database,
        schema: schemaName,
        tables: Array.from(tablesByName.values()).sort((a, b) =>
          a.name.localeCompare(b.name)
        ),
        views,
        sequences,
        types,
        routines,
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
    return { ok: false, error: message };
  } finally {
    client.release();
  }
}
