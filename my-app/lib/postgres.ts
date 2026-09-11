import type { ClientConfig, PoolClient } from "pg";
import { Pool } from "pg";
import { SNAPSHOT_FORMAT_VERSION } from "./snapshot-format";

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

/**
 * Connections this app will open to any ONE target database.
 *
 * Deliberately small. These are other people's databases — a Supabase or Neon
 * free tier tops out around fifteen connections for every client combined, and
 * a comparison tool that eats a third of that budget is a bad guest. Reading a
 * schema is one connection held for one transaction, so a bigger pool would buy
 * parallelism the databases cannot afford.
 *
 * Callers that want several jobs at once size themselves against this number
 * rather than raising it: see COMPARE_TARGET_CONCURRENCY in lib/compare-run.ts.
 */
export const POOL_MAX = 6;

/**
 * How long `pool.connect()` waits for a free connection before giving up.
 *
 * Without it, a caller that asks for a connection the pool cannot supply waits
 * forever and the request hangs with no error anywhere — the worst possible
 * failure for a screen whose job is to tell you what is wrong. Ten seconds is
 * long enough to cover a TLS handshake to a sleeping serverless database and
 * short enough that a wedged pool reports itself instead of timing out at the
 * browser.
 */
const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * How long an unused connection sits open before the pool closes it.
 *
 * pg's own default is 10s; 30s here because the studio's screens come in
 * bursts — open Compare, look, run it again — and reconnecting to a hosted
 * database costs a full TLS handshake each time.
 */
const IDLE_TIMEOUT_MS = 30_000;

/**
 * Ceiling on any single catalog query in fetchSchemaSnapshot.
 *
 * Generous on purpose — introspecting a large schema is real work, and a
 * comparison that gives up on a slow-but-healthy database is worse than one
 * that takes a moment. This is a backstop against hanging, not a performance
 * budget.
 */
const INTROSPECTION_TIMEOUT_MS = 30_000;

export function getPoolForConfig(cfg: ClientConfig): Pool {
  const key = poolKey(cfg);
  const map = poolMap();
  let p = map.get(key);
  if (!p) {
    p = new Pool({
      ...cfg,
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
    });
    // A pool with no 'error' listener crashes the process when an idle
    // connection drops — and hosted databases drop idle connections routinely.
    // Log it and let the pool discard the client; the next caller gets a fresh
    // one, which is exactly what the pool is for.
    p.on("error", (error) => {
      console.error(`Idle connection to ${cfg.host ?? "?"} failed:`, error.message);
    });
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

/**
 * A JSON value that is a non-empty string, or null.
 *
 * Used on catalog columns read through to_jsonb, where a column the server
 * version does not have comes back `undefined` rather than raising an error —
 * which is the whole reason those columns are read that way.
 */
function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A SQL string literal, for values that go in a statement rather than names. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * pg_collation.collprovider, spelled the way CREATE COLLATION spells it.
 *
 * 'b' (builtin) only exists from PostgreSQL 17, and an unknown letter from a
 * newer server is reported as the database default rather than guessed at.
 */
function collationProvider(code: string): CollationProvider {
  if (code === "i") return "icu";
  if (code === "c") return "libc";
  if (code === "b") return "builtin";
  return "default";
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
  /**
   * The settings of the sequence this column draws its values from — an
   * identity column's, or the one behind a `serial` — and null for a column
   * that draws from no sequence at all.
   *
   * The sequence itself is in `SchemaSnapshot.sequences`, but the comparison
   * skips every sequence a column owns: it is created by the column and dropped
   * with it, so reporting it as well would show one added serial column as two
   * differences. The settings were therefore captured and then thrown away, and
   * `START WITH 100 INCREMENT BY 5` against `START WITH 1 INCREMENT BY 1` — the
   * difference between two shards handing out interleaved ids and both handing
   * out the same ones — compared as an exact match.
   *
   * Optional for the usual reason: a snapshot captured before this app read
   * them has no record, which is not the same as a column having none.
   */
  sequenceOptions?: SequenceOptions | null;
  /**
   * The column's own collation, ready to go straight after the type in DDL —
   * `"C"`, `"und-x-icu"`, `"ci"` — or null when it uses its type's default.
   *
   * format_type() renders the TYPE and nothing else, so a collation is invisible
   * in typeDisplay: `email text COLLATE "C"` and plain `email text` compared as
   * an exact match, and a CREATE TABLE written from the first produced the
   * second. Collation decides ordering and equality, so under a nondeterministic
   * one that also changes which rows a UNIQUE constraint will accept.
   *
   * Optional: a snapshot stored before this field existed says nothing about
   * collation rather than claiming every column is on its type default — which
   * would make the generator strip a collation the target legitimately has.
   */
  collation?: string | null;
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

/**
 * A column's collation as it goes back into DDL, or null for the type default.
 *
 * pg_catalog is always on the search_path, so its collations are written bare
 * ("C", "und-x-icu") the way the type names beside them are. A collation in the
 * schema being captured is stripped of its qualifier for the same reason
 * typeDisplay is: `dev."ci"` and `staging."ci"` are the same collation seen from
 * two schemas, and leaving the qualifier on would report a difference that isn't
 * one — and pin the generated DDL to the source schema.
 */
function formatCollation(
  collationSchema: string | null,
  collationName: string | null,
  schemaName: string
): string | null {
  if (collationName === null) return null;
  const quoted = `"${collationName.replace(/"/g, '""')}"`;
  if (collationSchema === null || collationSchema === "pg_catalog") return quoted;
  const qualified = `"${collationSchema.replace(/"/g, '""')}"."${collationName.replace(/"/g, '""')}"`;
  return stripSchemaFromExpr(qualified, schemaName) ?? qualified;
}

/**
 * The order GRANT lists privileges in, which is the order PostgreSQL's own
 * documentation lists them in.
 *
 * A fixed order rather than alphabetical, so `SELECT, INSERT, UPDATE` reads the
 * way somebody would type it — and so the same set of privileges always renders
 * to the same string, which is what the comparison actually compares.
 */
const PRIVILEGE_ORDER = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
  "USAGE",
  "CREATE",
  "EXECUTE",
  "CONNECT",
  "TEMPORARY",
  "SET",
  "ALTER SYSTEM",
];

function sortPrivileges(privileges: string[]): string[] {
  return [...privileges].sort((a, b) => {
    const ai = PRIVILEGE_ORDER.indexOf(a);
    const bi = PRIVILEGE_ORDER.indexOf(b);
    // A privilege a future PostgreSQL adds is unknown to the list above; it
    // sorts to the end rather than to the front, where it would silently
    // reorder every existing rendering.
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

/**
 * The one-line rendering the comparison diffs, e.g.
 * `owned by "app" — "api": SELECT, INSERT; PUBLIC: SELECT (SELECT grantable)`.
 */
function buildPrivilegeDefinition(
  owner: string,
  grants: PrivilegeGrant[]
): string {
  const head = `owned by ${quoteRole(owner)}`;
  if (grants.length === 0) return `${head} — no grants to anybody else`;
  const parts = grants.map((grant) => {
    const passOn =
      grant.grantable.length > 0
        ? ` (may pass on ${grant.grantable.join(", ")})`
        : "";
    return `${quoteRole(grant.grantee)}: ${grant.privileges.join(", ")}${passOn}`;
  });
  return `${head} — ${parts.join("; ")}`;
}

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
  /**
   * The view's `WITH (...)` settings, exactly as pg_class.reloptions stores
   * them — `security_invoker=true`, `check_option=cascaded`,
   * `security_barrier=true`, and a materialized view's storage settings.
   * Sorted, so two views that set the same options in a different order still
   * compare equal.
   *
   * pg_get_viewdef returns the SELECT body ALONE, so without this two views
   * with the same query but opposite security_invoker settings compared equal —
   * and `CREATE OR REPLACE VIEW` with no WITH clause does not merely fail to
   * add the option, it REPLACES the option list, so recreating a view that a
   * CASCADE took stripped `security_invoker` off it on the way back.
   *
   * Optional: a snapshot captured before this app read reloptions has no record
   * of them, and reading that as "no options" would report every view in it as
   * changed.
   */
  options?: string[];
  /**
   * Indexes on this view. Only a materialized view can have any: it stores its
   * result set, so PostgreSQL indexes it the way it indexes a table.
   *
   * Not a detail. REFRESH MATERIALIZED VIEW CONCURRENTLY REQUIRES a unique
   * index, so a matview recreated without one can only be refreshed by locking
   * it against every reader for the length of the rebuild — and the migration
   * that dropped and rebuilt the matview is what took the index away.
   *
   * Optional for the usual reason: a snapshot captured before this app read
   * them has no record, which is not the same as there being none.
   */
  indexes?: IndexSnapshot[];
  /**
   * Triggers on this view, which in practice means INSTEAD OF triggers.
   *
   * They are the entire reason a view can be written to. A view with three of
   * them accepts INSERT, UPDATE and DELETE; the same view without them rejects
   * all three. The trigger query has always returned these rows — nothing
   * filtered them by relkind — and the loop that files them away simply had
   * nowhere to put a row belonging to a view, so it dropped them.
   */
  triggers?: TriggerSnapshot[];
};

/**
 * The knobs a sequence hands out numbers by. Numeric fields are strings because
 * Postgres returns int8 as a string and we never do arithmetic on them — only
 * equality, and the odd BigInt comparison of a bound.
 *
 * Split out from the sequence itself because they are not only a sequence's:
 * `GENERATED ALWAYS AS IDENTITY (START WITH 100 INCREMENT BY 5)` and a `serial`
 * column whose sequence was later ALTERed both configure exactly these, and a
 * column that draws its values from a sequence carries them in
 * ColumnSnapshot.sequenceOptions.
 */
export type SequenceOptions = {
  dataType: string;
  startValue: string;
  increment: string;
  minValue: string;
  maxValue: string;
  cycles: boolean;
  cacheSize: string;
};

/**
 * A sequence: its settings, plus who it belongs to.
 *
 * `ownedByTable` matters for generation: a sequence owned by a serial column is
 * created by the column's type, so emitting CREATE SEQUENCE for it would fail.
 */
export type SequenceSnapshot = SequenceOptions & {
  name: string;
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

/**
 * The parts of a range type that CREATE TYPE ... AS RANGE names, beyond the
 * subtype.
 *
 * Optional on the snapshot, and deliberately kept out of `definition` unless
 * one of them was actually chosen: a range with none of them reads exactly as
 * it did before any of this was captured, so a snapshot stored back then still
 * compares equal to a fresh one instead of reporting drift that never happened.
 */
export type RangeDetails = {
  /**
   * The subtype's B-tree operator class, but only when it is NOT that type's
   * default. The default is what CREATE TYPE picks on its own, so writing it
   * out would say nothing and would change the definition of every range type
   * already recorded.
   */
  subtypeOpclass: string | null;
  /** The collation the bounds are compared with, when the range names one. */
  collation: string | null;
  /** The canonical function, or null. See needsManualCreate. */
  canonical: string | null;
  /** The subtype_diff function, schema-qualified only when it has to be. */
  subtypeDiff: string | null;
  /**
   * The multirange type's name, but only when it is not the `<range>_multirange`
   * PostgreSQL would have chosen. Null on a server older than 14, which has no
   * multiranges at all.
   */
  multirangeName: string | null;
  /**
   * True when this range cannot be created from the snapshot alone.
   *
   * Two things put it there. A canonical function takes and returns the range
   * type itself, so it cannot exist until the type does — that pair needs a
   * shell type and three statements in a particular order. And a subtype_diff
   * this schema owns is a function the generator writes out after the tables,
   * long after the type that would name it. Either way the CREATE TYPE would
   * stop the migration, so the generator writes a note instead of a statement.
   */
  needsManualCreate: boolean;
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
  /**
   * RANGE only. Undefined on a snapshot captured before ranges were recorded
   * in this detail, which is not the same as a range with no options — see the
   * optionality note on SchemaSnapshot.
   */
  rangeDetails?: RangeDetails;
  /** A one-line human-readable rendering; this is what the comparator diffs. */
  definition: string;
  normalizedDefinition: string;
};

// Moved to lib/snapshot-facts so the screens can ask it without importing this
// module — importing a VALUE from here pulls the node-only `pg` client into the
// browser bundle. Re-exported so the server-side callers read the same way.
export { rangeTypeIsCreatable } from "./snapshot-facts";

/**
 * Which library decides how a collation sorts and compares.
 *
 *   icu     — an ICU locale, the only provider that can be nondeterministic
 *   libc    — the operating system's locale, named by LC_COLLATE / LC_CTYPE
 *   builtin — PostgreSQL's own C / C.UTF-8, added in 17
 *   default — the database's collation, inherited rather than declared
 */
export type CollationProvider = "icu" | "libc" | "builtin" | "default";

/**
 * A collation the schema owns.
 *
 * A column's collation is captured (see ColumnSnapshot.collation) and written
 * back out as `COLLATE "ci"`, which names a collation the target schema has to
 * have. Without this the generated CREATE TABLE referred to something that was
 * never created, and the migration stopped on it.
 *
 * The library version (pg_collation.collversion) is deliberately NOT recorded.
 * It is the ICU or OS version the collation was defined against, so two servers
 * on different machines report different values for the same collation — and a
 * comparison would call that drift when nothing in either schema moved.
 */
export type CollationSnapshot = {
  name: string;
  provider: CollationProvider;
  /**
   * False only for an ICU collation created with `deterministic = false`, where
   * two different strings can compare equal. That decides which rows a UNIQUE
   * constraint accepts, so it is part of the definition and not a detail.
   */
  deterministic: boolean;
  /** ICU and builtin: the locale. libc leaves this null and uses the pair below. */
  locale: string | null;
  /** libc only: LC_COLLATE. */
  lcCollate: string | null;
  /** libc only: LC_CTYPE. */
  lcCtype: string | null;
  /** ICU only, PostgreSQL 16+: custom tailoring rules. */
  rules: string | null;
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

/**
 * An extension installed INTO this schema.
 *
 * Schema-scoped like everything else here: an extension has a namespace
 * (pg_extension.extnamespace), and the one installed into the schema being
 * compared is the one that belongs to it. An extension living in some other
 * schema of the same database is that schema's business.
 *
 * Worth capturing because everything an extension brings with it is
 * deliberately filtered out of this snapshot — its types, its collations and
 * its functions all carry a pg_depend row of deptype 'e' and are skipped, on
 * the grounds that they are installed rather than authored. That is the right
 * call, but without the extension itself the skipping was silent: a schema
 * with `CREATE EXTENSION citext` and an `email citext` column compared clean
 * against a schema with neither, and the generated migration stopped on
 * `type "citext" does not exist`.
 */
export type ExtensionSnapshot = {
  name: string;
  /** pg_extension.extversion, e.g. "1.6". A string — versions are not numbers. */
  version: string;
  /** A one-line human-readable rendering; this is what the comparator diffs. */
  definition: string;
  normalizedDefinition: string;
};

/**
 * One grantee's access to one object.
 *
 * `privileges` is what GRANT lists after the word GRANT, in the order GRANT
 * lists them, so the comparison and the statement that fixes it read the same
 * way round.
 */
export type PrivilegeGrant = {
  /** A role name, or the word PUBLIC — which is what grantee 0 means. */
  grantee: string;
  /** SELECT, INSERT, USAGE, EXECUTE and so on. Never empty. */
  privileges: string[];
  /**
   * Those of the above this grantee may hand on to somebody else.
   *
   * Recorded rather than dropped because WITH GRANT OPTION is the difference
   * between one role reading a table and one role deciding who else may. Two
   * schemas that differ only in that are not the same schema.
   */
  grantable: string[];
};

/** The object kinds GRANT has a word for, spelled the way GRANT spells them. */
export type PrivilegeObjectKind =
  | "TABLE"
  | "VIEW"
  | "MATERIALIZED VIEW"
  | "SEQUENCE"
  | "FUNCTION"
  | "PROCEDURE"
  | "SCHEMA";

/**
 * Who owns one object, and who has been granted what on it.
 *
 * Kept as one flat list on the snapshot rather than hung off each table, view
 * and routine, because the schema ITSELF has an owner and a set of grants —
 * and without USAGE on the schema every other grant in it is unreachable, so
 * the one entry that matters most has nowhere else to live.
 *
 * This is the difference the comparison was blindest to. Two schemas with the
 * same tables, columns, constraints and indexes but a `GRANT SELECT` on one
 * side and nothing on the other came out as an exact match, so a sync could
 * report "in sync" over a target the application cannot read a row from. The
 * schema was identical; the database was not usable.
 *
 * Grants are recorded for every object the schema owns, INCLUDING the sequence
 * behind a `serial` or IDENTITY column, which is skipped everywhere else in
 * this snapshot. It is skipped there because its column already describes it —
 * but nothing about the column says who may call nextval on it, and a role
 * with INSERT on the table and no USAGE on the sequence cannot insert a row.
 */
export type PrivilegeSnapshot = {
  objectKind: PrivilegeObjectKind;
  /**
   * The object's own name, unquoted and WITHOUT a routine's argument list.
   *
   * The arguments live in `identityArguments` rather than being glued on here,
   * because the generator has to quote the name and must not quote the
   * arguments — `GRANT EXECUTE ON FUNCTION "f"(integer)`. Anything that wants
   * the two together, for display or for identity, joins them itself.
   */
  objectName: string;
  /**
   * A routine's argument types as PostgreSQL spells them, e.g. `integer, text`.
   * An empty string for a routine that takes none; undefined for every other
   * kind, which has no arguments to have.
   *
   * This is what tells two overloads of one function apart, so it is part of
   * the identity the comparison matches on and not only decoration.
   */
  identityArguments?: string;
  /** pg_get_userbyid of the object's owner. */
  owner: string;
  /**
   * Everyone with access, sorted by grantee, WITHOUT the owner's own entry.
   *
   * The owner is dropped because PostgreSQL materialises its full default set
   * into the ACL the moment anybody else is granted anything, so a table with
   * one GRANT would otherwise differ from an untouched one by the owner's
   * seven implicit privileges as well as by the real grant — and because that
   * set gains a member between major versions (MAINTAIN arrived in 17), which
   * would make every object differ across a version upgrade.
   *
   * The cost is a REVOKE taken off the owner itself, which is rare enough and
   * strange enough that reporting it is worth less than the noise above.
   */
  grants: PrivilegeGrant[];
  /** A one-line human-readable rendering; this is what the comparator diffs. */
  definition: string;
  normalizedDefinition: string;
};

/**
 * How a table relates to other tables it shares its rows or its shape with.
 *
 * Declarative partitioning and old-style INHERITS are both recorded here
 * because both are invisible in every other part of a snapshot: columns,
 * constraints and indexes all read exactly the same on a partition as on a
 * standalone table. Without this, a source `events` declared
 * PARTITION BY RANGE (created_at) compared equal to a plain `events` in the
 * target and the report said "Exact table name match with identical
 * structure" — a false statement, not merely a missing one — while the
 * generated CREATE TABLE quietly produced three disconnected tables.
 */
export type TablePartitioning = {
  /** "RANGE" | "LIST" | "HASH" when this table is a partitioned parent. */
  strategy: string | null;
  /** The parent's key, e.g. `RANGE (created_at)`. Null when not partitioned. */
  key: string | null;
  /** The table this is a partition OF. Null when it is not a partition. */
  partitionOf: string | null;
  /** `FOR VALUES ...` or `DEFAULT`, as PostgreSQL writes it. */
  bounds: string | null;
  /**
   * Old-style INHERITS parents. Empty for a partition — a partition's parent
   * is in `partitionOf`, and putting it in both would make the generator emit
   * PARTITION OF and INHERITS for the same table, which is a syntax error.
   */
  inherits: string[];
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
  /**
   * Partitioning and inheritance. Optional on purpose — see the note on
   * SchemaSnapshot: a snapshot captured before this existed must not read as
   * "this table was standalone", or every partitioned schema would show
   * phantom drift the day it shipped.
   */
  partitioning?: TablePartitioning;
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
  /**
   * Which generation of the capture wrote this snapshot — see
   * lib/snapshot-format.ts.
   *
   * Optional for the same reason every collection below is: the snapshots
   * already stored in `snapshots` were written before this field existed and
   * nothing rewrites them, so `undefined` has to keep meaning "captured before
   * stamping" rather than "version zero". Never compared — a stored baseline
   * and a live capture differing here is the normal case, not drift.
   */
  formatVersion?: number;
  database: string;
  schema: string;
  tables: TableSnapshot[];
  /** Views and materialized views. See the optionality note above. */
  views?: ViewSnapshot[];
  /** See the optionality note above. */
  sequences?: SequenceSnapshot[];
  /** Enums, domains, composites and ranges. See the optionality note above. */
  types?: TypeSnapshot[];
  /**
   * Collations the schema owns. Its own list rather than part of `types`,
   * because a snapshot taken before collations were captured already HAS a
   * `types` array — folding them in would make that snapshot claim the schema
   * has no collations, and report every collation in the other one as newly
   * added. See the optionality note above.
   */
  collations?: CollationSnapshot[];
  /** Functions and procedures. See the optionality note above. */
  routines?: RoutineSnapshot[];
  /** Extensions installed into this schema. See the optionality note above. */
  extensions?: ExtensionSnapshot[];
  /**
   * Ownership and grants, one entry per object plus one for the schema
   * itself. See the optionality note above.
   */
  privileges?: PrivilegeSnapshot[];
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

// Bookkeeping this tool writes into the schemas it manages. Comparing a target
// against a baseline must not report our own ledgers as a difference, or the
// first migration and the first revert each invent drift out of nothing.
const COMPARE_IGNORED_TABLES = ["script_patch", "script_patch_reverted"];

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
    /**
     * information_schema reports these only when the column carries a collation
     * of its OWN — both are null for a non-collatable type and for a column
     * left on its type's default, which are the two cases that need no COLLATE
     * clause. That is exactly the question being asked, so they are read from
     * there rather than diffed out of pg_attribute by hand.
     */
    collation_schema: string | null;
    collation_name: string | null;
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

  type PartitioningRow = {
    table_name: string;
    strategy: string | null;
    key: string | null;
    partition_of: string | null;
    bounds: string | null;
    inherits: string[] | null;
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
    options: string[] | null;
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
    range_opclass: string | null;
    range_opclass_is_default: boolean | null;
    range_collation: string | null;
    range_canonical: string | null;
    range_subtype_diff: string | null;
    range_subtype_diff_schema: string | null;
    range_multirange: string | null;
    domain_not_null: boolean | null;
    domain_checks: DomainCheck[] | string | null;
    composite_fields: string[] | null;
  };

  type CollationRow = {
    name: string;
    provider: string;
    deterministic: boolean;
    lc_collate: string | null;
    lc_ctype: string | null;
    /**
     * The whole catalog row as JSON.
     *
     * The locale and the tailoring rules moved columns twice — `colliculocale`
     * arrived in 15, was renamed `colllocale` in 17, and `collicurules` arrived
     * in 16 — so naming any of them in the SELECT list makes the query fail
     * outright on a server that does not have that column. Nothing in this file
     * gates on server version, so they are read out of the row as JSON instead,
     * where a missing key is simply undefined.
     */
    raw: Record<string, unknown>;
  };

  type ExtensionRow = {
    name: string;
    version: string;
  };

  /** One row per (object, grantee, privilege). Grouped into grants below. */
  type PrivilegeRow = {
    object_kind: PrivilegeObjectKind;
    object_name: string;
    /** A routine's argument types; NULL for every other kind. */
    identity_arguments: string | null;
    owner: string;
    /** NULL when the object's ACL is empty — the LEFT JOIN keeps the owner row. */
    grantee: string | null;
    privilege_type: string | null;
    is_grantable: boolean | null;
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
           a.attgenerated AS generated,
           c.collation_schema,
           c.collation_name
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

    // conparentid = 0 and conislocal skip the constraints a parent owns: a
    // primary key on a partitioned table is cloned onto every partition, and an
    // INHERITS child inherits its parent's CHECKs. Recording those made the
    // report show one constraint several times over, and the generated script
    // tried to add a constraint PostgreSQL creates by itself.
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
           AND con.conparentid = 0
           AND con.conislocal
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
    //
    // 'm' is in the relkind list beside the tables: a materialized view stores
    // its rows and is indexed like a table, and REFRESH ... CONCURRENTLY does
    // not work without a unique index on it. Reading only 'r' and 'p' meant a
    // migration that rebuilt a matview left it with no index at all, and
    // nothing in the report mentioned it.
    //
    // Partition indexes are skipped for the same reason. An index on a
    // partitioned parent makes PostgreSQL create a matching one on every
    // partition, attached via pg_inherits. Recording those meant the script
    // emitted a CREATE INDEX for the parent and then another for each child,
    // and the second one failed on a name PostgreSQL had just taken.
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
         AND c.relkind IN ('r', 'p', 'm')
         AND c.relname <> ALL($2)
         AND NOT EXISTS (
           SELECT 1 FROM pg_constraint con WHERE con.conindid = x.indexrelid
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_inherits ii WHERE ii.inhrelid = x.indexrelid
         )
       ORDER BY c.relname, i.relname`,
      [schemaName, COMPARE_IGNORED_TABLES]
    );

    // NOT tgisinternal skips the hidden triggers Postgres creates to enforce
    // foreign keys — those are the FK, and are already recorded as one.
    // tgparentid = 0 skips the copies cloned onto each partition from a trigger
    // on the parent; the parent's trigger is what recreates them.
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
         AND t.tgparentid = 0
         AND c.relname <> ALL($2)
       ORDER BY c.relname, t.tgname`,
      [schemaName, COMPARE_IGNORED_TABLES]
    );

    // Partitioning and inheritance, which nothing else in a snapshot records.
    //
    // Three separate facts, all reachable from pg_class: a parent's strategy
    // and key (pg_partitioned_table + pg_get_partkeydef), a partition's bound
    // (relpartbound), and old-style INHERITS parents (pg_inherits, filtered to
    // the rows a partition does not produce). partstrat is a single char, so it
    // is spelled out here rather than left as 'r'/'l'/'h' for the UI to decode.
    const partitioningResult = await client.query<PartitioningRow>(
      `SELECT
         c.relname AS table_name,
         CASE pt.partstrat
           WHEN 'r' THEN 'RANGE'
           WHEN 'l' THEN 'LIST'
           WHEN 'h' THEN 'HASH'
         END AS strategy,
         CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS key,
         CASE WHEN c.relispartition THEN (
           SELECT pc.relname
           FROM pg_inherits i
           JOIN pg_class pc ON pc.oid = i.inhparent
           WHERE i.inhrelid = c.oid
         ) END AS partition_of,
         CASE WHEN c.relispartition
           THEN pg_get_expr(c.relpartbound, c.oid)
         END AS bounds,
         CASE WHEN NOT c.relispartition THEN (
           SELECT array_agg(pc.relname ORDER BY i.inhseqno)
           FROM pg_inherits i
           JOIN pg_class pc ON pc.oid = i.inhparent
           WHERE i.inhrelid = c.oid
         ) END AS inherits
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_partitioned_table pt ON pt.partrelid = c.oid
       WHERE n.nspname = $1
         AND c.relkind IN ('r', 'p')
         AND c.relname <> ALL($2)
       ORDER BY c.relname`,
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
         c.reloptions AS options,
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
         -- A ledger table is hidden from the comparison, so the sequence its
         -- SERIAL id column owns has to be hidden with it. Otherwise the table
         -- disappears and script_patch_id_seq is still reported as a new
         -- object — the same false difference, one level down.
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend owned
            JOIN pg_class owner ON owner.oid = owned.refobjid
           WHERE owned.objid = c.oid
             AND owned.classid = 'pg_class'::regclass
             AND owned.deptype IN ('a', 'i')
             AND owner.relname = ANY($2)
         )
       ORDER BY c.relname`,
      [schemaName, COMPARE_IGNORED_TABLES]
    );

    // Every table has a row in pg_type for its own row type; the typrelid check
    // removes those. The pg_depend check removes types owned by an extension
    // (pgcrypto, postgis), which are installed, not authored, and would
    // otherwise diff against any schema without that extension. The extension
    // is captured on its own below, so skipping them here no longer means the
    // difference goes unnoticed — CREATE EXTENSION brings all of them back.
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
         opc.opcname AS range_opclass,
         opc.opcdefault AS range_opclass_is_default,
         rco.collname AS range_collation,
         canp.proname AS range_canonical,
         diffp.proname AS range_subtype_diff,
         diffn.nspname AS range_subtype_diff_schema,
         -- rngmultitypid arrived in PostgreSQL 14, so it is read out of the
         -- row as JSON rather than named in a join: on an older server the key
         -- is simply absent, where naming the column would fail the query.
         (SELECT mt.typname FROM pg_type mt
           WHERE mt.oid::text = (to_jsonb(rng) ->> 'rngmultitypid')
         ) AS range_multirange,
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
       -- All five outer joins are for range types and stay NULL for the rest.
       LEFT JOIN pg_range rng ON rng.rngtypid = t.oid
       LEFT JOIN pg_opclass opc ON opc.oid = rng.rngsubopc
       LEFT JOIN pg_collation rco ON rco.oid = rng.rngcollation
       LEFT JOIN pg_proc canp ON canp.oid = rng.rngcanonical
       LEFT JOIN pg_proc diffp ON diffp.oid = rng.rngsubdiff
       LEFT JOIN pg_namespace diffn ON diffn.oid = diffp.pronamespace
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

    // No filtering beyond the namespace. Everything else in this snapshot skips
    // what an extension owns; the extension itself is the one thing that has to
    // survive, because it is what puts all of that back.
    const extensionResult = await client.query<ExtensionRow>(
      `SELECT
         e.extname AS name,
         e.extversion AS version
       FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE n.nspname = $1
       ORDER BY e.extname`,
      [schemaName]
    );

    // Only the columns that have been in pg_collation since 12 are named here.
    // The locale and the ICU rules are read from to_jsonb(co) below, because
    // the columns holding them differ by server version and naming one the
    // server does not have makes the whole query fail.
    const collationResult = await client.query<CollationRow>(
      `SELECT
         co.collname AS name,
         co.collprovider AS provider,
         co.collisdeterministic AS deterministic,
         co.collcollate AS lc_collate,
         co.collctype AS lc_ctype,
         to_jsonb(co) AS raw
       FROM pg_collation co
       JOIN pg_namespace n ON n.oid = co.collnamespace
       WHERE n.nspname = $1
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend dep
            WHERE dep.objid = co.oid AND dep.deptype = 'e'
         )
       ORDER BY co.collname`,
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
         -- 'e' is an extension's function. 'i' is one PostgreSQL made itself
         -- as part of another object: CREATE TYPE ... AS RANGE quietly adds
         -- five or six LANGUAGE internal constructors, and capturing those
         -- made the migration try to CREATE OR REPLACE them — against a type
         -- it had decided not to create — so it stopped on "type does not
         -- exist". They come back on their own with the type.
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend dep
            WHERE dep.objid = p.oid
              AND dep.classid = 'pg_proc'::regclass
              AND dep.deptype IN ('e', 'i')
         )
       ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)`,
      [schemaName]
    );

    // One row per (object, grantee, privilege), for every kind of object GRANT
    // has a word for, plus the schema itself.
    //
    // aclexplode turns the aclitem array into rows with the privilege spelled
    // out — SELECT rather than the letter r — so nothing here has to decode
    // PostgreSQL's ACL shorthand or know which letters a table has and a
    // sequence does not. acldefault fills in the implicit ACL an untouched
    // object has: relacl is NULL until somebody grants something, and reading
    // that NULL as "nobody has anything" would report a plain table as having
    // lost every privilege its owner holds.
    //
    // LEFT JOIN LATERAL rather than a plain join, so an object whose ACL
    // really is empty still produces its one row and its owner is recorded.
    //
    // Sequences are included whether or not a column owns them — see the note
    // on PrivilegeSnapshot. Indexes and constraints are not: they have no ACL
    // of their own and take their access from the table.
    const privilegeResult = await client.query<PrivilegeRow>(
      `WITH objects AS (
         SELECT
           CASE c.relkind
             WHEN 'v' THEN 'VIEW'
             WHEN 'm' THEN 'MATERIALIZED VIEW'
             WHEN 'S' THEN 'SEQUENCE'
             ELSE 'TABLE'
           END AS object_kind,
           c.relname::text AS object_name,
           NULL::text AS identity_arguments,
           pg_get_userbyid(c.relowner) AS owner,
           c.relowner AS owner_oid,
           COALESCE(
             c.relacl,
             -- The cast is needed: a CASE returns text, and acldefault takes
             -- the one-byte "char" the catalogs use for object kinds.
             acldefault(
               (CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char",
               c.relowner
             )
           ) AS acl
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
           AND c.relname <> ALL($2)
           -- And the sequences those hidden tables own — see the note in the
           -- sequence query above.
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend owned
              JOIN pg_class owner ON owner.oid = owned.refobjid
             WHERE owned.objid = c.oid
               AND owned.classid = 'pg_class'::regclass
               AND owned.deptype IN ('a', 'i')
               AND owner.relname = ANY($2)
           )
         UNION ALL
         SELECT
           CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
           p.proname::text,
           -- Kept apart from the name because the generator quotes the name and
           -- must not quote these. proargtypes holds the IN arguments only,
           -- which is exactly what identifies an overload.
           (SELECT COALESCE(string_agg(format_type(u.t, NULL), ', ' ORDER BY u.ord), '')
              FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)),
           pg_get_userbyid(p.proowner),
           p.proowner,
           COALESCE(p.proacl, acldefault('f', p.proowner))
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1
           AND p.prokind IN ('f', 'p')
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend dep
              WHERE dep.objid = p.oid
                AND dep.classid = 'pg_proc'::regclass
                AND dep.deptype IN ('e', 'i')
           )
         UNION ALL
         SELECT
           'SCHEMA', n.nspname::text, NULL::text,
           pg_get_userbyid(n.nspowner), n.nspowner,
           COALESCE(n.nspacl, acldefault('n', n.nspowner))
         FROM pg_namespace n
         WHERE n.nspname = $1
       )
       SELECT
         o.object_kind,
         o.object_name,
         o.identity_arguments,
         o.owner,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
           AS grantee,
         a.privilege_type,
         a.is_grantable
       FROM objects o
       LEFT JOIN LATERAL aclexplode(o.acl) a
         -- The owner's own entry is dropped here rather than in JS, so the
         -- rows that travel back are only the ones the comparison looks at.
         ON a.grantee <> o.owner_oid
       ORDER BY o.object_kind, o.object_name, o.identity_arguments,
                grantee, a.privilege_type`,
      [schemaName, COMPARE_IGNORED_TABLES]
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
        partitioning: {
          strategy: null,
          key: null,
          partitionOf: null,
          bounds: null,
          inherits: [],
        },
      });
    }

    for (const row of partitioningResult.rows) {
      const table = tablesByName.get(row.table_name);
      if (!table) continue;
      table.partitioning = {
        strategy: row.strategy,
        key: row.key,
        partitionOf: row.partition_of,
        bounds: row.bounds,
        inherits: coerceTextArray(row.inherits),
      };
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
        collation: formatCollation(row.collation_schema, row.collation_name, schemaName),
        // Filled in below, once the sequences have been read. null here means
        // "no sequence behind this column", which is true of most of them.
        sequenceOptions: null,
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
        options: coerceTextArray(row.options).sort(),
        indexes: [],
        triggers: [],
      };
    });

    // Built here, above the two loops, because an index or a trigger can hang
    // off a view as readily as off a table and the loops should not have to
    // care which they found. A schema cannot hold a table and a view of the
    // same name, so one map over both is unambiguous.
    const relationsByName = new Map<
      string,
      { indexes?: IndexSnapshot[]; triggers?: TriggerSnapshot[] }
    >();
    for (const [name, table] of tablesByName) relationsByName.set(name, table);
    for (const view of views) relationsByName.set(view.name, view);

    for (const row of indexResult.rows) {
      const relation = relationsByName.get(row.table_name);
      if (!relation) {
        continue;
      }

      // pg_get_indexdef() qualifies the table and any user function or type it
      // mentions, for the same reason pg_get_constraintdef() does: nothing sets
      // a search_path here. Strip the own-schema qualifier so the same index in
      // two schemas compares equal and replays into either one.
      const definition = stripSchemaFromExpr(row.definition, schemaName) ?? row.definition;

      relation.indexes?.push({
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
      const relation = relationsByName.get(row.table_name);
      if (!relation) {
        continue;
      }

      const definition = stripSchemaFromExpr(row.definition, schemaName) ?? row.definition;

      relation.triggers?.push({
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

    for (const view of views) {
      view.indexes?.sort((a, b) => a.name.localeCompare(b.name));
      view.triggers?.sort((a, b) => a.name.localeCompare(b.name));
    }

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

    // Hand each owned sequence's settings to the column that owns it.
    //
    // Done here rather than in the column loop because the sequences are only
    // read now. A column owns at most one sequence, so there is nothing to
    // merge — the last writer would be the only writer either way.
    for (const sequence of sequences) {
      if (sequence.ownedByTable === null || sequence.ownedByColumn === null) {
        continue;
      }
      const owner = tablesByName.get(sequence.ownedByTable);
      const column = owner?.columns.find((c) => c.name === sequence.ownedByColumn);
      if (!column) continue;
      column.sequenceOptions = {
        dataType: sequence.dataType,
        startValue: sequence.startValue,
        increment: sequence.increment,
        minValue: sequence.minValue,
        maxValue: sequence.maxValue,
        cycles: sequence.cycles,
        cacheSize: sequence.cacheSize,
      };
    }

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

      // Only a range type has any of this, and only the options someone
      // actually chose are kept: the default operator class is what CREATE
      // TYPE picks anyway, so recording it would add a phrase to the
      // definition of every range type already stored.
      let rangeDetails: RangeDetails | undefined;
      if (row.kind === "range") {
        const diffSchema = row.range_subtype_diff_schema;
        rangeDetails = {
          subtypeOpclass: row.range_opclass_is_default ? null : row.range_opclass,
          collation: row.range_collation,
          canonical: row.range_canonical,
          // Left bare when it is a built-in or lives in this schema, and
          // qualified when it does not — the same rule the rest of the file
          // applies to expressions, so the text reads the way it would be
          // written back out.
          subtypeDiff:
            row.range_subtype_diff === null
              ? null
              : diffSchema === schemaName || diffSchema === "pg_catalog"
                ? row.range_subtype_diff
                : `${diffSchema}.${row.range_subtype_diff}`,
          multirangeName:
            row.range_multirange !== null &&
            row.range_multirange !== `${row.name}_multirange`
              ? row.range_multirange
              : null,
          needsManualCreate:
            row.range_canonical !== null || diffSchema === schemaName,
        };
      }

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
        // The subtype alone when nothing else was chosen, which is what this
        // line said before any of the rest was captured — so a stored snapshot
        // still matches a fresh one rather than reporting drift.
        const parts = [baseType ?? "?"];
        if (rangeDetails?.subtypeOpclass) {
          parts.push(`subtype_opclass = ${rangeDetails.subtypeOpclass}`);
        }
        if (rangeDetails?.collation) {
          parts.push(`collation = "${rangeDetails.collation}"`);
        }
        if (rangeDetails?.canonical) {
          parts.push(`canonical = ${rangeDetails.canonical}`);
        }
        if (rangeDetails?.subtypeDiff) {
          parts.push(`subtype_diff = ${rangeDetails.subtypeDiff}`);
        }
        if (rangeDetails?.multirangeName) {
          parts.push(`multirange_type_name = ${rangeDetails.multirangeName}`);
        }
        definition = `RANGE (${parts.join(", ")})`;
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
        rangeDetails,
        definition,
        normalizedDefinition: normalizeDefinition(definition),
      } satisfies TypeSnapshot;
    });

    const collations: CollationSnapshot[] = collationResult.rows.map((row) => {
      const provider = collationProvider(row.provider);
      // colllocale is 17+, colliculocale is 15-16, and before 15 an ICU
      // collation kept its locale in collcollate — the same column libc uses.
      const rawLocale =
        textOrNull(row.raw.colllocale) ??
        textOrNull(row.raw.colliculocale) ??
        (provider === "libc" ? null : row.lc_collate);
      const isLibc = provider === "libc" || provider === "default";
      const locale = isLibc ? null : rawLocale;
      const lcCollate = isLibc ? row.lc_collate : null;
      const lcCtype = isLibc ? row.lc_ctype : null;
      const rules = textOrNull(row.raw.collicurules);

      // Written as the CREATE COLLATION option list, so the diff on screen
      // reads the way the statement that would fix it does.
      const parts = [`provider = ${provider}`];
      if (locale !== null) parts.push(`locale = ${quoteLiteral(locale)}`);
      if (lcCollate !== null) parts.push(`lc_collate = ${quoteLiteral(lcCollate)}`);
      if (lcCtype !== null) parts.push(`lc_ctype = ${quoteLiteral(lcCtype)}`);
      if (rules !== null) parts.push(`rules = ${quoteLiteral(rules)}`);
      // Only ever written when it is false: "deterministic = true" on every
      // ordinary collation is noise on a line the report shows in full.
      if (!row.deterministic) parts.push("deterministic = false");
      const definition = parts.join(", ");

      return {
        name: row.name,
        provider,
        deterministic: row.deterministic,
        locale,
        lcCollate,
        lcCtype,
        rules,
        definition,
        normalizedDefinition: normalizeDefinition(definition),
      } satisfies CollationSnapshot;
    });

    const extensions: ExtensionSnapshot[] = extensionResult.rows.map((row) => {
      // Worded as the tail of the statement that installs it, so the line in
      // the report and the SQL that fixes it read the same way.
      const definition = `version ${row.version}`;
      return {
        name: row.name,
        version: row.version,
        definition,
        normalizedDefinition: normalizeDefinition(definition),
      } satisfies ExtensionSnapshot;
    });

    // The query hands back one row per (object, grantee, privilege); this puts
    // them back together into one entry per object.
    const privilegesByKey = new Map<string, PrivilegeSnapshot>();
    const grantsByKey = new Map<string, Map<string, PrivilegeGrant>>();
    for (const row of privilegeResult.rows) {
      // format_type() qualifies an argument whose type lives in this schema, so
      // an untouched `f(order_status)` arrives as `f(dev.order_status)`. Left
      // alone that is wrong twice over: the same function in two schemas would
      // never match, and the generated GRANT would name a type in the schema
      // being copied FROM. Same treatment the routine signatures get.
      const identityArguments =
        stripSchemaFromExpr(row.identity_arguments, schemaName);
      // The arguments are part of the key: two overloads of one function are
      // two objects with two ACLs, and keying on the name alone would fold
      // them together and report one's grants as the other's.
      const key =
        `${row.object_kind}\u0000${row.object_name}` +
        `\u0000${identityArguments ?? ""}`;
      let entry = privilegesByKey.get(key);
      if (!entry) {
        entry = {
          objectKind: row.object_kind,
          objectName: row.object_name,
          ...(identityArguments === null ? {} : { identityArguments }),
          owner: row.owner,
          grants: [],
          definition: "",
          normalizedDefinition: "",
        };
        privilegesByKey.set(key, entry);
        grantsByKey.set(key, new Map());
      }
      // Null on the row the LEFT JOIN produced for an object nobody else has
      // any access to. The object still belongs in the list — its owner is the
      // point — so the row is kept and only the grant is skipped.
      if (row.grantee === null || row.privilege_type === null) continue;
      const byGrantee = grantsByKey.get(key)!;
      let grant = byGrantee.get(row.grantee);
      if (!grant) {
        grant = { grantee: row.grantee, privileges: [], grantable: [] };
        byGrantee.set(row.grantee, grant);
        entry.grants.push(grant);
      }
      grant.privileges.push(row.privilege_type);
      if (row.is_grantable) grant.grantable.push(row.privilege_type);
    }

    const privileges: PrivilegeSnapshot[] = Array.from(privilegesByKey.values());
    for (const entry of privileges) {
      entry.grants.sort((a, b) => a.grantee.localeCompare(b.grantee));
      for (const grant of entry.grants) {
        grant.privileges = sortPrivileges(grant.privileges);
        grant.grantable = sortPrivileges(grant.grantable);
      }
      entry.definition = buildPrivilegeDefinition(entry.owner, entry.grants);
      entry.normalizedDefinition = normalizeDefinition(entry.definition);
    }

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
    return { ok: false, error: message };
  } finally {
    client.release();
  }
}
