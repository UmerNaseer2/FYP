// Quick run on Deploy: the parts the panel works out before it sends anything
// (lib/quick-run.ts), and the AI rollback writer for SQL the person typed
// (lib/ai/features/rollback-write.ts), with a fake trial and a fake model.
// No database and no model are reached.

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {},
  syncMetadataTables: async () => undefined,
}));

import type { AiConfig } from "@/lib/ai/config";
import {
  buildRollbackWriteTask,
  checkRollbackWrite,
  scriptTrialBlock,
  tryScriptFirst,
} from "@/lib/ai/features/rollback-write";
import {
  isRollbackWriteAnswer,
  isRollbackWriteChecks,
  type RollbackWriteAnswer,
} from "@/lib/ai/features/rollback-write-view";
import type { TrialHook } from "@/lib/ai/features/sql-generate";
import { MockProvider } from "@/lib/ai/mock";
import { runAiTask, type AiDeps } from "@/lib/ai/run";
import { AI_OFF } from "@/lib/ai/settings";
import { readChangeTypeHeader } from "@/lib/change-type";
import {
  MAX_QUICK_SQL_CHARS,
  nextQuickVersion,
  QUICK_RUN_GROUP,
  quickGroupProblem,
  quickLevelLabel,
  quickRunLevel,
  quickRunSql,
  quickSqlProblem,
} from "@/lib/quick-run";
import { column, schema, table } from "./helpers/snapshots";

const ADD = "ALTER TABLE books ADD COLUMN gift_note text;";
const DROP = "ALTER TABLE books DROP COLUMN price;";

describe("quick run: the version it saves as", () => {
  test("a new group starts at the first version", () => {
    expect(nextQuickVersion(ADD, [])).toEqual({ version: "1.0.0", level: "additive", floor: null });
    expect(nextQuickVersion(ADD, [null, undefined])).toMatchObject({ version: "1.0.0", floor: null });
  });

  test("it goes above the highest version the ledger or GitHub has, by the change level", () => {
    expect(nextQuickVersion(ADD, ["1.2.0", "1.3.0"])).toEqual({ version: "1.4.0", level: "additive", floor: "1.3.0" });
    expect(nextQuickVersion(DROP, ["1.3.0", "1.2.0"])).toEqual({ version: "2.0.0", level: "breaking", floor: "1.3.0" });
    // GitHub ahead of the ledger: the run still goes above GitHub's highest.
    expect(nextQuickVersion(ADD, ["1.0.0", "1.5.2"]).version).toBe("1.6.0");
  });

  test("the level is the one Deploy records", () => {
    expect(quickRunLevel(ADD)).toBe("additive");
    expect(quickRunLevel(DROP)).toBe("breaking");
    expect(quickLevelLabel("breaking")).toBe("Breaking");
    expect(quickLevelLabel("additive")).toBe("Additive");
    expect(quickLevelLabel("patch")).toBe("Patch");
  });
});

describe("quick run: the text it sends", () => {
  test("is stamped with its level, and stamping again changes nothing", () => {
    const stamped = quickRunSql(ADD);
    expect(readChangeTypeHeader(stamped)).toBe("additive");
    expect(stamped).toContain(ADD);
    expect(quickRunSql(stamped)).toBe(stamped);
  });

  test("refuses empty SQL, SQL that is too long and its own transaction", () => {
    expect(quickSqlProblem("-- just a note", "SQL")).toMatch(/Type the SQL/);
    expect(quickSqlProblem("-- just a note", "rollback")).toMatch(/untick Save a rollback/);
    expect(quickSqlProblem(`${ADD}\n--${"x".repeat(MAX_QUICK_SQL_CHARS)}`, "SQL")).toMatch(/Keep it under/);
    expect(quickSqlProblem(`BEGIN;\n${ADD}\nCOMMIT;`, "SQL")).toMatch(/own transaction/);
    expect(quickSqlProblem(ADD, "SQL")).toBeNull();
  });

  test("the group name follows the rule for every saved script", () => {
    expect(QUICK_RUN_GROUP).toBe("quick-changes");
    expect(quickGroupProblem(QUICK_RUN_GROUP)).toBeNull();
    expect(quickGroupProblem("  quick-changes  ")).toBeNull();
    expect(quickGroupProblem("")).not.toBeNull();
    expect(quickGroupProblem("../escape")).not.toBeNull();
  });
});

function shop() {
  return schema(
    [
      table("books", [
        column("id", { isPrimaryKey: true, nullable: false }),
        column("title", { typeDisplay: "text" }),
        column("price", { typeDisplay: "numeric(10,2)" }),
      ]),
    ],
    { database: "secret_shop_db" }
  );
}

function reply(over: Partial<RollbackWriteAnswer> = {}): RollbackWriteAnswer {
  return {
    rollbackSql: "-- undo the gift note\nALTER TABLE books DROP COLUMN IF EXISTS gift_note;",
    summary: "Drops `gift_note` from `books`.",
    cannot: "",
    ...over,
  };
}

function task(sql = ADD, trial: TrialHook | { notTried: string } = { notTried: "Not in tests." }) {
  return buildRollbackWriteTask({ sql, schemaName: "public", snapshot: shop(), serverMajor: 17, trial });
}

describe("rollback writer: the prompt", () => {
  test("holds the person's SQL and the schema, never the database name", () => {
    const t = task();
    expect(t.spec.prompt).toContain(ADD);
    expect(t.spec.prompt).toContain("books");
    expect(t.spec.prompt).not.toContain("secret_shop_db");
    expect(t.spec.feature).toBe("sql-generate");
    expect(t.spec.cacheInput).toBeNull();
  });
});

describe("rollback writer: the checks", () => {
  test("a good rollback passes, untried when the trial is off", async () => {
    const t = task();
    const out = await checkRollbackWrite(reply(), t.facts);
    expect(out.problems).toEqual([]);
    expect(t.facts.last).toMatchObject({ statements: 1, trial: { status: "not-tried" } });
    expect(isRollbackWriteChecks(t.facts.last)).toBe(true);
    expect(isRollbackWriteAnswer(out.value)).toBe(true);
  });

  test("an empty rollback passes only when cannot says why", async () => {
    const t = task("DELETE FROM books WHERE price IS NULL;");
    const silent = await checkRollbackWrite(reply({ rollbackSql: "", cannot: "" }), t.facts);
    expect(silent.problems).toHaveLength(1);
    const said = await checkRollbackWrite(reply({ rollbackSql: "", cannot: "Deleted rows can't come back." }), t.facts);
    expect(said.problems).toEqual([]);
    expect(said.value.rollbackSql).toBe("");
    expect(t.facts.last?.statements).toBe(0);
  });

  test("a rollback that acts on the server or an unknown table goes back to the model", async () => {
    const t = task();
    const server = await checkRollbackWrite(reply({ rollbackSql: "SELECT pg_sleep(5);" }), t.facts);
    expect(server.problems.length).toBeGreaterThan(0);
    const unknown = await checkRollbackWrite(reply({ rollbackSql: "DROP TABLE invoices;", summary: "Drops it." }), t.facts);
    expect(unknown.problems.join(" ")).toMatch(/invoices/);
    expect(t.facts.last).toBeNull();
  });

  test("a table the person's SQL creates may be dropped by the rollback", async () => {
    const t = task("CREATE TABLE gift_cards (id int PRIMARY KEY);");
    const out = await checkRollbackWrite(
      reply({ rollbackSql: "DROP TABLE IF EXISTS gift_cards;", summary: "Drops `gift_cards`." }),
      t.facts
    );
    expect(out.problems).toEqual([]);
  });

  test("the summary may not name things that are nowhere", async () => {
    const t = task();
    const out = await checkRollbackWrite(reply({ summary: "Drops `gift_note` and `wishlists`." }), t.facts);
    expect(out.problems.join(" ")).toMatch(/wishlists/);
  });
});

describe("rollback writer: the try on the database", () => {
  test("the person's SQL is tried on its own first", async () => {
    const calls: Array<[string, string]> = [];
    const hook: TrialHook = async (sql, down) => {
      calls.push([sql, down]);
      return { status: "failed", step: "script", message: 'relation "books" does not exist' };
    };
    const t = task(ADD, hook);
    await expect(tryScriptFirst(t.facts)).resolves.toMatch(/does not exist/);
    expect(calls).toEqual([[ADD, ""]]);
    // With no trial there is nothing to try first.
    await expect(tryScriptFirst(task().facts)).resolves.toBeNull();
  });

  test("a rollback that fails after the SQL goes back to the model", async () => {
    const hook: TrialHook = async () => ({ status: "failed", step: "rollback", message: "column does not exist" });
    const t = task(ADD, hook);
    const out = await checkRollbackWrite(reply(), t.facts);
    expect(out.problems.join(" ")).toMatch(/rollback failed/);
  });

  test("SQL that fails on the second try keeps the rollback, untried", async () => {
    const hook: TrialHook = async () => ({ status: "failed", step: "script", message: "lock timeout" });
    const t = task(ADD, hook);
    const out = await checkRollbackWrite(reply(), t.facts);
    expect(out.problems).toEqual([]);
    expect(t.facts.last?.trial).toMatchObject({ status: "not-tried" });
  });

  test("a pass says the rollback was tried", async () => {
    const hook: TrialHook = async () => ({ status: "passed" });
    const t = task(ADD, hook);
    await checkRollbackWrite(reply(), t.facts);
    expect(t.facts.last?.trial).toEqual({ status: "passed", rollbackTried: true });
  });

  test("SQL the app never tries is checked but not tried", () => {
    expect(scriptTrialBlock("SELECT pg_sleep(1);", "public", shop())).toMatch(/never tries/);
    expect(scriptTrialBlock("SELECT nextval('books_id_seq');", "public", shop())).toMatch(/sequence/);
    expect(scriptTrialBlock(ADD, "public", shop())).toBeNull();
    const hook: TrialHook = async () => ({ status: "passed" });
    const t = task("SELECT nextval('books_id_seq');", hook);
    expect("notTried" in t.facts.trial).toBe(true);
  });
});

describe("rollback writer: the whole run", () => {
  function deps(replies: ConstructorParameters<typeof MockProvider>[0]): AiDeps {
    return {
      config: {
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        models: { fast: "fast-model", smart: "smart-model" },
      } as unknown as AiConfig,
      provider: new MockProvider(replies),
      readSettings: async () => ({ ...AI_OFF, enabled: true, features: { ...AI_OFF.features } }),
      store: {
        recordAiCall: async () => 1,
        callsToday: async () => 0,
        callsLastMinute: async () => 0,
        readSavedAnswer: (async () => null) as AiDeps["store"]["readSavedAnswer"],
        saveAnswer: async () => undefined,
      },
      now: () => 0,
    };
  }
  const caller = { orgId: 1, email: "ada@example.com" };

  test("a bad rollback is fixed on the next answer", async () => {
    const t = task();
    const result = await runAiTask(caller, t.spec, deps([reply({ rollbackSql: "DROP TABLE invoices;" }), reply()]));
    expect(result).toMatchObject({ kind: "ok", retries: 1 });
    expect(t.facts.last?.statements).toBe(1);
  });
});
