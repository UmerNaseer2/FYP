/**
 * The words the phone app shows (src/phone/format.ts): the names of
 * environments, changes and severities, counts, each target's headline,
 * foreign keys, what the signed-in role may not do, waits, days, the
 * phone's own name, and SQL's characters that do not show on screen.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  accessProblem,
  CHANGE_LABELS,
  countText,
  dayText,
  defaultPhoneName,
  ENVIRONMENT_LABELS,
  foreignKeyText,
  hasHiddenCharacters,
  retryText,
  SEVERITY_LABELS,
  showHiddenCharacters,
  targetHeadline,
} from "../phone/format.js";
import type { ForeignKeyOverview, HelloResult, TargetStatus, TargetSummary } from "../shared/remote/rpc.js";

/** A target that went as `status` says, with `changes` changes. */
function target(status: TargetStatus, changes = 0): TargetSummary {
  return {
    connectionId: 2,
    name: "Staging",
    environment: "staging",
    schema: "public",
    status,
    error: status === "compared" ? null : "The computer's own sentence.",
    changes,
    breaking: 0,
    manual: 0,
    lines: [],
    moreLines: 0,
    history: null,
  };
}

/** A foreign key from author_id to the id column of authors in `referencedSchema`. */
function foreignKey(changes: Partial<ForeignKeyOverview> = {}): ForeignKeyOverview {
  return { columns: ["author_id"], referencedSchema: "public", referencedTable: "authors", referencedColumns: ["id"], ...changes };
}

/** A hello from a computer where someone with the Viewer role is signed in. */
function hello(changes: Partial<HelloResult> = {}): HelloResult {
  return { signedIn: true, role: "Viewer", canCompare: true, canReadSchemas: true, canSeeLive: true, appVersion: "1.0.0", ...changes };
}

test("names each environment as the web app does", () => {
  assert.deepEqual(ENVIRONMENT_LABELS, { unset: "Unlabelled", dev: "Dev", staging: "Staging", prod: "Production" });
});

test("names each kind of change and each severity as the web app does", () => {
  assert.deepEqual(CHANGE_LABELS, {
    added: "Added",
    dropped: "Dropped",
    changed: "Changed",
    renamed: "Renamed",
    "rename-suggested": "Possible rename",
  });
  assert.deepEqual(SEVERITY_LABELS, { breaking: "Breaking", safe: "Safe", info: "Info" });
});

test("counts in the singular for one and in the plural for any other number", () => {
  assert.equal(countText(0, "table", "tables"), "0 tables");
  assert.equal(countText(1, "table", "tables"), "1 table");
  assert.equal(countText(2, "table", "tables"), "2 tables");
});

test("sums up how comparing with each target went in a few words", () => {
  assert.equal(targetHeadline(target("compared", 0)), "No differences");
  assert.equal(targetHeadline(target("compared", 1)), "1 difference");
  assert.equal(targetHeadline(target("compared", 14)), "14 differences");
  const headlines: [TargetStatus, string][] = [
    ["same-as-source", "Same as the source"],
    ["unreachable", "Could not connect"],
    ["schema-missing", "No such schema"],
    ["duplicate", "Compared already"],
    ["no-connection", "Connection not found"],
    ["failed", "Could not compare"],
  ];
  for (const [status, headline] of headlines) assert.equal(targetHeadline(target(status)), headline);
});

test("writes a foreign key as its columns, an arrow and what they point at", () => {
  assert.equal(foreignKeyText(foreignKey(), "public"), "author_id \u{2192} authors (id)");
  assert.equal(
    foreignKeyText(foreignKey({ columns: ["shop_id", "book_id"], referencedTable: "stock", referencedColumns: ["shop_id", "book_id"] }), "public"),
    "shop_id, book_id \u{2192} stock (shop_id, book_id)",
  );
  assert.equal(foreignKeyText(foreignKey({ referencedColumns: [] }), "public"), "author_id \u{2192} authors");
});

test("names a foreign key's table with its schema only when that is not the schema on screen", () => {
  assert.equal(foreignKeyText(foreignKey({ referencedSchema: "people" }), "public"), "author_id \u{2192} people.authors (id)");
  assert.equal(foreignKeyText(foreignKey({ referencedSchema: "people" }), "people"), "author_id \u{2192} authors (id)");
  assert.equal(foreignKeyText(foreignKey({ referencedSchema: null }), "people"), "author_id \u{2192} authors (id)");
});

test("says so when PostgreSQL did not name the table a foreign key points at", () => {
  assert.equal(foreignKeyText(foreignKey({ referencedTable: null }), "public"), "author_id \u{2192} a table PostgreSQL did not name (id)");
  assert.equal(
    foreignKeyText(foreignKey({ referencedSchema: null, referencedTable: null, referencedColumns: [] }), "public"),
    "author_id \u{2192} a table PostgreSQL did not name",
  );
});

test("asks for someone to sign in on the computer when no one is", () => {
  assert.equal(
    accessProblem(hello({ signedIn: false, role: null, canCompare: false, canReadSchemas: false })),
    "No one is signed in to Schema Studio on the computer. Sign in there, then choose Check again.",
  );
});

test("says what the role signed in on the computer may not do", () => {
  assert.equal(
    accessProblem(hello({ canCompare: false, canReadSchemas: false })),
    "The Viewer role signed in on the computer may not look at schemas or compare them.",
  );
  assert.equal(
    accessProblem(hello({ canReadSchemas: false })),
    "The Viewer role signed in on the computer may compare schemas, but not look through them.",
  );
  assert.equal(
    accessProblem(hello({ canCompare: false })),
    "The Viewer role signed in on the computer may look at schemas, but not compare them.",
  );
  assert.equal(
    accessProblem(hello({ role: null, canCompare: false })),
    "The role signed in on the computer may look at schemas, but not compare them.",
  );
});

test("finds nothing to say when the role may do everything a phone can", () => {
  assert.equal(accessProblem(hello()), null);
});

test("counts the wait in whole seconds, rounding up, and never says 0", () => {
  assert.equal(retryText(10_000, 0), "Trying again in 10 s");
  assert.equal(retryText(10_001, 0), "Trying again in 11 s");
  assert.equal(retryText(9_999, 0), "Trying again in 10 s");
  assert.equal(retryText(1_002_500, 1_000_000), "Trying again in 3 s");
  assert.equal(retryText(400, 0), "Trying again in 1 s");
  assert.equal(retryText(0, 0), "Trying again in 1 s");
  assert.equal(retryText(0, 5_000), "Trying again in 1 s");
});

test("writes a day as the web app does", () => {
  assert.equal(dayText(new Date(2026, 9, 23, 12).getTime()), "23 Oct 2026");
  assert.equal(dayText(new Date(2026, 0, 1, 12).getTime()), "1 Jan 2026");
});

test("names the device after what its browser says it runs on", () => {
  const iPhone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const oldIPad = "Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1";
  // An iPad's Safari says it is a Mac, and only its touch screen gives it away.
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const androidPhone = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
  const androidTablet = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const ubuntu = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
  assert.equal(defaultPhoneName(iPhone, 5), "iPhone");
  assert.equal(defaultPhoneName(oldIPad, 5), "iPad");
  assert.equal(defaultPhoneName(mac, 5), "iPad");
  assert.equal(defaultPhoneName(mac, 1), "Safari on Mac");
  assert.equal(defaultPhoneName(mac, 0), "Safari on Mac");
  assert.equal(defaultPhoneName(androidPhone, 5), "Android phone");
  assert.equal(defaultPhoneName(androidTablet, 5), "Android tablet");
  assert.equal(defaultPhoneName(ubuntu, 0), "Firefox on Ubuntu");
  const chromeOnMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const chromeOnWindows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const edge = `${chromeOnWindows} Edg/130.0.0.0`;
  const opera = `${chromeOnWindows} OPR/115.0.0.0`;
  const chromeOnLinux = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const chromebook = "Mozilla/5.0 (X11; CrOS x86_64 15183.69.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  assert.equal(defaultPhoneName(chromeOnMac, 0), "Chrome on Mac");
  assert.equal(defaultPhoneName(chromeOnWindows, 0), "Chrome on Windows");
  assert.equal(defaultPhoneName(edge, 0), "Edge on Windows");
  assert.equal(defaultPhoneName(opera, 0), "Opera on Windows");
  assert.equal(defaultPhoneName(chromeOnLinux, 0), "Chrome on Linux");
  assert.equal(defaultPhoneName(chromebook, 0), "Chrome on Chromebook");
  // A browser that says too little keeps the plain name.
  assert.equal(defaultPhoneName("Mozilla/5.0 (Windows NT 10.0)", 0), "Phone");
  assert.equal(defaultPhoneName("Chrome/130.0.0.0", 0), "Phone");
  assert.equal(defaultPhoneName("", 0), "Phone");
});

/**
 * Characters in SQL that do not show on screen but change what it runs or
 * how it reads. A lone carriage return ends a `--` comment for PostgreSQL yet
 * shows as a space, so `-- adds an index` + CR + `DROP TABLE accounts;` passes
 * for one comment. These are the classes the review plan fixes, as [first,
 * last] code points. A carriage return counts only with no line feed straight
 * after it, which has a test of its own.
 */
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000d, 0x000d],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isHidden(code: number): boolean {
  return HIDDEN_RANGES.some(([first, last]) => code >= first && code <= last);
}

/** A character's code as the markers write it, as in "U+200B". */
function codeText(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

test("finds exactly the hidden characters, checked at every character up to U+FFFF", () => {
  for (let code = 0; code <= 0xffff; code += 1) {
    assert.equal(hasHiddenCharacters(`a${String.fromCharCode(code)}b`), isHidden(code), codeText(code));
  }
  assert.equal(hasHiddenCharacters("\u{1F600} \u{20000}"), false);
  assert.equal(hasHiddenCharacters(""), false);
});

test("finds a carriage return only where no line feed comes straight after it", () => {
  for (const text of ["\r\n", "SELECT 1;\r\nSELECT 2;\r\n", "CREATE TABLE t (\r\n\tid integer\n);"]) {
    assert.equal(hasHiddenCharacters(text), false, JSON.stringify(text));
  }
  for (const text of ["\r", "SELECT 1;\r", "-- adds an index\rDROP TABLE accounts;", "\n\r", "\r\r\n", "\r\n\r"]) {
    assert.equal(hasHiddenCharacters(text), true, JSON.stringify(text));
  }
});

test("shows a lone carriage return as \u{240D} and the line break PostgreSQL reads it as", () => {
  assert.equal(showHiddenCharacters("-- adds an index\rDROP TABLE accounts;"), "-- adds an index\u{240D}\nDROP TABLE accounts;");
  assert.equal(showHiddenCharacters("SELECT 1;\r"), "SELECT 1;\u{240D}\n");
  assert.equal(showHiddenCharacters("SELECT 1;\r\r\nSELECT 2;"), "SELECT 1;\u{240D}\n\r\nSELECT 2;");
});

test("shows every other hidden character as its code between \u{27E6} and \u{27E7}", () => {
  assert.equal(showHiddenCharacters("DROP\u{200B} TABLE"), "DROP\u{27E6}U+200B\u{27E7} TABLE");
  const codes: number[] = [];
  for (let code = 0; code <= 0xffff; code += 1) {
    if (isHidden(code) && code !== 0x0d) codes.push(code);
  }
  const shown = showHiddenCharacters(String.fromCharCode(...codes));
  assert.equal(shown, codes.map((code) => `\u{27E6}${codeText(code)}\u{27E7}`).join(""));
  assert.equal(hasHiddenCharacters(shown), false);
});

test("changes nothing else, so SQL with nothing hidden shows as written, markup and all", () => {
  const sql = "CREATE TABLE notes (\r\n\tbody text DEFAULT '<b>caf\u{E9} &amp; cr\u{E8}me</b>'\n);";
  assert.equal(showHiddenCharacters(sql), sql);
});
