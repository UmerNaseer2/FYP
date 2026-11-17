/**
 * The snapshot types, part two: the objects a schema holds besides its
 * tables. Views, sequences, user-defined types, collations, routines,
 * extensions and privileges. Import them through "./types", which re-exports
 * every one.
 */
import type { IndexSnapshot, TriggerSnapshot } from "./types";

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
