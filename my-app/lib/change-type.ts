// How a script's change type is decided, in one place.
//
// The deploy screen only ever sees a script as text — it pulls the .sql file
// out of GitHub — so for a long time it worked the type out by searching that
// text for "drop table" and friends. Two things were wrong with that. The
// search ran over the comments as well as the SQL, and a safe-mode script says
// "(DROP TABLE / DROP COLUMN) are commented out below" in its own header, so a
// migration that only ADDS things graded itself breaking and forced a major
// version bump. And the accurate answer already existed: the generator knows
// exactly which statements it wrote and how severe each one is, and then threw
// that away at render time.
//
// So the generator now stamps its answer into the script header, and this
// module reads it. The SQL reader is still here, because a hand-written script
// or one from an older version has no stamp — but it runs on a masked copy with
// every comment, literal and quoted identifier blanked out.
//
// There used to be three readers: this one, a plain substring search in the
// Script Editor, and the generator's own grading. They disagreed — DROP VIEW
// was patch in the editor and breaking here — so the same file could get a
// different version bump on each screen. gradeSql below is now the only SQL
// reader, and it follows the generator's rules statement by statement.
//
// Client-safe on purpose: it imports only the pure helpers in sql-guard and
// change-level, because the deploy screen and the Script Editor run it in the
// browser.
import { doBlockBodies, maskNonCode, splitStatements } from "./sql-guard";
import { normalizeChangeLevel, type ChangeLevel } from "./change-level";

/**
 * The header line the generator writes and this module reads back.
 *
 * A comment, so it is inert SQL wherever the script ends up, and a fixed key so
 * reading it never depends on the prose around it.
 */
export const CHANGE_TYPE_HEADER_KEY = "Change-type";

/**
 * What a script can be graded as.
 *
 * "unknown" is a reading of somebody else's version table — it is never a
 * verdict this module reaches, so callers do not have to handle it.
 */
export type ScriptChangeType = Exclude<ChangeLevel, "unknown">;

/** Write the stamp the generator puts in a rendered script header. */
export function changeTypeHeaderLine(level: ChangeLevel): string {
  return `-- ${CHANGE_TYPE_HEADER_KEY}: ${level}`;
}

// One pattern for the stamp, shared by the reader and the writer below, so the
// two can never disagree about which line is the stamp.
const HEADER_PATTERN = new RegExp(`^\\s*--\\s*${CHANGE_TYPE_HEADER_KEY}\\s*:\\s*(\\w+)`, "i");

/**
 * Which line of the header holds the stamp, or -1 when there is none.
 *
 * Only the header is searched — the first lines, before any statement — so a
 * stray line of the same shape further down cannot restate the answer.
 */
function headerLineIndex(lines: string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (HEADER_PATTERN.test(line)) return index;
    // Stop at the first line that is neither blank nor a comment: everything
    // after that is the body, and the stamp belongs to the header.
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("--")) return -1;
  }
  return -1;
}

/**
 * Read the stamped grading back out of a script, or null when the script does
 * not carry one (or carries a word that is not a level).
 */
export function readChangeTypeHeader(sql: string): ScriptChangeType | null {
  const lines = sql.split(/\r?\n/);
  const index = headerLineIndex(lines);
  if (index === -1) return null;
  const match = lines[index].match(HEADER_PATTERN);
  const level = normalizeChangeLevel(match ? match[1] : null);
  return level === "unknown" ? null : level;
}

/**
 * Put the author's level into the script's header.
 *
 * When the header already has a "-- Change-type:" line — the generator writes
 * one, and an author may have typed one — that line is replaced, so a stale
 * value can never survive next to the new one. Otherwise the stamp becomes the
 * first line. Stamping a script with the level it already carries changes
 * nothing, byte for byte.
 */
export function stampChangeType(sql: string, level: ScriptChangeType): string {
  const lines = sql.split("\n");
  const index = headerLineIndex(lines);
  if (index === -1) return `${changeTypeHeaderLine(level)}\n${sql}`;
  // Keep a Windows line ending if the file used one.
  const carriageReturn = lines[index].endsWith("\r") ? "\r" : "";
  lines[index] = `${changeTypeHeaderLine(level)}${carriageReturn}`;
  return lines.join("\n");
}

// ── Reading the SQL itself ─────────────────────────────────────────────────

/**
 * What the SQL of a script says about its change level.
 *
 * - level: the reader's answer, counting "breaking unless…" statements as
 *   breaking. This is what a script with no stamp is graded as.
 * - sureLevel: the answer when only statements that are breaking whatever the
 *   context count. Deploy uses it to spot a stamped script whose SQL is louder
 *   than its label.
 * - because: the statement words that made it breaking, e.g. "DROP TABLE" or
 *   "ALTER COLUMN … TYPE". Null when nothing breaking was found.
 * - unless: for a "breaking unless…" statement, the plain sentence saying when
 *   it is not really breaking. Null otherwise.
 */
export type SqlGrade = {
  level: ScriptChangeType;
  sureLevel: ScriptChangeType;
  because: string | null;
  unless: string | null;
};

/** One statement shape the reader knows, and what it means. */
type GradeRule = {
  /** The statement words shown to the user, e.g. "DROP TABLE". */
  label: string;
  /** When the SQL alone cannot settle it: when it is NOT breaking. */
  unless: string | null;
  /** Tested against one masked, lower-cased, single-spaced statement. */
  matches: (statement: string) => boolean;
};

/** A rule that matches its pattern anywhere in the statement. */
function anywhere(pattern: RegExp): (statement: string) => boolean {
  return (statement) => pattern.test(statement);
}

function isAlterTable(statement: string): boolean {
  return /^alter table\b/.test(statement);
}

/**
 * A rule that only applies to ALTER TABLE, tested with the leading "alter
 * table" words taken off. Without that, the table-level words could satisfy a
 * column pattern on their own.
 */
function inAlterTable(pattern: RegExp): (statement: string) => boolean {
  return (statement) =>
    isAlterTable(statement) && pattern.test(statement.replace(/^alter table /, ""));
}

// The words that can follow DROP inside ALTER TABLE without it being a column.
const NOT_A_COLUMN_AFTER_DROP = new Set([
  "column",
  "constraint",
  "default",
  "not",
  "identity",
  "expression",
]);

/**
 * ALTER TABLE t DROP legacy — a column drop written without the COLUMN keyword,
 * which PostgreSQL accepts. An empty word means the name was a quoted
 * identifier, which the mask blanked; that is a column too.
 */
function dropsColumnWithoutKeyword(statement: string): boolean {
  if (!isAlterTable(statement)) return false;
  // The word after DROP is optional in the pattern, because a blanked quoted
  // name can leave DROP as the last word of the statement.
  for (const match of statement.matchAll(/\bdrop\b(?: if exists\b)?(?: (\w+))?/g)) {
    if (!NOT_A_COLUMN_AFTER_DROP.has(match[1] ?? "")) return true;
  }
  return false;
}

/**
 * Every object a DROP can take away that another object or another app may be
 * depending on — the generator grades each of these breaking every time.
 *
 * INDEX and CONSTRAINT are deliberately missing: whether dropping one breaks
 * anything depends on what it was (a unique index, a foreign key), which the
 * DROP statement does not say. They are in BREAKING_UNLESS below.
 */
const DROPPED_OBJECTS = [
  "table",
  "column",
  "materialized view",
  "view",
  "sequence",
  "function",
  "procedure",
  "trigger",
  "type",
  "domain",
  "schema",
  "database",
  "extension",
  "rule",
  "policy",
  "collation",
];

/**
 * Statements that are breaking whatever the context. The generator grades each
 * of these breaking every time it writes one, so a label can never outrank
 * them: Deploy counts them in its breaking checks even under a quieter stamp.
 */
const ALWAYS_BREAKING: GradeRule[] = [
  ...DROPPED_OBJECTS.map((object) => ({
    label: `DROP ${object.toUpperCase()}`,
    unless: null,
    matches: anywhere(new RegExp(`\\bdrop ${object}\\b`)),
  })),
  { label: "DROP COLUMN", unless: null, matches: dropsColumnWithoutKeyword },
  { label: "RENAME", unless: null, matches: anywhere(/\brename\b/) },
  { label: "SET NOT NULL", unless: null, matches: anywhere(/\bset not null\b/) },
  { label: "CREATE UNIQUE INDEX", unless: null, matches: anywhere(/\bcreate unique index\b/) },
  {
    label: "ENABLE ROW LEVEL SECURITY",
    unless: null,
    matches: anywhere(/\benable row level security\b/),
  },
  {
    label: "DISABLE ROW LEVEL SECURITY",
    unless: null,
    matches: anywhere(/\bdisable row level security\b/),
  },
  // Also catches NO FORCE ROW LEVEL SECURITY, which is just as breaking.
  { label: "FORCE ROW LEVEL SECURITY", unless: null, matches: anywhere(/\bforce row level security\b/) },
  { label: "CREATE POLICY", unless: null, matches: anywhere(/\bcreate policy\b/) },
  { label: "ALTER POLICY", unless: null, matches: anywhere(/\balter policy\b/) },
  { label: "REVOKE", unless: null, matches: anywhere(/\brevoke\b/) },
];

/**
 * Statements the SQL alone cannot settle. The generator decides these from
 * context the text does not carry — the old column type, whether an index was
 * unique, whether the table was created earlier in the same script — so a
 * reader must treat them as "breaking unless…", never as certain. Each one
 * says, in plain words, when it is not breaking.
 */
const BREAKING_UNLESS: GradeRule[] = [
  {
    label: "ALTER COLUMN … TYPE",
    unless: "it only widens the column, for example varchar(100) to varchar(200)",
    matches: inAlterTable(/\balter (column )?(\S+ )?(set data )?type\b/),
  },
  {
    label: "ALTER COLUMN … GENERATED/IDENTITY",
    unless: "no insert relies on how the column fills itself",
    matches: inAlterTable(
      /\balter (column )?(\S+ )?(add generated|set generated|drop identity|drop expression|set expression)\b/
    ),
  },
  {
    label: "ADD CONSTRAINT",
    unless: "the table is created earlier in this same script",
    matches: anywhere(/\badd (constraint|primary key|unique|foreign key|check|exclude)\b/),
  },
  {
    label: "DROP INDEX",
    unless: "the index was not unique",
    matches: anywhere(/\bdrop index\b/),
  },
  {
    label: "DROP CONSTRAINT",
    unless:
      "it is a CHECK constraint — dropping a primary key, unique or foreign key is always breaking",
    matches: anywhere(/\bdrop constraint\b/),
  },
  {
    label: "OWNER TO",
    unless: "no app connects as the old owner",
    matches: anywhere(/\bowner to\b/),
  },
];

// The words that can follow ADD inside ALTER TABLE without it being a column.
const NOT_A_COLUMN_AFTER_ADD = new Set([
  "constraint",
  "primary",
  "unique",
  "foreign",
  "check",
  "exclude",
  "value",
  // ALTER COLUMN a ADD GENERATED … changes an existing column.
  "generated",
]);

const CREATES_SOMETHING =
  /\bcreate (or replace )?(temp |temporary |unlogged )?(table|view|materialized view|index|sequence|type|domain|function|procedure|trigger|constraint trigger|schema|extension|collation)\b/;

/**
 * Whether a statement adds something new. Only asked when nothing breaking
 * matched. What stays patch, matching the generator: ALTER TYPE … ADD VALUE,
 * GRANT, COMMENT, SET/DROP DEFAULT, DROP NOT NULL, TRUNCATE and plain DML.
 */
function addsSomething(statement: string): boolean {
  if (CREATES_SOMETHING.test(statement)) return true;
  if (/\badd column\b/.test(statement)) return true;
  if (!isAlterTable(statement)) return false;
  // ALTER TABLE t ADD note text — a column added without the COLUMN keyword.
  for (const match of statement.matchAll(/\badd (\w+)/g)) {
    if (!NOT_A_COLUMN_AFTER_ADD.has(match[1])) return true;
  }
  return false;
}

/**
 * The generator's replace idiom: a changed trigger is written as DROP TRIGGER
 * directly followed by CREATE TRIGGER, and a changed index as DROP INDEX
 * directly followed by CREATE INDEX. The generator grades the pair by what is
 * created, so the DROP half is skipped here. The CREATE half is still graded on
 * its own, which keeps a CREATE UNIQUE INDEX breaking.
 */
function isReplacedByNext(statement: string, next: string | undefined): boolean {
  if (next === undefined) return false;
  if (/^drop trigger\b/.test(statement)) {
    return /^create (or replace )?(constraint )?trigger\b/.test(next);
  }
  if (/^drop index\b/.test(statement)) {
    return /^create (unique )?index\b/.test(next);
  }
  return false;
}

/** Lower-case and squeeze all whitespace to single spaces. */
function tidy(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The statements that will actually run, in order, each masked, lower-cased and
 * single-spaced so the rules above can be simple.
 *
 * The inside of a DO block is read as well. maskNonCode blanks it whole, and a
 * generated script puts some statements there, behind a lookup that skips them
 * on a second run (see onlyIfMissing in lib/generate-sql.ts). A column rename
 * written that way is still a rename. Inside the block, BEGIN / THEN / ELSE /
 * LOOP also end a piece, so "IF … THEN ALTER TABLE …" is read as a statement
 * starting with ALTER TABLE.
 */
function statementsThatRun(sql: string): string[] {
  const out: string[] = [];
  for (const statement of splitStatements(sql)) {
    const code = tidy(maskNonCode(statement));
    if (/^do\b/.test(code)) {
      const body = doBlockBodies(statement).replace(/\b(begin|then|else|loop)\b/gi, ";");
      for (const piece of body.split(";")) {
        const inner = tidy(piece);
        if (inner) out.push(inner);
      }
    } else if (code) {
      out.push(code);
    }
  }
  return out;
}

/**
 * Grade a script by reading the SQL it will actually run.
 *
 * The one SQL reader in the app: the Script Editor's suggestion, Deploy's
 * grading of a script with no stamp, and Deploy's "louder than its label"
 * check all come from here, so the same SQL gets the same grade on every
 * screen.
 *
 * It reads a masked copy, so a keyword inside a comment, a string literal, a
 * quoted identifier or a function body counts for nothing — which is what makes
 * a safe-mode script, whose drops are all commented out, grade as what it
 * really does rather than as what it describes.
 *
 * It is a reader, not a parser, and it cannot know:
 * - the old type of a column (a varchar widening is safe, a narrowing is not);
 * - whether a dropped index was unique, or a dropped constraint was a CHECK;
 * - whether an ADD CONSTRAINT is for a table created earlier in the same script;
 * - whether anything still connects as the owner an OWNER TO replaces;
 * - what EXECUTE runs, because the SQL it runs is a string.
 * Those come back as "breaking unless…" with the reason, and never override a
 * stamp (see describeChangeType). It also errs loud in one known way: an
 * unquoted column literally named "type" whose default changes reads as a type
 * change. And a DROP INDEX directly followed by the CREATE INDEX of a different
 * index is taken for a replacement.
 */
export function gradeSql(sql: string): SqlGrade {
  const statements = statementsThatRun(sql);
  let firstAlways: GradeRule | null = null;
  let firstUnless: GradeRule | null = null;
  let adds = false;

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (isReplacedByNext(statement, statements[index + 1])) continue;

    if (firstAlways === null) {
      firstAlways = ALWAYS_BREAKING.find((rule) => rule.matches(statement)) ?? null;
    }
    if (firstUnless === null) {
      firstUnless = BREAKING_UNLESS.find((rule) => rule.matches(statement)) ?? null;
    }
    if (!adds && addsSomething(statement)) adds = true;
  }

  // What the script is when nothing breaking counts.
  const quiet: ScriptChangeType = adds ? "additive" : "patch";
  // The statement named to the user: a certain one before an uncertain one.
  const named = firstAlways ?? firstUnless;

  return {
    level: named ? "breaking" : quiet,
    sureLevel: firstAlways ? "breaking" : quiet,
    because: named ? named.label : null,
    unless: named ? named.unless : null,
  };
}

/** The reader's answer for a script with no stamp. Same as gradeSql(sql).level. */
export function inferChangeTypeFromSql(sql: string): ScriptChangeType {
  return gradeSql(sql).level;
}

/** The louder of two levels: breaking, then additive, then patch. */
export function louderChangeType(a: ScriptChangeType, b: ScriptChangeType): ScriptChangeType {
  if (a === "breaking" || b === "breaking") return "breaking";
  if (a === "additive" || b === "additive") return "additive";
  return "patch";
}

/**
 * The change type of a script: what its stamp says if it has one, otherwise
 * what the SQL itself says. Same as describeChangeType(sql).recorded.
 */
export function changeTypeOf(sql: string): ScriptChangeType {
  return readChangeTypeHeader(sql) ?? inferChangeTypeFromSql(sql);
}

/** Everything Deploy needs to know about one script's level. */
export type ChangeTypeReading = {
  /** The stamp in the header, or null when there is none. */
  declared: ScriptChangeType | null;
  /** What the SQL itself says. */
  grade: SqlGrade;
  /** The level to show, to bump the version by, and to record in script_patch. */
  recorded: ScriptChangeType;
  /** Whether the script counts in the breaking checks. */
  countsAsBreaking: boolean;
  /** Set when the SQL is certainly louder than the stamp. Shown to the user. */
  louderNote: string | null;
};

/**
 * The one rule for how a script's level is decided, and whether it counts as
 * breaking. The apply route is meant to call this same helper server-side.
 *
 * - The stamp wins for the level. Whoever wrote it — the generator or the
 *   author at push time — had context the SQL lacks, so `recorded` is the
 *   stamp when there is one and the SQL reading otherwise (exactly what
 *   changeTypeOf returns, so script_patch.change_type does not move).
 * - The breaking checks count the script when it is stamped breaking, when its
 *   SQL has a statement that is ALWAYS breaking (whatever the stamp says), or
 *   when it has no stamp and the reader grades it breaking.
 * - A "breaking unless…" statement never overrides a stamp: a widening ALTER
 *   COLUMN TYPE under an additive stamp is not flagged.
 */
export function describeChangeType(sql: string): ChangeTypeReading {
  const declared = readChangeTypeHeader(sql);
  const grade = gradeSql(sql);
  const recorded = declared ?? grade.level;
  const countsAsBreaking =
    declared === "breaking" ||
    grade.sureLevel === "breaking" ||
    (declared === null && grade.level === "breaking");
  const louderNote =
    declared !== null && declared !== "breaking" && grade.sureLevel === "breaking"
      ? `Marked ${declared}, but its SQL has ${grade.because}, which is always breaking — ` +
        "it is counted in the breaking checks below."
      : null;
  return { declared, grade, recorded, countsAsBreaking, louderNote };
}
