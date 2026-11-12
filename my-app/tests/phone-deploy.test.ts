// phone-deploy: what a paired phone may start of a deploy or a rollback
// (lib/phone-deploy.ts), by the rules the Deploy screen works out in the browser.
//
// These rules are told the registry and the ledger, so these tests need no
// database and no network.
import {
  draftDeploy,
  draftRollback,
  familyChoices,
  familyFiles,
  listFamilies,
  nextStep,
  type LedgerRead,
  type RegistryScript,
} from "@/lib/phone-deploy";

function script(version: string, fields: Partial<RegistryScript> = {}): RegistryScript {
  return {
    database_name: "shop",
    schema_name: "public",
    script_name: "users",
    version,
    path: `shop/public/users/v${version}.sql`,
    sql_content: `CREATE TABLE t_${version.replaceAll(".", "_")} (id int);`,
    ...fields,
  };
}

function ledger(fields: Partial<LedgerRead> = {}): LedgerRead {
  return {
    currentVersion: null,
    timeline: [],
    applications: { known: false, names: [], source: null },
    otherScripts: [],
    ...fields,
  };
}

const TARGET = { connectionId: 5, schemaName: "public", scriptName: "users" };

/** One row of the ledger, with a rollback stored for it. */
function applied(version: string, at = `2026-10-0${version[0]}T10:00:00.000Z`) {
  return { version, applied_at: at, down_sql: `DROP TABLE t_${version.replaceAll(".", "_")};` };
}

describe("listFamilies", () => {
  it("lists one row per family of this database, by schema and then by name", () => {
    const families = listFamilies(
      [
        script("1.0.0"),
        script("1.10.0"),
        script("1.2.0"),
        script("1.0.0", { script_name: "accounts" }),
        script("3.0.0", { schema_name: "audit" }),
        script("9.0.0", { database_name: "other" }),
      ],
      "shop",
    );
    expect(families).toEqual([
      { schemaName: "audit", scriptName: "users", newestVersion: "3.0.0", versionCount: 1 },
      { schemaName: "public", scriptName: "accounts", newestVersion: "1.0.0", versionCount: 1 },
      // By version, not by text: 1.10.0 is newer than 1.2.0.
      { schemaName: "public", scriptName: "users", newestVersion: "1.10.0", versionCount: 3 },
    ]);
  });

  it("keeps a name with a character that could stand in for a separator apart", () => {
    const families = listFamilies(
      [script("1.0.0", { schema_name: 'a","b', script_name: "c" }), script("1.0.0", { schema_name: "a", script_name: 'b","c' })],
      "shop",
    );
    expect(families).toHaveLength(2);
  });
});

describe("familyFiles", () => {
  it("keeps only this database, schema and script", () => {
    const files = familyFiles(
      [script("1.0.0"), script("1.0.0", { database_name: "other" }), script("1.0.0", { schema_name: "audit" }), script("1.0.0", { script_name: "x" })],
      "shop",
      "public",
      "users",
    );
    expect(files).toHaveLength(1);
  });
});

describe("familyChoices", () => {
  it("offers every version above the current one, oldest first", () => {
    const choices = familyChoices(
      [script("3.0.0"), script("1.0.0"), script("2.0.0")],
      ledger({ currentVersion: "1.0.0", timeline: [applied("1.0.0")] }),
    );
    expect(choices.currentVersion).toBe("1.0.0");
    expect(choices.waiting).toEqual(["2.0.0", "3.0.0"]);
  });

  it("offers every version when nothing has run yet, and nothing to undo", () => {
    const choices = familyChoices([script("1.0.0"), script("2.0.0")], ledger());
    expect(choices.waiting).toEqual(["1.0.0", "2.0.0"]);
    expect(choices.undo).toEqual([]);
  });

  it("leaves out a script addressed to another application", () => {
    const elsewhere = script("2.0.0", { sql_content: "-- applies-to: billing\nCREATE TABLE b (id int);" });
    const choices = familyChoices(
      [script("1.0.0"), elsewhere, script("3.0.0")],
      ledger({ applications: { known: true, names: ["shop"], source: "table" } as LedgerRead["applications"] }),
    );
    expect(choices.waiting).toEqual(["1.0.0", "3.0.0"]);
  });

  it("offers each version it could go back to, nearest first, then before the first", () => {
    const choices = familyChoices(
      [script("1.0.0")],
      ledger({ currentVersion: "2.0.0", timeline: [applied("1.0.0"), applied("2.0.0")] }),
    );
    expect(choices.undo).toEqual([
      { target: "1.0.0", undoCount: 1 },
      { target: null, undoCount: 2 },
    ]);
  });
});

describe("draftDeploy", () => {
  it("runs every waiting version up to the one asked for, oldest first", () => {
    const draft = draftDeploy(
      { ...TARGET, targetVersion: "3.0.0" },
      [script("4.0.0"), script("3.0.0"), script("2.0.0"), script("1.0.0")],
      ledger({ currentVersion: "1.0.0" }),
      null,
    );
    expect(draft.problem).toBeNull();
    expect(draft.scripts.map((each) => each.version)).toEqual(["2.0.0", "3.0.0"]);
    expect(draft.run.path).toBe("/api/scripts/apply");
    expect(draft.run.body).toMatchObject({ connectionId: 5, schemaName: "public", dryRun: false });
    const sent = (draft.run.body as { scripts: { version: string; source_ref: string }[] }).scripts;
    expect(sent.map((each) => each.version)).toEqual(["2.0.0", "3.0.0"]);
    expect(sent[0].source_ref).toBe("shop/public/users/v2.0.0.sql");
  });

  it("never carries an acknowledgement: only the signed ticks add those", () => {
    const draft = draftDeploy({ ...TARGET, targetVersion: "1.0.0" }, [script("1.0.0")], ledger(), null);
    expect(Object.keys(draft.run.body).filter((key) => key.startsWith("acknowledge"))).toEqual([]);
  });

  it("sends a rollback only when the file has one", () => {
    const withDown = script("1.0.0", { down_sql: "DROP TABLE a;" });
    const draft = draftDeploy({ ...TARGET, targetVersion: "2.0.0" }, [withDown, script("2.0.0")], ledger(), null);
    const sent = (draft.run.body as { scripts: { version: string; down_sql?: string }[] }).scripts;
    expect(sent[0].down_sql).toBe("DROP TABLE a;");
    expect("down_sql" in sent[1]).toBe(false);
  });

  it("has nothing to do for a version that is not waiting", () => {
    const family = [script("1.0.0"), script("2.0.0")];
    const onLedger = ledger({ currentVersion: "1.0.0" });
    expect(draftDeploy({ ...TARGET, targetVersion: "1.0.0" }, family, onLedger, null).problem).toBe("nothing-to-do");
    expect(draftDeploy({ ...TARGET, targetVersion: "9.0.0" }, family, onLedger, null).problem).toBe("nothing-to-do");
    expect(draftDeploy({ ...TARGET, targetVersion: null }, family, onLedger, null).problem).toBe("nothing-to-do");
  });

  it("refuses a script that controls its own transaction", () => {
    const draft = draftDeploy(
      { ...TARGET, targetVersion: "1.0.0" },
      [script("1.0.0", { sql_content: "BEGIN; CREATE TABLE a (id int); COMMIT;" })],
      ledger(),
      null,
    );
    expect(draft.problem).toBe("transaction-control");
  });

  it("names what would lose data", () => {
    const draft = draftDeploy(
      { ...TARGET, targetVersion: "1.0.0" },
      [script("1.0.0", { sql_content: "DROP TABLE orders;" })],
      ledger(),
      null,
    );
    expect(draft.risks.dataLoss).toEqual(["users v1.0.0"]);
  });

  it("passes on the stored drift only when it should give someone pause", () => {
    const run = (status: string | null) =>
      draftDeploy({ ...TARGET, targetVersion: "1.0.0" }, [script("1.0.0")], ledger(), status).risks.drift;
    expect(run("drifted")).toBe("drifted");
    expect(run("unreachable")).toBe("unreachable");
    expect(run("in_sync")).toBeNull();
    expect(run(null)).toBeNull();
  });

  it("asks for approval with the same scripts in the same order", () => {
    const draft = draftDeploy({ ...TARGET, targetVersion: "2.0.0" }, [script("2.0.0"), script("1.0.0")], ledger(), null);
    expect(draft.approvalRequest).toMatchObject({ action: "deploy", connectionId: 5, targetVersion: "2.0.0" });
    const asked = (draft.approvalRequest as { scripts: { version: string }[] }).scripts;
    expect(asked.map((each) => each.version)).toEqual(["1.0.0", "2.0.0"]);
  });
});

describe("draftRollback", () => {
  const timeline = [applied("1.0.0"), applied("2.0.0"), applied("3.0.0")];
  const onLedger = ledger({ currentVersion: "3.0.0", timeline });

  it("undoes every version above the target, newest first", () => {
    const draft = draftRollback({ ...TARGET, targetVersion: "1.0.0" }, [], onLedger);
    expect(draft.problem).toBeNull();
    expect(draft.scripts.map((each) => each.version)).toEqual(["3.0.0", "2.0.0"]);
    expect(draft.scripts[0].sqlContent).toBe("DROP TABLE t_3_0_0;");
    expect(draft.run).toMatchObject({
      path: "/api/scripts/revert",
      body: { connectionId: 5, schemaName: "public", script_name: "users", versions: ["3.0.0", "2.0.0"], dryRun: false },
    });
  });

  it("goes before the first version for a null target", () => {
    const draft = draftRollback({ ...TARGET, targetVersion: null }, [], onLedger);
    expect(draft.scripts.map((each) => each.version)).toEqual(["3.0.0", "2.0.0", "1.0.0"]);
    // The oldest version undone, as the Deploy screen asks for it.
    expect(draft.approvalRequest).toMatchObject({ action: "revert", targetVersion: "1.0.0" });
  });

  it("has nothing to do for a target it would not offer", () => {
    expect(draftRollback({ ...TARGET, targetVersion: "3.0.0" }, [], onLedger).problem).toBe("nothing-to-do");
    expect(draftRollback({ ...TARGET, targetVersion: "9.0.0" }, [], onLedger).problem).toBe("nothing-to-do");
    expect(draftRollback({ ...TARGET, targetVersion: null }, [], ledger()).problem).toBe("nothing-to-do");
  });

  it("refuses when a step has no rollback that can run", () => {
    const noDown = ledger({
      currentVersion: "2.0.0",
      timeline: [applied("1.0.0"), { version: "2.0.0", applied_at: "2026-10-02T10:00:00.000Z", down_sql: null }],
    });
    const draft = draftRollback({ ...TARGET, targetVersion: "1.0.0" }, [], noDown);
    expect(draft.problem).toBe("no-rollback");
  });

  it("uses a rollback from the registry, and sends it along", () => {
    const noDown = ledger({
      currentVersion: "2.0.0",
      timeline: [applied("1.0.0"), { version: "2.0.0", applied_at: "2026-10-02T10:00:00.000Z", down_sql: null }],
    });
    const draft = draftRollback(
      { ...TARGET, targetVersion: "1.0.0" },
      [script("2.0.0", { down_sql: "DROP TABLE from_registry;" })],
      noDown,
    );
    expect(draft.problem).toBeNull();
    expect((draft.run.body as { registryRollbacks: unknown[] }).registryRollbacks).toEqual([
      { version: "2.0.0", down_sql: "DROP TABLE from_registry;" },
    ]);
  });

  it("names what would lose data, and what ran after what it would undo", () => {
    const withOthers = ledger({
      currentVersion: "3.0.0",
      timeline,
      otherScripts: [
        { script_name: "before", version: "1.0.0", applied_at: "2026-10-01T09:00:00.000Z" },
        { script_name: "after", version: "2.0.0", applied_at: "2026-10-02T11:00:00.000Z" },
        { script_name: "undated", version: "3.0.0", applied_at: null },
      ],
    });
    const draft = draftRollback({ ...TARGET, targetVersion: "1.0.0" }, [], withOthers);
    expect(draft.risks.dataLoss).toEqual(["users v3.0.0", "users v2.0.0"]);
    expect(draft.risks.otherScripts).toEqual(["after v2.0.0", "undated v3.0.0"]);
  });

  it("has no drift rule, as the revert route has none", () => {
    expect(draftRollback({ ...TARGET, targetVersion: "1.0.0" }, [], onLedger).risks.drift).toBeNull();
  });
});

describe("nextStep", () => {
  const free = { approvalNeeded: false, approval: null, readOnly: false, mayRun: true, mayAsk: true } as const;

  it("lets a run go straight off production", () => {
    expect(nextStep(null, free)).toEqual({ next: "run", blockedReason: null });
  });

  it("names the rule a person cannot run past off production", () => {
    expect(nextStep(null, { ...free, mayRun: false })).toEqual({ next: "blocked", blockedReason: "role" });
    expect(nextStep(null, { ...free, readOnly: true })).toEqual({ next: "blocked", blockedReason: "read-only" });
  });

  it("puts a problem with the run before anything about the person", () => {
    expect(nextStep("no-rollback", { ...free, readOnly: true, mayRun: false })).toEqual({
      next: "blocked",
      blockedReason: "no-rollback",
    });
  });

  const production = { ...free, approvalNeeded: true };

  it("sends production to the queue when nobody has been asked", () => {
    expect(nextStep(null, production)).toEqual({ next: "ask-approval", blockedReason: null });
    // Asking needs no right to run.
    expect(nextStep(null, { ...production, mayRun: false })).toEqual({ next: "ask-approval", blockedReason: null });
    expect(nextStep(null, { ...production, mayAsk: false })).toEqual({ next: "blocked", blockedReason: "role" });
  });

  it("waits for a request nobody has decided, whoever is asking", () => {
    expect(nextStep(null, { ...production, approval: "pending", mayRun: false, mayAsk: false })).toEqual({
      next: "waiting",
      blockedReason: null,
    });
  });

  it("runs production once this exact run is approved", () => {
    expect(nextStep(null, { ...production, approval: "approved" })).toEqual({ next: "run-approved", blockedReason: null });
    expect(nextStep(null, { ...production, approval: "approved", mayRun: false })).toEqual({
      next: "blocked",
      blockedReason: "role",
    });
  });

  it("will not ask for a run nobody could ever run on a read-only connection", () => {
    expect(nextStep(null, { ...production, readOnly: true })).toEqual({ next: "blocked", blockedReason: "read-only" });
    expect(nextStep(null, { ...production, approval: "approved", readOnly: true })).toEqual({
      next: "blocked",
      blockedReason: "read-only",
    });
  });
});
