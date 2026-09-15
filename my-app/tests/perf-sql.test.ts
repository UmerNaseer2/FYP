/**
 * The SQL helpers both performance tabs print with (lib/perf-sql.ts).
 *
 * Small, but everything a person pastes into a server goes through them, so a
 * mistake here is a statement that fails, or one that names a different
 * table from the one the finding was about.
 */

import {
  LARGE_TABLE_ROWS,
  MAX_MIGRATION_DESCRIPTION,
  MAX_NAME_BYTES,
  buildFixScript,
  changesWithoutUndo,
  constraintName,
  createExpressionIndexSql,
  createIndexSql,
  fixScriptFileName,
  indexName,
  otherSchemaHeading,
  otherSchemas,
  qualifiedName,
  quoteIdent,
  schemasPhrase,
  type FixScriptItem,
} from "@/lib/perf-sql";
import { maskNonCode } from "@/lib/sql-guard";
import { fixProblems } from "./helpers/fix-invariants";

/** Bytes in UTF-8, the unit PostgreSQL's 63-byte name limit counts in. */
const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("quoteIdent", () => {
  it("wraps a plain name in double quotes", () => {
    expect(quoteIdent("orders")).toBe('"orders"');
  });

  it("keeps capital letters, which an unquoted name would lose", () => {
    // PostgreSQL folds an unquoted Order to order, a different table.
    expect(quoteIdent("Order")).toBe('"Order"');
  });

  it("doubles a double quote inside the name", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it("quotes a reserved word so it reads as a name", () => {
    expect(quoteIdent("user")).toBe('"user"');
  });
});

describe("qualifiedName", () => {
  it("puts the quoted schema in front of the quoted name", () => {
    expect(qualifiedName("public", "orders")).toBe('"public"."orders"');
  });

  it("quotes each half on its own, so a dot in a name stays part of it", () => {
    expect(qualifiedName("my.schema", "Line Items")).toBe('"my.schema"."Line Items"');
  });
});

describe("LARGE_TABLE_ROWS", () => {
  it("is the one threshold both tabs share", () => {
    // Changing this changes both tabs at once; the test is here so that
    // happens on purpose.
    expect(LARGE_TABLE_ROWS).toBe(10_000);
  });
});

describe("indexName", () => {
  it("is table_columns_idx, the name PostgreSQL would pick itself", () => {
    expect(indexName("orders", "customer_id", [])).toBe("orders_customer_id_idx");
  });

  it("counts up _idx1, _idx2 while the name is taken", () => {
    expect(indexName("orders", "customer_id", ["orders_customer_id_idx"])).toBe(
      "orders_customer_id_idx1"
    );
    expect(
      indexName("orders", "customer_id", ["orders_customer_id_idx", "orders_customer_id_idx1"])
    ).toBe("orders_customer_id_idx2");
  });

  it("ignores taken names that belong to something else", () => {
    expect(indexName("orders", "status", ["orders_customer_id_idx", "customers"])).toBe(
      "orders_status_idx"
    );
  });

  it("keeps a long ASCII name to 63 bytes and still ends in _idx", () => {
    const name = indexName("a".repeat(60), "b".repeat(60), []);
    expect(bytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(name.endsWith("_idx")).toBe(true);
    // Both halves shortened evenly, so both stay recognisable.
    expect(name).toBe(`${"a".repeat(29)}_${"b".repeat(29)}_idx`);
  });

  it("counts bytes, not characters, and never cuts a character in half", () => {
    // "é" is two bytes and "表" three, so 40 of them are 80 and 120 bytes:
    // well under 63 characters, well over 63 bytes.
    const name = indexName("é".repeat(40), "表".repeat(40), []);
    expect(bytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(name.endsWith("_idx")).toBe(true);
    // Round-tripping through UTF-8 would mangle a half-cut character.
    expect(new TextDecoder().decode(new TextEncoder().encode(name))).toBe(name);
    expect(name).toMatch(/^é+_表+_idx$/);
  });

  it("still fits when the counter makes the label longer", () => {
    const long = indexName("t".repeat(60), "c".repeat(60), []);
    const next = indexName("t".repeat(60), "c".repeat(60), [long]);
    expect(next).not.toBe(long);
    expect(bytes(next)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(next.endsWith("_idx1")).toBe(true);
  });
});

describe("createIndexSql", () => {
  it("names the index, quotes everything and qualifies the table", () => {
    const index = createIndexSql("public", "orders", ["customer_id"], []);
    expect(index.name).toBe("orders_customer_id_idx");
    expect(index.sql).toContain(
      'CREATE INDEX "orders_customer_id_idx" ON "public"."orders" ("customer_id");'
    );
    expect(index.undo).toBe('DROP INDEX "public"."orders_customer_id_idx";');
  });

  it("keeps the column order it is given", () => {
    const index = createIndexSql("public", "orders", ["status", "created_at"], []);
    expect(index.sql).toContain('("status", "created_at");');
    expect(index.name).toBe("orders_status_created_at_idx");
  });

  it("quotes a name with a space or capitals so it pastes as written", () => {
    const index = createIndexSql("Sales", "Order Lines", ["Order Id"], []);
    expect(index.sql).toContain(
      'CREATE INDEX "Order Lines_Order Id_idx" ON "Sales"."Order Lines" ("Order Id");'
    );
    expect(index.undo).toBe('DROP INDEX "Sales"."Order Lines_Order Id_idx";');
  });

  it("takes the next free name, and the undo drops that same name", () => {
    const index = createIndexSql("public", "orders", ["customer_id"], ["orders_customer_id_idx"]);
    expect(index.name).toBe("orders_customer_id_idx1");
    expect(index.sql).toContain('CREATE INDEX "orders_customer_id_idx1"');
    expect(index.undo).toBe('DROP INDEX "public"."orders_customer_id_idx1";');
  });

  it("mentions CONCURRENTLY only in a comment, so it can run in a transaction", () => {
    // CREATE INDEX CONCURRENTLY refuses to run inside a transaction block,
    // and every migration the app applies runs in one.
    const index = createIndexSql("public", "orders", ["customer_id"], []);
    const code = index.sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/CONCURRENTLY/i);
    expect(index.sql).toMatch(/--.*CONCURRENTLY/);
    expect(code).not.toMatch(/IF NOT EXISTS/i);
  });
});

describe("createExpressionIndexSql", () => {
  it("indexes lower(column) under a name that says so", () => {
    const index = createExpressionIndexSql("public", "customers", "lower", "email", []);
    expect(index.name).toBe("customers_lower_email_idx");
    expect(index.sql).toContain(
      'CREATE INDEX "customers_lower_email_idx" ON "public"."customers" (lower("email"));'
    );
    expect(index.undo).toBe('DROP INDEX "public"."customers_lower_email_idx";');
  });

  it("does the same for upper", () => {
    const index = createExpressionIndexSql("app", "Users", "upper", "Code", []);
    expect(index.sql).toContain('ON "app"."Users" (upper("Code"));');
  });
});

describe("createIndexSql on a partitioned table", () => {
  it("says what to do instead of CONCURRENTLY, which PostgreSQL refuses there", () => {
    const index = createIndexSql("public", "events", ["account_id"], [], { partitioned: true });
    expect(index.sql).toContain("This table is partitioned");
    expect(index.sql).toContain("CONCURRENTLY is refused here");
    expect(index.sql).not.toContain("run this by hand as CREATE INDEX CONCURRENTLY");
    // The statement itself is the same as on any table.
    expect(index.sql.split("\n").pop()).toBe(
      'CREATE INDEX "events_account_id_idx" ON "public"."events" ("account_id");'
    );
    expect(index.undo).toBe('DROP INDEX "public"."events_account_id_idx";');
  });

  it("prints the ordinary note when the options are left out", () => {
    const plain = createIndexSql("public", "events", ["account_id"], []);
    const explicit = createIndexSql("public", "events", ["account_id"], [], { partitioned: false });
    expect(plain.sql).toBe(explicit.sql);
    expect(plain.sql).toContain("run this by hand as CREATE INDEX CONCURRENTLY");
  });
});

describe("constraintName", () => {
  it("is table_label, the name PostgreSQL would pick itself", () => {
    expect(constraintName("orders", "pkey", [])).toBe("orders_pkey");
  });

  it("counts up pkey1, pkey2 while the name is taken", () => {
    expect(constraintName("orders", "pkey", ["orders_pkey"])).toBe("orders_pkey1");
    expect(constraintName("orders", "pkey", ["orders_pkey", "orders_pkey1"])).toBe("orders_pkey2");
  });

  it("keeps a long name to 63 bytes and still ends in the label", () => {
    const long = "x".repeat(80);
    const first = constraintName(long, "pkey", []);
    expect(bytes(first)).toBe(MAX_NAME_BYTES);
    expect(first.endsWith("_pkey")).toBe(true);
    // The counter makes the label longer; the table's part gives way, not the label.
    const second = constraintName(long, "pkey", [first]);
    expect(bytes(second)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(second.endsWith("_pkey1")).toBe(true);
  });
});

describe("buildFixScript", () => {
  const date = new Date("2026-09-14T10:32:45Z");
  const where = { connectionName: "Local dev", database: "shop", schema: "public", date };
  const build = (items: FixScriptItem[]) => buildFixScript({ ...where, items });
  /** How many times `part` appears in `text`. */
  const count = (text: string, part: string) => text.split(part).length - 1;

  // Fixes built the way the two tabs build them.
  const customerIndex = createIndexSql("public", "orders", ["customer_id"], []);
  const statusIndex = createIndexSql("public", "orders", ["status"], []);
  const legacyDrop = 'DROP INDEX "public"."orders_legacy_idx";';
  const legacyUndo = 'CREATE INDEX "orders_legacy_idx" ON "public"."orders" ("created_at");';

  const fkIndex: FixScriptItem = {
    title: "Foreign key has no index",
    object: "orders.customer_id",
    fix: customerIndex.sql,
    fixKind: "change",
    undo: customerIndex.undo,
  };
  const statusChange: FixScriptItem = {
    title: "Filter reads the whole table",
    object: "orders.status",
    fix: statusIndex.sql,
    fixKind: "change",
    undo: statusIndex.undo,
  };
  const dropUnused: FixScriptItem = {
    title: "Index has never been used",
    object: "orders_legacy_idx",
    fix: legacyDrop,
    fixKind: "change",
    undo: legacyUndo,
  };
  const analyse: FixScriptItem = {
    title: "Statistics are out of date",
    object: "orders",
    fix: 'ANALYZE "public"."orders";',
    fixKind: "maintenance",
  };
  const vacuum: FixScriptItem = {
    title: "Table has many dead rows",
    object: "orders",
    fix: 'VACUUM (ANALYZE) "public"."orders";',
    fixKind: "maintenance",
  };
  const rewrite: FixScriptItem = {
    title: "Leading wildcard in LIKE",
    object: "customers.email",
    fix: `SELECT "id" FROM "public"."customers" WHERE "email" LIKE 'ann%';`,
    fixKind: "query",
  };
  const decision: FixScriptItem = {
    title: "Table has no primary key",
    object: "audit_log",
    fix: "-- Decide which column identifies a row, then add a primary key on it.",
    fixKind: "decision",
  };

  it("opens every part with the header: who made it, for which database, and when", () => {
    const { script, changes, rollback } = build([fkIndex, analyse]);
    const header = [
      "-- Generated by Schema Studio. Review before running.",
      "-- Connection: Local dev",
      "-- Database:   shop",
      "-- Schema:     public",
      "-- Date:       2026-09-14 10:32 UTC",
    ].join("\n");
    expect(script.startsWith(`${header}\n\n`)).toBe(true);
    expect(changes.startsWith(`${header}\n\n`)).toBe(true);
    expect(rollback?.startsWith(`${header}\n`)).toBe(true);
  });

  it("heads each fix with its title and object, and keeps the fix whole, comments and all", () => {
    const { script, changes } = build([fkIndex]);
    const entry = `-- Foreign key has no index (orders.customer_id)\n${customerIndex.sql}`;
    expect(script).toContain(entry);
    expect(changes).toContain(entry);
  });

  it("keeps the order the screen listed them in, with the changes before the maintenance", () => {
    // Maintenance listed first on screen still comes after the changes: the two
    // are run differently.
    const { script } = build([vacuum, dropUnused, analyse, fkIndex]);
    const at = (part: string) => script.indexOf(part);
    expect(at("-- Index has never been used")).toBeGreaterThan(-1);
    expect(at("-- Index has never been used")).toBeLessThan(at("-- Foreign key has no index"));
    expect(at("-- Foreign key has no index")).toBeLessThan(at("-- Maintenance:"));
    expect(at("-- Maintenance:")).toBeLessThan(at("-- Table has many dead rows"));
    expect(at("-- Table has many dead rows")).toBeLessThan(at("-- Statistics are out of date"));
  });

  it("puts maintenance in a section of its own, and never in the migration", () => {
    const { script, changes } = build([fkIndex, vacuum]);
    expect(count(script, "-- Maintenance: run by hand, outside a transaction (VACUUM refuses to run inside one)\n")).toBe(1);
    expect(script).toContain(vacuum.fix);
    expect(changes).not.toContain("VACUUM");
    expect(changes).not.toContain("-- Maintenance:");
  });

  it("leaves out query rewrites and decisions, which stay on their cards", () => {
    const { script, changes } = build([rewrite, fkIndex, decision]);
    for (const left of [rewrite.fix, rewrite.title, decision.fix, decision.title]) {
      expect(script).not.toContain(left);
    }
    expect(changes).toContain(customerIndex.sql);
    expect(build([rewrite, decision])).toEqual({
      script: "",
      changes: "",
      rollback: null,
      withoutUndo: [],
      description: "",
    });
  });

  it("builds the rollback from every change's undo, last change first", () => {
    const { rollback } = build([fkIndex, dropUnused, statusChange]);
    const text = rollback ?? "";
    expect(text).toContain(`-- Undo: Index has never been used (orders_legacy_idx)\n${legacyUndo}`);
    expect(text.indexOf(statusIndex.undo)).toBeGreaterThan(-1);
    expect(text.indexOf(statusIndex.undo)).toBeLessThan(text.indexOf(legacyUndo));
    expect(text.indexOf(legacyUndo)).toBeLessThan(text.indexOf(customerIndex.undo));
  });

  it("has no rollback when one change has no undo, and names that change", () => {
    const noUndo: FixScriptItem = {
      title: "Index has never been used",
      object: "orders_legacy_idx",
      fix: legacyDrop,
      fixKind: "change",
    };
    const result = build([fkIndex, noUndo]);
    expect(result.rollback).toBeNull();
    expect(result.withoutUndo).toEqual(["Index has never been used (orders_legacy_idx)"]);
    expect(changesWithoutUndo([fkIndex, noUndo], "public")).toEqual(result.withoutUndo);
    expect(changesWithoutUndo([fkIndex, dropUnused], "public")).toEqual([]);
  });

  it("counts an undo of nothing but comments as no undo: it puts nothing back", () => {
    const commentOnly: FixScriptItem = {
      ...dropUnused,
      undo: "-- Recreate it from the definition you saved before dropping it.",
    };
    expect(build([fkIndex, commentOnly]).rollback).toBeNull();
  });

  it("has no migration, rollback or description when nothing is a schema change", () => {
    const result = build([analyse, vacuum]);
    expect(result.changes).toBe("");
    expect(result.rollback).toBeNull();
    expect(result.description).toBe("");
    expect(result.script).toContain(analyse.fix);
  });

  it("runs a statement once when two findings carry the very same one", () => {
    // The Suggestions tab gives a whole-table-read finding the foreign key's
    // own CREATE INDEX when both are about the same column.
    const seqScan: FixScriptItem = { ...fkIndex, title: "Table is read in full often", object: "orders" };
    const { script, changes, rollback } = build([fkIndex, seqScan]);
    expect(count(script, 'CREATE INDEX "orders_customer_id_idx"')).toBe(1);
    expect(count(changes, 'CREATE INDEX "orders_customer_id_idx"')).toBe(1);
    expect(changes).toContain(
      "-- Table is read in full often (orders)\n-- Nothing more to run: the same SQL is already above."
    );
    expect(count(rollback ?? "", customerIndex.undo)).toBe(1);
  });

  it("does not lose the rollback over a change whose statements were all already above", () => {
    const repeatNoUndo: FixScriptItem = {
      title: "Table is read in full often",
      object: "orders",
      fix: customerIndex.sql,
      fixKind: "change",
    };
    const { rollback, withoutUndo } = build([fkIndex, repeatNoUndo]);
    expect(withoutUndo).toEqual([]);
    expect(rollback).toContain(customerIndex.undo);
  });

  it("leaves out only the repeated statements of a fix that shares some", () => {
    const both: FixScriptItem = {
      title: "Two filters read the whole table",
      object: "orders",
      fix: `${customerIndex.sql}\n${statusIndex.sql}`,
      fixKind: "change",
      undo: `${statusIndex.undo}\n${customerIndex.undo}`,
    };
    const { changes, rollback } = build([fkIndex, both]);
    expect(count(changes, 'CREATE INDEX "orders_customer_id_idx"')).toBe(1);
    expect(changes).toContain(
      `-- Two filters read the whole table (orders)\n-- Left out 1 statement that is already above.\n${statusIndex.sql}`
    );
    // Each index is dropped once, the later change's first.
    const text = rollback ?? "";
    expect(count(text, customerIndex.undo)).toBe(1);
    expect(count(text, statusIndex.undo)).toBe(1);
    expect(text.indexOf(statusIndex.undo)).toBeLessThan(text.indexOf(customerIndex.undo));
  });

  it("leaves a migration and a rollback that pass the same checks as a single fix", () => {
    const { changes, rollback } = build([fkIndex, dropUnused, statusChange, vacuum, analyse]);
    expect(rollback).not.toBeNull();
    expect(
      fixProblems({ id: "script", fix: changes, fixKind: "change", undo: rollback ?? undefined })
    ).toEqual([]);
  });

  it("ends a fix that forgot its last semicolon, so it cannot run on into the next one", () => {
    const unfinished: FixScriptItem = {
      title: "Table has no primary key",
      object: "orders",
      fix: 'ALTER TABLE "public"."orders" ADD PRIMARY KEY ("id") -- the id column is unique',
      fixKind: "change",
      undo: 'ALTER TABLE "public"."orders" DROP CONSTRAINT "orders_pkey";',
    };
    const { changes } = build([unfinished, dropUnused]);
    expect(changes).toContain('("id") -- the id column is unique\n;');
    // Two statements, not one long one that fails.
    expect(maskNonCode(changes).split(";").filter((part) => part.trim() !== "")).toHaveLength(2);
  });

  it("keeps every name inside its comment, even one holding a line break", () => {
    // PostgreSQL ends a -- comment at a carriage return as well as a newline.
    const odd: FixScriptItem = { ...fkIndex, title: "Odd\nDROP TABLE x;", object: "a\rDROP TABLE y;" };
    const { script, changes, rollback, description } = buildFixScript({
      ...where,
      connectionName: "dev\r\nDROP TABLE z;",
      items: [odd],
    });
    for (const text of [script, changes, rollback ?? ""]) {
      expect(text).not.toContain("\r");
      expect(maskNonCode(text)).not.toContain("DROP TABLE");
    }
    expect(description).not.toMatch(/[\r\n]/);
  });

  it("describes the migration in one line: the schema, then each change", () => {
    expect(build([fkIndex, analyse, dropUnused]).description).toBe(
      "Performance fixes for public: Foreign key has no index (orders.customer_id); " +
        "Index has never been used (orders_legacy_idx)"
    );
  });

  it("keeps the description within the push route's limit, never cutting a character in half", () => {
    // 30 characters of "Performance fixes for public: ", then emoji two UTF-16
    // units each, so a plain cut would land in the middle of one.
    const long: FixScriptItem = { ...fkIndex, title: "😀".repeat(700) };
    const { description } = build([long]);
    expect(description.length).toBeLessThanOrEqual(MAX_MIGRATION_DESCRIPTION);
    expect(description.endsWith("…")).toBe(true);
    expect(description).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  // An index the Analyse tab suggests on a table in another schema: the query
  // read sales.orders while public was the schema picked above it.
  const salesIndex = createIndexSql("sales", "orders", ["region"], []);
  const salesChange: FixScriptItem = {
    title: "Whole table read to answer this",
    object: "sales.orders",
    fix: salesIndex.sql,
    fixKind: "change",
    undo: salesIndex.undo,
    schemas: ["sales"],
  };

  it("puts a change to another schema in a section of its own, after the changes to this one", () => {
    // Listed first on screen, it still comes after the changes a migration may hold.
    const { script } = build([salesChange, vacuum, fkIndex]);
    const at = (part: string) => script.indexOf(part);
    expect(count(script, "-- Changes to schema public: save them as a migration\n")).toBe(1);
    expect(
      count(script, "-- Changes to other schemas: run by hand, not in a migration for public\n")
    ).toBe(1);
    expect(script).toContain(
      "-- These alter schema sales. A migration is made for one schema,\n" +
        "-- the one named at the top, so Save as a migration leaves these out.\n"
    );
    expect(at("-- Changes to schema public:")).toBeLessThan(at("-- Foreign key has no index"));
    expect(at("-- Foreign key has no index")).toBeLessThan(at("-- Changes to other schemas:"));
    expect(at("-- Changes to other schemas:")).toBeLessThan(at("-- Whole table read to answer this"));
    expect(at("-- Whole table read to answer this")).toBeLessThan(at("-- Maintenance:"));
    expect(script).toContain(`-- Whole table read to answer this (sales.orders)\n${salesIndex.sql}`);
  });

  it("keeps a change to another schema out of the migration, its rollback and its description", () => {
    const { changes, rollback, description } = build([salesChange, fkIndex]);
    expect(changes).toContain(customerIndex.sql);
    expect(changes).not.toContain(salesIndex.sql);
    expect(changes).not.toContain("Whole table read to answer this");
    expect(rollback).toContain(customerIndex.undo);
    expect(rollback).not.toContain(salesIndex.undo);
    expect(description).toBe(
      "Performance fixes for public: Foreign key has no index (orders.customer_id)"
    );
  });

  it("keeps the rollback when a change to another schema has no undo", () => {
    // That change is not in the migration, so the rollback has nothing of it to take out.
    const salesNoUndo: FixScriptItem = {
      title: salesChange.title,
      object: salesChange.object,
      fix: salesIndex.sql,
      fixKind: "change",
      schemas: ["sales"],
    };
    const result = build([fkIndex, salesNoUndo]);
    expect(result.withoutUndo).toEqual([]);
    expect(result.rollback).toContain(customerIndex.undo);
    expect(changesWithoutUndo([fkIndex, salesNoUndo], "public")).toEqual([]);
  });

  it("has no migration when every change is to another schema, but still a script to copy", () => {
    const result = build([salesChange]);
    expect(result).toMatchObject({ changes: "", rollback: null, withoutUndo: [], description: "" });
    expect(result.script).toContain(salesIndex.sql);
    expect(result.script).not.toContain("save them as a migration");
  });

  it("keeps a change that alters this schema and another out of the migration, whole", () => {
    // A query reading public.customers and sales.customers can get one finding
    // with an index on each. Its statements are one fix and are not split.
    const both: FixScriptItem = {
      ...salesChange,
      fix: `${customerIndex.sql}\n${salesIndex.sql}`,
      undo: `${customerIndex.undo}\n${salesIndex.undo}`,
      schemas: ["public", "sales"],
    };
    const { script, changes } = build([both]);
    expect(changes).toBe("");
    expect(script).toContain("-- These alter schema sales.");
    expect(script).toContain(customerIndex.sql);
  });

  it("counts a change that names only this schema as one for the migration", () => {
    const named: FixScriptItem = { ...fkIndex, schemas: ["public"] };
    const { script, changes } = build([named]);
    expect(changes).toContain(customerIndex.sql);
    expect(script).toContain("-- Schema changes: save them as a migration\n");
    expect(script).not.toContain("-- Changes to other schemas");
  });

  it("names every other schema the changes alter", () => {
    const auditIndex = createIndexSql("audit", "log", ["at"], []);
    const auditChange: FixScriptItem = {
      title: "Whole table read to answer this",
      object: "audit.log",
      fix: auditIndex.sql,
      fixKind: "change",
      undo: auditIndex.undo,
      schemas: ["audit"],
    };
    expect(build([salesChange, auditChange]).script).toContain(
      "-- These alter schemas sales and audit."
    );
  });
});

describe("otherSchemas", () => {
  const change = (schemas?: string[]): FixScriptItem => ({
    title: "Whole table read to answer this",
    object: "orders",
    fix: 'CREATE INDEX "orders_x_idx" ON "public"."orders" ("x");',
    fixKind: "change",
    ...(schemas === undefined ? {} : { schemas }),
  });

  it("is empty when the items alter only the schema given, or do not say", () => {
    expect(otherSchemas([], "public")).toEqual([]);
    expect(otherSchemas([change()], "public")).toEqual([]);
    expect(otherSchemas([change(["public"])], "public")).toEqual([]);
  });

  it("names each other schema once, in the order the items name them", () => {
    expect(
      otherSchemas([change(["sales", "public", "audit"]), change(["audit", "hr", "sales"])], "public")
    ).toEqual(["sales", "audit", "hr"]);
  });
});

describe("schemasPhrase", () => {
  it("names one schema, two, or more, the way a sentence would", () => {
    expect(schemasPhrase(["sales"])).toBe("schema sales");
    expect(schemasPhrase(["sales", "audit"])).toBe("schemas sales and audit");
    expect(schemasPhrase(["sales", "audit", "hr"])).toBe("schemas sales, audit and hr");
  });

  it("keeps a name holding a line break on one line", () => {
    expect(schemasPhrase(["odd\r\nname"])).toBe("schema odd name");
  });
});

describe("otherSchemaHeading", () => {
  const item = (fixKind: FixScriptItem["fixKind"], schemas?: string[]): FixScriptItem => ({
    title: "Whole table read to answer this",
    object: "orders",
    fix: 'CREATE INDEX "orders_x_idx" ON "sales"."orders" ("x");',
    fixKind,
    ...(schemas === undefined ? {} : { schemas }),
  });

  it("names every schema a change to another schema alters", () => {
    expect(otherSchemaHeading(item("change", ["sales"]), "public")).toBe(
      "Change to schema sales: copy it and run it by hand"
    );
    // The picked schema is named too when the change also alters it.
    expect(otherSchemaHeading(item("change", ["public", "sales"]), "public")).toBe(
      "Change to schemas public and sales: copy it and run it by hand"
    );
  });

  it("leaves the usual heading on a change to the picked schema, and on every other kind", () => {
    expect(otherSchemaHeading(item("change", ["public"]), "public")).toBeUndefined();
    expect(otherSchemaHeading(item("change"), "public")).toBeUndefined();
    expect(otherSchemaHeading(item("maintenance", ["sales"]), "public")).toBeUndefined();
  });
});

describe("fixScriptFileName", () => {
  const date = new Date("2026-09-14T23:59:00Z");

  it("names the file after the database, the schema and the day", () => {
    expect(fixScriptFileName("shop", "public", date)).toBe(
      "performance-fixes-shop-public-2026-09-14.sql"
    );
  });

  it("keeps to characters every file system accepts", () => {
    expect(fixScriptFileName("my db/../x", "日本", date)).toBe(
      "performance-fixes-my_db_x-schema-2026-09-14.sql"
    );
  });
});
