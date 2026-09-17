// lib/deploy-risk: the one reading of what a run risks, and the forward-only
// rule. The Deploy page, Version Sync, the apply route and the approvals route
// all call these, so these tests pin the answers every one of them gets.
import { louderChangeType } from "@/lib/change-type";
import {
  analyseRunRisk,
  checkForwardOnly,
  listLabels,
  readScriptLevel,
  scriptLabel,
  type RiskScript,
} from "@/lib/deploy-risk";

/** One migration of orders_fix. */
const script = (version: string, sqlContent: string, changeType?: unknown): RiskScript => ({
  scriptName: "orders_fix",
  version,
  sqlContent,
  changeType,
});

describe("scriptLabel and listLabels", () => {
  it("names a script by its version, and quotes a version that is not one", () => {
    expect(scriptLabel("orders_fix", "2.0.0")).toBe("orders_fix v2.0.0");
    expect(scriptLabel("orders_fix", "unknown")).toBe('orders_fix "unknown"');
  });

  it("joins names the way a sentence does, and counts past five", () => {
    expect(listLabels([])).toBe("");
    expect(listLabels(["a"])).toBe("a");
    expect(listLabels(["a", "b"])).toBe("a and b");
    expect(listLabels(["a", "b", "c"])).toBe("a, b and c");
    expect(listLabels(["a", "b", "c", "d", "e", "f", "g"])).toBe("a, b, c, d, e and 2 more");
  });
});

describe("readScriptLevel", () => {
  it("stores the SQL's own level when no level is sent, never 'unknown'", () => {
    expect(readScriptLevel({ sqlContent: "CREATE TABLE a (id int);" })).toEqual({
      stored: "additive",
      breaking: false,
      louderNote: null,
    });
  });

  it("lets a sent level raise the stored level and ignores anything that is not a level", () => {
    const sql = "CREATE TABLE a (id int);";
    expect(readScriptLevel({ sqlContent: sql, changeType: "breaking" })).toMatchObject({
      stored: "breaking",
      breaking: true,
    });
    // Quieter than the SQL: the SQL's level stands.
    expect(readScriptLevel({ sqlContent: sql, changeType: "patch" }).stored).toBe("additive");
    for (const ignored of ["unknown", "BREAKING ", 3, null, undefined]) {
      expect(readScriptLevel({ sqlContent: sql, changeType: ignored })).toMatchObject({
        stored: "additive",
        breaking: false,
      });
    }
  });
});

describe("analyseRunRisk", () => {
  it("does not count a patch-stamped ALTER COLUMN ... SET DEFAULT as breaking", () => {
    const risk = analyseRunRisk([
      script("1.0.1", "-- Change-type: patch\nALTER TABLE orders ALTER COLUMN status SET DEFAULT 'new';"),
    ]);
    expect(risk).toEqual({ breaking: [], dataLoss: [], mightFail: [], enumAdditions: [] });
  });

  it("counts a DROP VIEW with no stamp as breaking, without calling it data loss", () => {
    const risk = analyseRunRisk([script("2.0.0", "DROP VIEW v_orders;")]);
    expect(risk.breaking).toEqual([
      { label: "orders_fix v2.0.0", scriptName: "orders_fix", version: "2.0.0", louderNote: null },
    ]);
    expect(risk.dataLoss).toEqual([]);
  });

  it("counts a patch as breaking when the caller sends 'breaking' with it", () => {
    const sql = "ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'new';";
    // The SQL alone reads as a patch...
    expect(readScriptLevel({ sqlContent: sql }).stored).toBe("patch");
    expect(analyseRunRisk([script("1.0.1", sql)]).breaking).toEqual([]);
    // ...and the caller's word makes it breaking.
    expect(analyseRunRisk([script("1.0.1", sql, "breaking")]).breaking.map((entry) => entry.label)).toEqual([
      "orders_fix v1.0.1",
    ]);
  });

  it("does not let a sent 'additive' quiet a script stamped breaking", () => {
    const sql = "-- Change-type: breaking\nCREATE TABLE a (id int);";
    expect(analyseRunRisk([script("3.0.0", sql, "additive")]).breaking).toHaveLength(1);
    expect(readScriptLevel({ sqlContent: sql, changeType: "additive" }).stored).toBe("breaking");
  });

  it("carries the note when the SQL says more than its stamp", () => {
    const [entry] = analyseRunRisk([script("1.1.0", "-- Change-type: additive\nDROP TABLE old_orders;")]).breaking;
    expect(entry.louderNote).not.toBeNull();
  });

  it("reads a DROP that safe mode left commented out as neither data loss nor breaking", () => {
    const sql = [
      "-- SAFE MODE IS ON. 1 statement (1 destructive) is commented out below",
      "-- and will NOT run. Each one is marked [NOT EXECUTED].",
      "-- [NOT EXECUTED] ALTER TABLE orders DROP COLUMN note;",
      "CREATE TABLE audit (id int);",
    ].join("\n");
    const risk = analyseRunRisk([script("1.2.0", sql)]);
    expect(risk.breaking).toEqual([]);
    expect(risk.dataLoss).toEqual([]);
  });

  it("names the statements that delete rows, script by script", () => {
    const risk = analyseRunRisk([
      script("2.0.0", "ALTER TABLE orders DROP COLUMN note;"),
      script("2.1.0", "TRUNCATE audit_log;"),
    ]);
    expect(risk.dataLoss).toEqual([
      { label: "orders_fix v2.0.0", scriptName: "orders_fix", version: "2.0.0", kinds: ["DROP COLUMN"] },
      { label: "orders_fix v2.1.0", scriptName: "orders_fix", version: "2.1.0", kinds: ["TRUNCATE"] },
    ]);
    // A dropped column is breaking as well; a TRUNCATE moves no structure, so it is not.
    expect(risk.breaking.map((entry) => entry.version)).toEqual(["2.0.0"]);
  });

  it("counts a DELETE inside a DO block as data loss, the only warning it gets", () => {
    const sql =
      "DO $$ BEGIN IF EXISTS (SELECT 1 FROM orders WHERE archived) THEN " +
      "DELETE FROM orders WHERE archived; END IF; END $$;";
    const risk = analyseRunRisk([script("1.0.2", sql)]);
    expect(risk.dataLoss).toEqual([
      { label: "orders_fix v1.0.2", scriptName: "orders_fix", version: "1.0.2", kinds: ["DELETE"] },
    ]);
    expect(risk.breaking).toEqual([]);
  });

  it("warns about statements existing rows can refuse, and reads enum additions across the run", () => {
    const risk = analyseRunRisk([
      script("1.3.0", "ALTER TABLE orders ADD COLUMN ref text NOT NULL;"),
      script("1.4.0", "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'calm';"),
    ]);
    expect(risk.mightFail).toEqual([
      {
        label: "orders_fix v1.3.0",
        scriptName: "orders_fix",
        version: "1.3.0",
        kinds: ["NOT NULL column with no default"],
      },
    ]);
    expect(risk.enumAdditions).toHaveLength(1);
    expect(risk.enumAdditions[0]).toContain("calm");
  });
});

describe("checkForwardOnly", () => {
  const run = (...versions: string[]) => versions.map((version) => ({ scriptName: "orders_fix", version }));

  it("passes an ascending run on an empty ledger", () => {
    expect(checkForwardOnly(run("1.0.0", "1.1.0", "2.0.0"), {})).toBeNull();
  });

  it("refuses 'v5.0.1' when '5.0.1' is already applied", () => {
    const problem = checkForwardOnly(run("v5.0.1"), { orders_fix: ["5.0.1"] });
    expect(problem).toMatchObject({ index: 0, reason: "Already applied to this schema." });
    expect(problem?.message).toContain('is already applied (recorded as "5.0.1")');
  });

  it("refuses a version below the one already applied", () => {
    const problem = checkForwardOnly(run("4.0.0"), { orders_fix: ["3.0.0", "5.0.0"] });
    expect(problem).toMatchObject({ index: 0, reason: "A higher version is already applied." });
    expect(problem?.message).toBe(
      "orders_fix v4.0.0 cannot run: v5.0.0 is already applied and deploys only move forward. " +
        "Check the target database again to see what is pending now. Nothing ran."
    );
  });

  it("refuses [v3.0.0, v2.0.0] at the second one", () => {
    const problem = checkForwardOnly(run("3.0.0", "2.0.0"), {});
    expect(problem).toMatchObject({ index: 1, reason: "Out of order in this run." });
    expect(problem?.message).toBe(
      "orders_fix v2.0.0 is listed after v3.0.0 in this run. Versions of one script must run in " +
        "ascending order. Nothing ran."
    );
  });

  it("refuses '1.2' and '1.2.0' in one run as the same version twice", () => {
    const problem = checkForwardOnly(run("1.2", "1.2.0"), {});
    expect(problem).toMatchObject({ index: 1, reason: "Listed twice in this run." });
    expect(problem?.message).toContain("is listed twice in this run");
  });

  it("judges each script family on its own", () => {
    const queue = [
      { scriptName: "orders_fix", version: "2.0.0" },
      { scriptName: "billing_fix", version: "1.0.0" },
    ];
    // billing_fix is not held back by orders_fix's ledger, nor by its place in the run.
    expect(checkForwardOnly(queue, { orders_fix: ["1.0.0"], billing_fix: [] })).toBeNull();
    // A lower orders_fix later in the run is caught even with another family between.
    const problem = checkForwardOnly([...queue, { scriptName: "orders_fix", version: "1.5.0" }], {});
    expect(problem).toMatchObject({ index: 2, reason: "Out of order in this run." });
  });

  it("lets a legacy 'unknown' ledger row block nothing", () => {
    expect(checkForwardOnly(run("1.0.0"), { orders_fix: ["unknown"] })).toBeNull();
  });

  // The script-name rule allows any letters, so these are names an author can
  // really type. On a plain object each of them is answered by a built-in from
  // the prototype rather than by the ledger — a function for "constructor",
  // Object.prototype itself for "__proto__" — and neither has .filter, so the
  // whole deploy request died with a type error before any check had run.
  it("treats a script named after a built-in as having no ledger", () => {
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const queue = [{ scriptName: name, version: "1.0.0" }];
      expect(checkForwardOnly(queue, {})).toBeNull();
    }
  });

  it("still reads a real ledger for such a name", () => {
    // Own properties are found as they always were — the guard only stops the
    // prototype from answering for a name the ledger says nothing about.
    const queue = [{ scriptName: "constructor", version: "1.0.0" }];
    const problem = checkForwardOnly(queue, { constructor: ["1.0.0"] });
    expect(problem).toMatchObject({ index: 0, reason: "Already applied to this schema." });
  });

  it("ends every refusal by saying nothing ran", () => {
    const problems = [
      checkForwardOnly(run("1.0.0"), { orders_fix: ["1.0.0"] }),
      checkForwardOnly(run("1.0.0"), { orders_fix: ["2.0.0"] }),
      checkForwardOnly(run("1.0.0", "1.0.0"), {}),
      checkForwardOnly(run("2.0.0", "1.0.0"), {}),
    ];
    for (const problem of problems) {
      expect(problem?.message.endsWith("Nothing ran.")).toBe(true);
      // The same refusal without that ending, for the route's one refusal
      // that comes after something was written (step 8a).
      expect(problem?.message).toBe(`${problem?.refusal} Nothing ran.`);
      expect(problem?.refusal).not.toContain("Nothing ran");
    }
  });
});

describe("louderChangeType", () => {
  it("never lets 'unknown' replace a level", () => {
    expect(louderChangeType("patch", "unknown")).toBe("patch");
  });
});
