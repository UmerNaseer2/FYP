// The pure registry rules both push screens and the push route share. Each
// rule here guards a real failure: a version below the family that Deploy
// would never offer, a second spelling of one version, a folder name that
// splits into two, a comment-only rollback saved as if it undid something.
import {
  CHANGE_LEVELS,
  savedVersionLine,
  MAX_RETIRE_REASON_LENGTH,
  ROLLBACK_AND_NO_ROLLBACK,
  ROLLBACK_COMMENTS_ONLY,
  ROLLBACK_MISSING,
  SCRIPT_NAME_RULE,
  VERSION_FORMAT_HINT,
  attachRollbackKind,
  checkPushVersion,
  describeGitHubFailure,
  describePush,
  familyPathProblem,
  familyVersions,
  findRetiredNote,
  findVersionFiles,
  githubErrorCode,
  isRetiredVersion,
  normalizePushVersion,
  pulledRollbackState,
  pushCommitMessage,
  readChangeLevel,
  readRetireReason,
  readRetireVersion,
  retireCommitMessage,
  retiredMarkerText,
  retiredNoteVersions,
  rollbackChoiceProblem,
  rollbackCommitMessage,
  rollbackFileState,
  rollbackToSend,
  validateRegistrySegment,
  validateScriptName,
  type RegistryEntry,
} from "@/lib/github/registry-push";
import { parseRetiredMarkerName, retiredMarkerName } from "@/lib/github/registry-paths";

describe("validateRegistrySegment", () => {
  it("accepts ordinary database and schema names", () => {
    expect(validateRegistrySegment("schema", "public")).toBeNull();
    expect(validateRegistrySegment("database", "Sales-2024")).toBeNull();
    expect(validateRegistrySegment("database", "sales db")).toBeNull();
    expect(validateRegistrySegment("schema", "x".repeat(63))).toBeNull();
  });

  it("rejects names that would change or break the registry path", () => {
    const bad: unknown[] = ["", " public", "public ", "a/b", "a\\b", ".", "..", "tab\there", "x".repeat(64), 42, null, {}];
    for (const value of bad) {
      expect(validateRegistrySegment("schema", value)).toEqual(expect.any(String));
    }
  });

  it("names the field it is about", () => {
    expect(validateRegistrySegment("schema", "")).toContain("schema");
    expect(validateRegistrySegment("database", "a/b")).toContain("database");
  });

  it("counts bytes, not characters, against PostgreSQL's 63-byte limit", () => {
    // 32 accented letters are 32 characters but 64 bytes.
    const problem = validateRegistrySegment("schema", "é".repeat(32));
    expect(problem).toContain("64 bytes");
    expect(problem).toContain("63");
  });

  it("never echoes a name with an invisible character back", () => {
    const problem = validateRegistrySegment("schema", "secretname");
    expect(problem).not.toContain("secret");
  });
});

describe("validateScriptName", () => {
  it("accepts up to 150 characters", () => {
    expect(validateScriptName("a".repeat(150))).toBeNull();
    expect(validateScriptName("orders_fix-2")).toBeNull();
  });

  it("rejects 151 characters and says how long it was", () => {
    expect(validateScriptName("a".repeat(151))).toContain("151");
  });

  it("explains the allowed characters", () => {
    expect(validateScriptName("my script")).toContain(SCRIPT_NAME_RULE);
    expect(validateScriptName("../x")).toContain(SCRIPT_NAME_RULE);
  });

  // Both screens turn other characters into _, so "@@@" arrives as "___".
  it("needs at least one letter or digit", () => {
    expect(validateScriptName("___")).toContain("Add at least one letter or digit");
    expect(validateScriptName("-_-")).toContain("Add at least one letter or digit");
    expect(validateScriptName("_7")).toBeNull();
  });

  it("asks for a name when there is none", () => {
    expect(validateScriptName("")).toContain("Give the script a name");
    expect(validateScriptName(undefined)).toContain("Give the script a name");
  });
});

describe("familyPathProblem", () => {
  it("returns the first problem across database, schema and script", () => {
    expect(familyPathProblem("db", "public", "orders_fix")).toBeNull();
    expect(familyPathProblem("db", "..", "orders_fix")).toContain("schema");
    expect(familyPathProblem("db", "public", "my script")).toContain(SCRIPT_NAME_RULE);
  });
});

describe("normalizePushVersion", () => {
  it("stores every version as X.Y.Z", () => {
    expect(normalizePushVersion("1.2.3")).toEqual({ version: "1.2.3" });
    expect(normalizePushVersion("v1.2")).toEqual({ version: "1.2.0" });
    expect(normalizePushVersion(" 2 ")).toEqual({ version: "2.0.0" });
    expect(normalizePushVersion("V3.0.1")).toEqual({ version: "3.0.1" });
  });

  it("refuses anything that is not one to three numeric parts", () => {
    for (const raw of ["1.0.0.down", "latest", "1.2.3.4", "-1.0.0", "", "vv1.2", "1..2", 5, null]) {
      const result = normalizePushVersion(raw);
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.error.startsWith(VERSION_FORMAT_HINT)).toBe(true);
    }
  });

  it("shows what was typed, cut short", () => {
    const result = normalizePushVersion("x".repeat(100));
    expect("error" in result && result.error.length < 120).toBe(true);
    expect("error" in result && result.error.includes("...")).toBe(true);
  });
});

describe("findVersionFiles", () => {
  const entries: RegistryEntry[] = [
    { name: "v1.0.0.sql", sha: "sha-up-1", type: "file" },
    { name: "v1.0.0.down.sql", sha: "sha-down-1", type: "file" },
    { name: "v2.0.sql", sha: "sha-up-2", type: "file" },
    { name: "v3.0.0.down.sql", sha: "sha-orphan-3", type: "file" },
    { name: "README.md", sha: "sha-readme", type: "file" },
    // A folder is never a version, however it is named.
    { name: "v9.0.0.sql", sha: "sha-dir", type: "dir" },
  ];

  it("finds a migration saved under a shorter spelling", () => {
    expect(findVersionFiles(entries, "2.0.0")).toEqual({
      up: { name: "v2.0.sql", sha: "sha-up-2" },
      down: null,
      highest: "2.0",
    });
  });

  it("finds a leftover rollback with its sha, without letting it raise the highest", () => {
    expect(findVersionFiles(entries, "3.0.0")).toEqual({
      up: null,
      down: { name: "v3.0.0.down.sql", sha: "sha-orphan-3" },
      highest: "2.0",
    });
  });

  it("finds both files of a complete version", () => {
    const found = findVersionFiles(entries, "1.0");
    expect(found.up).toEqual({ name: "v1.0.0.sql", sha: "sha-up-1" });
    expect(found.down).toEqual({ name: "v1.0.0.down.sql", sha: "sha-down-1" });
  });

  it("reports no highest for an empty folder", () => {
    expect(findVersionFiles([], "1.0.0")).toEqual({ up: null, down: null, highest: null });
  });

  it("pairs a rollback with its migration only when both are spelled the same", () => {
    // The pull route never reads v1.2.0.down.sql as the rollback of v1.2.sql,
    // so neither may the push: it is no rollback of v1.2.
    const mixed: RegistryEntry[] = [
      { name: "v1.2.sql", sha: "sha-up" },
      { name: "v1.2.0.down.sql", sha: "sha-other-spelling" },
    ];
    expect(findVersionFiles(mixed, "1.2.0")).toEqual({
      up: { name: "v1.2.sql", sha: "sha-up" },
      down: null,
      highest: "1.2",
    });
    const paired = [...mixed, { name: "v1.2.down.sql", sha: "sha-down" }];
    expect(findVersionFiles(paired, "1.2.0").down).toEqual({ name: "v1.2.down.sql", sha: "sha-down" });
  });

  it("with no migration, picks the leftover that a new save of that version would collide with", () => {
    const leftovers: RegistryEntry[] = [
      { name: "v1.2.down.sql", sha: "sha-short" },
      { name: "v1.2.0.down.sql", sha: "sha-long" },
    ];
    expect(findVersionFiles(leftovers, "1.2.0").down).toEqual({ name: "v1.2.0.down.sql", sha: "sha-long" });
    expect(findVersionFiles(leftovers, "1.2").down).toEqual({ name: "v1.2.down.sql", sha: "sha-short" });
    // No leftover spelled that way: any rollback of the same version is still found.
    expect(findVersionFiles(leftovers.slice(0, 1), "1.2.0").down).toEqual({ name: "v1.2.down.sql", sha: "sha-short" });
  });
});

describe("familyVersions", () => {
  it("counts only versions with a migration as published", () => {
    const result = familyVersions([
      { name: "v1.10.0.sql", sha: "a" },
      { name: "v1.9.0.sql", sha: "b" },
      { name: "v1.1.down.sql", sha: "c" },
      { name: "notes.txt", sha: "d" },
    ]);
    expect(result.published).toEqual(["1.9.0", "1.10.0"]);
    // Keyed by the X.Y.Z spelling, whatever the file name used.
    expect(result.orphanRollbacks).toEqual({ "1.1.0": "c" });
  });
});

// A retired version keeps its files and gains a v<version>.retired.md note,
// so Deploy stops offering it. These rules read the notes.
describe("retired notes", () => {
  // v1.0 (an old spelling) and v1.2.0 are retired. v9.0.0's note sits beside
  // nothing, after its migration was deleted by hand.
  const folder: RegistryEntry[] = [
    { name: "v1.0.sql", sha: "a" },
    { name: "v1.0.0.retired.md", sha: "b" },
    { name: "v1.1.0.sql", sha: "c" },
    { name: "v1.2.0.sql", sha: "d" },
    { name: "v1.2.0.retired.md", sha: "e" },
    { name: "v9.0.0.retired.md", sha: "f" },
  ];

  it("keeps a retired version published, so its number stays taken, and lists it as retired", () => {
    const result = familyVersions(folder);
    expect(result.published).toEqual(["1.0", "1.1.0", "1.2.0"]);
    // In the migration's spelling. A note beside no migration retires nothing.
    expect(result.retired).toEqual(["1.0", "1.2.0"]);
    // A note is not a rollback either.
    expect(result.orphanRollbacks).toEqual({});
  });

  it("reads only file entries named like a note for a version", () => {
    const entries: RegistryEntry[] = [
      { name: "v1.0.0.retired.md", sha: "a", type: "file" },
      { name: "V2.0.0.RETIRED.MD", sha: "b" },
      { name: "v3.0.0.retired.md", sha: "c", type: "dir" },
      { name: "v4.0.0.sql", sha: "d", type: "file" },
      { name: "README.md", sha: "e", type: "file" },
      { name: "notes.retired.md", sha: "f", type: "file" },
      { name: "v5.0.0.retired.md.bak", sha: "g", type: "file" },
    ];
    expect(retiredNoteVersions(entries)).toEqual(["1.0.0", "2.0.0"]);
  });

  it("matches a retired version however either side spells it", () => {
    expect(isRetiredVersion(["1.0", "1.2.0"], "1.0.0")).toBe(true);
    expect(isRetiredVersion(["1.0", "1.2.0"], "1.2")).toBe(true);
    expect(isRetiredVersion(["1.0", "1.2.0"], "1.1.0")).toBe(false);
    expect(isRetiredVersion([], "1.0.0")).toBe(false);
  });

  it("finds a version's note, with its sha, under another spelling", () => {
    expect(findRetiredNote(folder, "1.0")).toEqual({ name: "v1.0.0.retired.md", sha: "b" });
    expect(findRetiredNote(folder, "1.2.0")).toEqual({ name: "v1.2.0.retired.md", sha: "e" });
    expect(findRetiredNote(folder, "1.1.0")).toBeNull();
  });

  it("names a note after its migration's spelling, and reads the name back", () => {
    expect(retiredMarkerName("1.2.0")).toBe("v1.2.0.retired.md");
    expect(retiredMarkerName("1.0")).toBe("v1.0.retired.md");
    expect(parseRetiredMarkerName("v1.2.0.retired.md")).toBe("1.2.0");
    expect(parseRetiredMarkerName("V1.2.0.RETIRED.MD")).toBe("1.2.0");
    expect(parseRetiredMarkerName("1.2.0.retired.md")).toBe("1.2.0");
    expect(parseRetiredMarkerName("v1.2.0.sql")).toBeNull();
    expect(parseRetiredMarkerName("v1.2.0.retired.md.bak")).toBeNull();
    expect(parseRetiredMarkerName(".retired.md")).toBeNull();
  });
});

describe("readRetireVersion", () => {
  it("drops a leading v and the spaces around it", () => {
    expect(readRetireVersion("v1.2.0")).toEqual({ version: "1.2.0" });
    expect(readRetireVersion("V1.2.0")).toEqual({ version: "1.2.0" });
    expect(readRetireVersion(" 1.2.0 ")).toEqual({ version: "1.2.0" });
  });

  it("accepts an old spelling or a pre-release, since the route retires only what the folder holds", () => {
    expect(readRetireVersion("1.0")).toEqual({ version: "1.0" });
    expect(readRetireVersion("2.0.0-rc1")).toEqual({ version: "2.0.0-rc1" });
  });

  it("asks for a version when there is none", () => {
    for (const raw of ["", "   ", undefined, null, 5]) {
      expect(readRetireVersion(raw)).toEqual({ error: "Say which version to retire." });
    }
  });

  it("refuses text that is not a version, including a path", () => {
    expect(readRetireVersion("abc")).toEqual({ error: '"abc" is not a version number, such as 1.2.0.' });
    expect(readRetireVersion("1.2.0/../x")).toEqual({ error: '"1.2.0/../x" is not a version number, such as 1.2.0.' });
    expect(readRetireVersion("v")).toEqual({ error: '"v" is not a version number, such as 1.2.0.' });
  });

  it("cuts a very long value short in the message", () => {
    const long = `1.${"0".repeat(49)}`;
    expect(readRetireVersion(long)).toEqual({
      error: `"${long.slice(0, 40)}..." is not a version number, such as 1.2.0.`,
    });
  });
});

describe("readRetireReason", () => {
  it("reads no reason as none", () => {
    expect(readRetireReason(undefined)).toEqual({ reason: null });
    expect(readRetireReason(null)).toEqual({ reason: null });
    expect(readRetireReason("  \n ")).toEqual({ reason: null });
  });

  it("keeps line breaks and tabs, written the same way whatever sent them", () => {
    expect(readRetireReason("  a\r\nb\rc\td  ")).toEqual({ reason: "a\nb\nc\td" });
  });

  it("allows 500 characters and refuses 501", () => {
    expect(MAX_RETIRE_REASON_LENGTH).toBe(500);
    expect(readRetireReason("x".repeat(500))).toEqual({ reason: "x".repeat(500) });
    expect(readRetireReason("x".repeat(501))).toEqual({
      error: "The reason is 501 characters long. Keep it to 500 characters or fewer.",
    });
  });

  it("refuses an invisible character nobody could see to remove", () => {
    for (const raw of ["bad\u0007one", "bad\u007fone", "bad\u0000one"]) {
      expect(readRetireReason(raw)).toEqual({
        error: "The reason contains an invisible character. Retype it and try again.",
      });
    }
  });

  it("refuses a reason that is not text", () => {
    expect(readRetireReason(5)).toEqual({ error: "The reason was sent, but not as text." });
    expect(readRetireReason({ text: "x" })).toEqual({ error: "The reason was sent, but not as text." });
  });
});

describe("retireCommitMessage and retiredMarkerText", () => {
  const IDENTITY = { database: "db", schema: "public", scriptName: "orders_fix", version: "1.2.0" };

  it("names the version in the subject and puts the reason in the body", () => {
    expect(retireCommitMessage(IDENTITY)).toBe("db/public/orders_fix v1.2.0: retire");
    expect(retireCommitMessage(IDENTITY, null)).toBe("db/public/orders_fix v1.2.0: retire");
    expect(retireCommitMessage(IDENTITY, "  ")).toBe("db/public/orders_fix v1.2.0: retire");
    expect(retireCommitMessage(IDENTITY, "Breaks the replica")).toBe(
      "db/public/orders_fix v1.2.0: retire\n\nBreaks the replica"
    );
  });

  it("cuts a very long body short", () => {
    const body = retireCommitMessage(IDENTITY, "y".repeat(1500)).split("\n\n")[1];
    expect(body).toHaveLength(1000);
    expect(body.endsWith("...")).toBe(true);
  });

  it("writes a note that says what retiring did, what it left alone, and how to undo it", () => {
    expect(retiredMarkerText(IDENTITY, "Breaks the replica", new Date("2026-11-19T12:00:00Z"))).toBe(
      "# v1.2.0 of orders_fix is retired\n\n" +
        "Deploy no longer offers this version to any database, so the versions after it can run.\n\n" +
        "- Its number stays taken: the next version must be higher.\n" +
        "- Databases that already ran it keep it, and can still roll it back.\n" +
        "- Its SQL stays in this folder.\n\n" +
        "Retired on 2026-11-19 (UTC).\n\n" +
        "Reason: Breaks the replica\n\n" +
        "To bring it back, delete this file.\n"
    );
  });

  it("says when no reason was given, and dates the note in UTC", () => {
    // Late evening west of UTC is already the next day in UTC.
    const note = retiredMarkerText(IDENTITY, null, new Date("2026-11-19T23:30:00-05:00"));
    expect(note).toContain("Retired on 2026-11-20 (UTC).");
    expect(note).toContain("\nNo reason given.\n");
    expect(note).not.toContain("Reason:");
  });
});

describe("checkPushVersion", () => {
  const published = ["1.0.0", "1.4.2"];

  it("accepts a new number above the family", () => {
    expect(checkPushVersion(published, "1.4.3", "orders_fix", "patch")).toEqual({ ok: true, highest: "1.4.2" });
    expect(checkPushVersion([], "1.0.0", "orders_fix", "patch")).toEqual({ ok: true, highest: null });
  });

  it("refuses a version that is already published and names the next free one", () => {
    const verdict = checkPushVersion(published, "1.4.2", "orders_fix", "additive");
    expect(verdict).toMatchObject({ ok: false, code: "version_exists", highest: "1.4.2", suggested: "1.5.0" });
    if (!verdict.ok) {
      expect(verdict.error).toContain("already in GitHub");
      expect(verdict.error).toContain("v1.5.0");
    }
  });

  it("treats 1.0 and 1.0.0 as the same version", () => {
    expect(checkPushVersion(["1.0"], "1.0.0", "orders_fix", "patch")).toMatchObject({ code: "version_exists" });
  });

  it("refuses a version below the family's highest, bumped at the script's level", () => {
    const verdict = checkPushVersion(published, "1.3.0", "orders_fix", "breaking");
    expect(verdict).toMatchObject({ ok: false, code: "version_not_newer", highest: "1.4.2", suggested: "2.0.0" });
    if (!verdict.ok) {
      expect(verdict.error).toContain("lower than v1.4.2");
      expect(verdict.error).toContain("v2.0.0");
    }
  });
});

describe("rollbackChoiceProblem and rollbackToSend", () => {
  const real = "ALTER TABLE orders DROP COLUMN note;";

  it("accepts a real rollback, or a ticked box with no rollback", () => {
    expect(rollbackChoiceProblem(real, false)).toBeNull();
    expect(rollbackChoiceProblem("", true)).toBeNull();
    expect(rollbackChoiceProblem(null, true)).toBeNull();
    expect(rollbackChoiceProblem("-- nothing to undo", true)).toBeNull();
  });

  it("refuses a real rollback with the no-rollback box ticked", () => {
    expect(rollbackChoiceProblem(real, true)).toBe(ROLLBACK_AND_NO_ROLLBACK);
  });

  it("refuses a silent save with no rollback", () => {
    expect(rollbackChoiceProblem("", false)).toBe(ROLLBACK_MISSING);
    expect(rollbackChoiceProblem("   \n", false)).toBe(ROLLBACK_MISSING);
    expect(rollbackChoiceProblem(undefined, false)).toBe(ROLLBACK_MISSING);
  });

  it("refuses a rollback made only of comments", () => {
    expect(rollbackChoiceProblem("-- undo later\n/* TODO */", false)).toBe(ROLLBACK_COMMENTS_ONLY);
  });

  it("sends the rollback only when it runs and the box is not ticked", () => {
    expect(rollbackToSend(real, false)).toBe(real);
    expect(rollbackToSend(real, true)).toBeUndefined();
    expect(rollbackToSend("-- undo later", false)).toBeUndefined();
    expect(rollbackToSend(null, false)).toBeUndefined();
  });
});

describe("rollbackFileState and attachRollbackKind", () => {
  it("classes a rollback file by whether anything in it runs", () => {
    expect(rollbackFileState(null)).toBe("none");
    expect(rollbackFileState(undefined)).toBe("none");
    expect(rollbackFileState("")).toBe("no_statements");
    expect(rollbackFileState("-- nothing")).toBe("no_statements");
    expect(rollbackFileState("DROP TABLE t;")).toBe("has_statements");
  });

  it("allows adding a missing or empty rollback, never replacing a real one", () => {
    expect(attachRollbackKind("none")).toBe("add_missing");
    expect(attachRollbackKind("no_statements")).toBe("replace_empty");
    expect(attachRollbackKind("has_statements")).toBeNull();
  });
});

describe("commit messages", () => {
  const identity = { database: "db", schema: "public", scriptName: "orders_fix", version: "1.2.0" };

  it("names database, schema, script and version", () => {
    expect(pushCommitMessage({ ...identity })).toBe("db/public/orders_fix v1.2.0");
    expect(pushCommitMessage({ ...identity, description: "Add a note column" })).toBe(
      "db/public/orders_fix v1.2.0: Add a note column",
    );
  });

  it("puts only the first description line in the subject and the full text in the body", () => {
    const message = pushCommitMessage({
      ...identity,
      description: "\n  Add a note column to orders\nSecond line with details",
    });
    const [subject, blank, ...body] = message.split("\n");
    expect(subject).toBe("db/public/orders_fix v1.2.0: Add a note column to orders");
    expect(blank).toBe("");
    expect(body.join("\n")).toBe("Add a note column to orders\nSecond line with details");
  });

  it("keeps the subject within 72 characters", () => {
    const message = pushCommitMessage({ ...identity, description: "x".repeat(200) });
    const subject = message.split("\n")[0];
    expect(subject.startsWith("db/public/orders_fix v1.2.0: ")).toBe(true);
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith("...")).toBe(true);
    expect(message).toContain("x".repeat(200));
  });

  it("caps the body at 1000 characters and never cuts the names", () => {
    const long = pushCommitMessage({ ...identity, description: "y".repeat(1500) });
    expect(long.split("\n\n")[1].length).toBe(1000);
    const bigName = { ...identity, scriptName: "a".repeat(100) };
    const message = pushCommitMessage({ ...bigName, description: "hello" });
    expect(message.startsWith(`db/public/${"a".repeat(100)} v1.2.0`)).toBe(true);
    expect(message.endsWith("hello")).toBe(true);
  });

  it("gives each rollback commit its own ending", () => {
    expect(rollbackCommitMessage("rollback", identity)).toBe("db/public/orders_fix v1.2.0: rollback");
    expect(rollbackCommitMessage("add_missing", identity)).toBe("db/public/orders_fix v1.2.0: add missing rollback");
    expect(rollbackCommitMessage("replace_empty", identity)).toBe("db/public/orders_fix v1.2.0: replace empty rollback");
    expect(rollbackCommitMessage("remove_leftover", identity)).toBe(
      "db/public/orders_fix v1.2.0: remove leftover rollback from an earlier failed save",
    );
  });
});

describe("commit messages with a change level", () => {
  const identity = { database: "db", schema: "public", scriptName: "orders_fix", version: "1.2.0" };

  it("puts the level in brackets after the version", () => {
    expect(pushCommitMessage({ ...identity, level: "additive" })).toBe("db/public/orders_fix v1.2.0 (additive)");
    expect(pushCommitMessage({ ...identity, level: "breaking", description: "Drop the note column" })).toBe(
      "db/public/orders_fix v1.2.0 (breaking): Drop the note column",
    );
  });

  it("leaves the brackets out when no level is given", () => {
    expect(pushCommitMessage({ ...identity, level: null })).toBe("db/public/orders_fix v1.2.0");
  });

  it("still keeps the subject within 72 characters", () => {
    const subject = pushCommitMessage({ ...identity, level: "patch", description: "z".repeat(200) }).split("\n")[0];
    expect(subject.startsWith("db/public/orders_fix v1.2.0 (patch): ")).toBe(true);
    expect(subject.length).toBeLessThanOrEqual(72);
  });
});

describe("readChangeLevel", () => {
  it("lists the three levels, loudest first", () => {
    expect(CHANGE_LEVELS).toEqual(["breaking", "additive", "patch"]);
  });

  it("accepts exactly the three levels", () => {
    for (const level of CHANGE_LEVELS) expect(readChangeLevel(level)).toBe(level);
  });

  it("refuses anything else rather than guessing", () => {
    // The level ends up in the file's Change-type line, which Deploy trusts.
    for (const value of ["major", "Breaking", " patch", "", "unknown", null, undefined, 1, {}]) {
      expect(readChangeLevel(value)).toBeNull();
    }
  });
});

describe("pulledRollbackState", () => {
  it("says none when the version has no rollback file", () => {
    expect(pulledRollbackState(null)).toBe("none");
  });

  it("says no_statements for a blank or comment-only rollback", () => {
    expect(pulledRollbackState("")).toBe("no_statements");
    expect(pulledRollbackState("-- write the undo here\n\n")).toBe("no_statements");
    expect(pulledRollbackState("/* later */ ;;")).toBe("no_statements");
  });

  it("says transaction_control when the rollback ends or opens its own transaction", () => {
    expect(pulledRollbackState("DROP INDEX orders_note_idx;\nCOMMIT;")).toBe("transaction_control");
    expect(pulledRollbackState("BEGIN; DROP TABLE t; ROLLBACK;")).toBe("transaction_control");
  });

  it("says usable for a rollback Deploy can run", () => {
    expect(pulledRollbackState("ALTER TABLE orders DROP COLUMN note;")).toBe("usable");
  });

  it("says unreadable when the file is there but could not be downloaded", () => {
    expect(pulledRollbackState(null, true)).toBe("unreadable");
    expect(pulledRollbackState("ALTER TABLE orders DROP COLUMN note;", true)).toBe("unreadable");
  });
});

describe("describeGitHubFailure and githubErrorCode", () => {
  const statuses = [401, 403, 404, 429, 500, 503, 418];

  it("explains each status differently, in words and without secrets", () => {
    const messages = statuses.map((status) => describeGitHubFailure(status, 'save v1.2.0 of "orders_fix"'));
    expect(new Set(messages).size).toBe(statuses.length);
    for (const message of messages) {
      expect(message).toContain('save v1.2.0 of "orders_fix"');
      expect(message).not.toContain("Bearer");
      expect(message).not.toMatch(/gh[pousr]_[A-Za-z0-9]/);
    }
    expect(messages[0]).toContain("GITHUB_PAT");
    expect(messages[2]).toContain("GITHUB_REPO_OWNER");
  });

  it("gives each kind of failure a stable code", () => {
    expect(githubErrorCode(401)).toBe("token_rejected");
    expect(githubErrorCode(403)).toBe("github_forbidden");
    expect(githubErrorCode(404)).toBe("repo_not_found");
    expect(githubErrorCode(409)).toBe("github_conflict");
    expect(githubErrorCode(422)).toBe("github_conflict");
    expect(githubErrorCode(429)).toBe("github_rate_limited");
    expect(githubErrorCode(503)).toBe("github_down");
    expect(githubErrorCode(418)).toBe("github_error");
  });
});

describe("savedVersionLine", () => {
  it("says the version is saved and what to do next", () => {
    expect(savedVersionLine("1.0.0")).toBe("v1.0.0 is saved in GitHub. Deploy it next.");
  });
});

describe("describePush", () => {
  it("names v1.0.0 as a family's first version", () => {
    expect(describePush({ floor: null, version: "1.0.0", withRollback: true })).toEqual({
      files: ["v1.0.0.sql", "v1.0.0.down.sql"],
      noRollbackLine: null,
      stepLine: "First version of this script group: v1.0.0",
      bump: null,
      isFirstVersion: true,
    });
    expect(describePush({ floor: "init", version: "1.0.0", withRollback: true }).isFirstVersion).toBe(true);
  });

  it("shows the bump and the step from the family's version", () => {
    const major = describePush({ floor: "1.4.2", version: "2.0.0", withRollback: true });
    expect(major.stepLine).toBe("Will become a major bump: v1.4.2 → v2.0.0");
    expect(major.bump).toBe("major");
    expect(describePush({ floor: "1.4.2", version: "1.5.0", withRollback: true }).bump).toBe("minor");
    expect(describePush({ floor: "1.4.2", version: "1.4.3", withRollback: true }).bump).toBe("patch");
  });

  it("says so when no rollback file will be written", () => {
    const preview = describePush({ floor: "1.4.2", version: "1.5.0", withRollback: false });
    expect(preview.files).toEqual(["v1.5.0.sql"]);
    expect(preview.noRollbackLine).toContain("No rollback file will be written");
    expect(preview.noRollbackLine).toContain("v1.5.0");
  });

  it("flags a number that is not above the family", () => {
    const preview = describePush({ floor: "2.0.0", version: "1.9.0", withRollback: true });
    expect(preview.bump).toBeNull();
    expect(preview.stepLine).toContain("can't be pushed");
  });
});
