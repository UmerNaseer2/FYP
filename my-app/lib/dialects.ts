// What this app knows about each database engine.
//
// Spec feature 2.4: "Ability to support multiple types of databases (primary
// PostgreSQL)." The parenthesis is the whole brief. One engine is implemented
// and the rest are not; what this file adds is that the engine is a value the
// code reads rather than an assumption baked into every module, so adding a
// second one is work in known places instead of a search of the whole app.
//
// This is deliberately a description, not an abstraction layer. There is no
// Dialect interface with a `introspect()` nobody has written, and no adapter
// with one implementation — a seam with one side is not a seam, it is a
// misdirection that makes the reader look for a second implementation that
// does not exist. What is here is the set of facts the rest of the app already
// hard-codes about PostgreSQL, named and attached to the engine they belong
// to, plus an honest `implemented` flag for the ones it does not have.
//
// The flag matters more than it looks. Without it, "multiple database types"
// is a dropdown that saves a row the rest of the app then silently filters out
// of Compare and refuses at both test endpoints — which is exactly the bug
// lib/connection-validate.ts was written to close. A known-but-unimplemented
// engine is a better answer than either a broken row or pretending the name
// has never been heard of.

/** Every engine this file has an opinion about, implemented or not. */
export const DIALECT_IDS = ["PostgreSQL", "MySQL", "SQL Server"] as const;
export type DialectId = (typeof DIALECT_IDS)[number];

export type Dialect = {
  id: DialectId;
  /**
   * Is there a driver, an introspector and a DDL generator for this engine?
   * False means the app can name it and explain itself, and nothing more.
   */
  implemented: boolean;
  /** The port used when a connection does not give one. */
  defaultPort: number;
  /** URI schemes that address this engine, lowercase and without the "://". */
  uriSchemes: string[];
  /**
   * How an identifier is quoted, as the opening and closing character.
   *
   * PostgreSQL and SQL Server fold unquoted names in opposite directions and
   * MySQL's depends on the host filesystem, which is why everything this app
   * generates is quoted. The doubling rule inside the quotes is the same in
   * all three: the closing character written twice.
   */
  quote: { open: string; close: string };
  /**
   * Does DDL take part in transactions?
   *
   * The one fact here that changes what this app may promise. Deploy runs a
   * batch of migrations inside one transaction and tells the reader "all of
   * them or none" — which is true on PostgreSQL and false on MySQL, where each
   * CREATE or ALTER commits itself and a failure half way through leaves the
   * target in a state no ROLLBACK can undo. A second dialect cannot be added
   * without answering this, and the deploy screen reads it rather than
   * assuming it, so the answer cannot be added without the promise following.
   */
  transactionalDdl: boolean;
  /** Said on screen when somebody picks an engine with no driver. */
  note: string;
};

const DIALECTS: Record<DialectId, Dialect> = {
  PostgreSQL: {
    id: "PostgreSQL",
    implemented: true,
    defaultPort: 5432,
    uriSchemes: ["postgres", "postgresql"],
    quote: { open: '"', close: '"' },
    transactionalDdl: true,
    note: "",
  },
  MySQL: {
    id: "MySQL",
    implemented: false,
    defaultPort: 3306,
    uriSchemes: ["mysql"],
    quote: { open: "`", close: "`" },
    // Not a detail to fill in later: MySQL commits each DDL statement on its
    // own, so a failed batch stops part-applied. Supporting it means Deploy
    // saying something different about what a failed run leaves behind, not
    // just swapping a driver.
    transactionalDdl: false,
    note:
      "MySQL is not connected to yet. Beyond the driver, it commits each CREATE " +
      "and ALTER on its own, so the guarantee Deploy makes here — every migration " +
      "in a run or none of them — would not hold and would have to be reworded " +
      "before it could be offered.",
  },
  "SQL Server": {
    id: "SQL Server",
    implemented: false,
    defaultPort: 1433,
    uriSchemes: ["sqlserver", "mssql"],
    quote: { open: "[", close: "]" },
    transactionalDdl: true,
    note:
      "SQL Server is not connected to yet. Its DDL does roll back with the " +
      "transaction, so Deploy's guarantee would hold, but nothing here reads its " +
      "catalog or writes its dialect of ALTER TABLE.",
  },
};

/** The engine's facts, or PostgreSQL's for a name this app does not know. */
export function dialect(id: string): Dialect {
  return DIALECTS[id as DialectId] ?? DIALECTS.PostgreSQL;
}

/** True for a name this file describes, implemented or not. */
export function isKnownDialect(id: string): id is DialectId {
  return (DIALECT_IDS as readonly string[]).includes(id);
}

/** The engines that actually work today. What a connection may be saved as. */
export const IMPLEMENTED_DIALECTS = DIALECT_IDS.filter((id) => DIALECTS[id].implemented);

/**
 * Quote an identifier for this engine.
 *
 * The closing character is doubled inside, which is the escape rule in all
 * three — including SQL Server, where `]]` is how a `]` is written inside
 * brackets. Anything generated by this app goes through here rather than a
 * template literal with quotes typed into it, so the engine is read from the
 * connection instead of assumed.
 */
export function quoteFor(id: string, name: string): string {
  const { quote } = dialect(id);
  return `${quote.open}${name.split(quote.close).join(quote.close + quote.close)}${quote.close}`;
}

/**
 * What to tell somebody who asked for an engine this app cannot use.
 *
 * Null when the engine is fine. Deliberately three different sentences: a name
 * that is not a database at all, a database this app has never been taught,
 * and a database it knows about but has no driver for are three different
 * situations, and one "unsupported type" for all three tells the reader
 * nothing about whether waiting would help.
 */
export function unsupportedReason(id: string): string | null {
  const wanted = (id ?? "").trim();
  if (wanted === "") return "Choose a database type.";
  if (!isKnownDialect(wanted)) {
    return (
      `"${wanted}" is not a database type this app knows. It works with ` +
      `${IMPLEMENTED_DIALECTS.join(", ")}.`
    );
  }
  const found = DIALECTS[wanted];
  if (found.implemented) return null;
  return `${found.note} Use ${IMPLEMENTED_DIALECTS.join(" or ")} for now.`;
}
