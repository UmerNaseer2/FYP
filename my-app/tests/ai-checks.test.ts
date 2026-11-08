// The code checks that stand between a model's answer and the screen, and the
// schema text a prompt carries.

import {
  bareName,
  checkCitedNames,
  checkGeneratedSql,
  isKnownName,
  knownNames,
  lockLevel,
  tableRefsInSql,
  unknownTablesInSql,
} from "@/lib/ai/checks";
import { mentionedObjects, schemaSlice, schemaText, tableText } from "@/lib/ai/context";
import { estimateTokens } from "@/lib/ai/provider";
import { readAiSettingsChange } from "@/lib/ai/views";
import type {
  ColumnSnapshot,
  ConstraintSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  SchemaSnapshot,
  TableSnapshot,
} from "@/lib/postgres";

function column(name: string, typeDisplay = "integer", extra: Partial<ColumnSnapshot> = {}): ColumnSnapshot {
  return {
    name,
    ordinalPosition: 1,
    typeDisplay,
    nullable: true,
    columnDefault: null,
    isPrimaryKey: false,
    uniqueConstraintNames: [],
    foreignKeyConstraintNames: [],
    ...extra,
  };
}

function pk(name: string, columns: string[]): ConstraintSnapshot {
  const definition = `PRIMARY KEY (${columns.join(", ")})`;
  return { name, kind: "PRIMARY KEY", columns, definition, normalizedDefinition: definition };
}

function fk(name: string, columns: string[], referencedTable: string): ForeignKeySnapshot {
  const definition = `FOREIGN KEY (${columns.join(", ")}) REFERENCES ${referencedTable}(id)`;
  return {
    name,
    kind: "FOREIGN KEY",
    columns,
    definition,
    normalizedDefinition: definition,
    referencedSchema: "public",
    referencedTable,
    referencedColumns: ["id"],
    onUpdate: "NO ACTION",
    onDelete: "CASCADE",
  } as ForeignKeySnapshot;
}

function index(name: string, columns: string[], extra: Partial<IndexSnapshot> = {}): IndexSnapshot {
  return {
    name,
    definition: `CREATE INDEX ${name} ON t (${columns.join(", ")})`,
    normalizedDefinition: `CREATE INDEX ${name} ON t (${columns.join(", ")})`,
    columns,
    isUnique: false,
    method: "btree",
    predicate: null,
    ...extra,
  };
}

function table(name: string, extra: Partial<TableSnapshot> = {}): TableSnapshot {
  return {
    name,
    columns: [column("id", "integer", { nullable: false, isPrimaryKey: true })],
    primaryKey: pk(`${name}_pkey`, ["id"]),
    uniqueConstraints: [],
    foreignKeys: [],
    checkConstraints: [],
    excludeConstraints: [],
    ...extra,
  } as TableSnapshot;
}

const authors = table("authors", {
  columns: [
    column("id", "integer", { nullable: false, isPrimaryKey: true }),
    column("name", "text", { nullable: false, ordinalPosition: 2 }),
  ],
});
const books = table("books", {
  columns: [
    column("id", "integer", { nullable: false, isPrimaryKey: true }),
    column("title", "text", { nullable: false, ordinalPosition: 2 }),
    column("author_id", "integer", { ordinalPosition: 3 }),
    column("price", "numeric(10,2)", { ordinalPosition: 4, columnDefault: "0" }),
  ],
  foreignKeys: [fk("books_author_id_fkey", ["author_id"], "authors")],
  indexes: [index("books_title_idx", ["title"]), index("books_cheap_idx", ["price"], { predicate: "(price < 5)" })],
});
const orderItems = table("order_items", {
  columns: [column("id"), column("book_id", "integer", { ordinalPosition: 2 })],
  foreignKeys: [fk("order_items_book_id_fkey", ["book_id"], "books")],
});
// Big enough that leaving it out of a slice saves real room.
const stores = table("stores", {
  columns: [
    column("id"),
    column("city", "text", { ordinalPosition: 2 }),
    ...["street", "postcode", "phone", "manager_email", "opening_hours", "closing_hours", "notes"].map((name, i) =>
      column(name, "character varying(200)", { ordinalPosition: i + 3 })
    ),
  ],
});

function shop(tables: TableSnapshot[] = [authors, books, orderItems, stores]): SchemaSnapshot {
  return { database: "shop", schema: "public", tables } as SchemaSnapshot;
}

describe("knownNames and the cited name check", () => {
  const known = knownNames(shop());

  test("tables, columns, table.column pairs, keys and indexes are known", () => {
    for (const name of ["books", "title", "books.title", "books_pkey", "books_author_id_fkey", "books_title_idx", "schema:public"]) {
      expect(known.has(name)).toBe(true);
    }
  });

  test("bareName drops quotes and the schema, keeps table.column", () => {
    expect(bareName('"public"."Books"')).toBe("public.books");
    expect(bareName("public.books.title")).toBe("books.title");
    expect(bareName(" Books ")).toBe("books");
  });

  test.each([
    ["books", true],
    ["BOOKS.Title", true],
    ["public.books", true],
    ['"public"."books"."title"', true],
    ["invoices", false],
    ["orders.title", false],
    ["books.isbn", false],
    ["sales.books", false],
    // A column is not a table, so public.title is not a name.
    ["public.title", false],
    // A schema that was never shown, in front of a real table.column.
    ["made_up.books.title", false],
  ])("%s known: %s", (name, expected) => {
    expect(isKnownName(name, known)).toBe(expected);
  });

  test("a name with a schema in front is known only in that schema", () => {
    const refunds = table("refunds", { columns: [column("id"), column("amount", "numeric", { ordinalPosition: 2 })] });
    const both = knownNames(
      { database: "shop", schema: "cmp_prod", tables: [books] } as SchemaSnapshot,
      { database: "shop", schema: "cmp_dev", tables: [books, refunds] } as SchemaSnapshot
    );
    expect(isKnownName("cmp_dev.refunds", both)).toBe(true);
    expect(isKnownName("cmp_dev.refunds.amount", both)).toBe(true);
    expect(isKnownName("cmp_prod.books.title", both)).toBe(true);
    expect(isKnownName("refunds.amount", both)).toBe(true);
    expect(isKnownName("cmp_prod.refunds", both)).toBe(false);
    expect(isKnownName("cmp_prod.refunds.amount", both)).toBe(false);
    expect(isKnownName("cmp_prod.amount", both)).toBe(false);
  });

  test("checkCitedNames keeps the items that cite only real names", () => {
    const items = [
      { text: "a", names: ["books.title"] },
      { text: "b", names: ["books", "invoices"] },
      { text: "c", names: [] },
    ];
    const { kept, dropped } = checkCitedNames(items, (i) => i.names, known);
    expect(kept.map((i) => i.text)).toEqual(["a", "c"]);
    expect(dropped).toEqual([{ item: items[1], unknown: ["invoices"] }]);
  });
});

describe("lockLevel", () => {
  test("the engine's level always wins", () => {
    expect(lockLevel("breaking", "additive")).toEqual({ level: "breaking", modelDisagreed: true });
    expect(lockLevel("additive", "ADDITIVE")).toEqual({ level: "additive", modelDisagreed: false });
    expect(lockLevel("patch", undefined)).toEqual({ level: "patch", modelDisagreed: false });
  });
});

describe("checkGeneratedSql", () => {
  test("a plain additive change passes, graded by the engine", () => {
    const result = checkGeneratedSql("ALTER TABLE books ADD COLUMN isbn text;");
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.statements).toBe(1);
    expect(result.grade).not.toBeNull();
  });

  test("comments only is not SQL", () => {
    expect(checkGeneratedSql("-- nothing here")).toMatchObject({ ok: false, statements: 0 });
  });

  test("transaction control is refused", () => {
    const result = checkGeneratedSql("BEGIN;\nALTER TABLE books ADD COLUMN isbn text;\nCOMMIT;");
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/BEGIN, COMMIT or ROLLBACK/);
  });

  test("data loss is refused unless the request asked for it", () => {
    const sql = "ALTER TABLE books DROP COLUMN price;";
    const refused = checkGeneratedSql(sql);
    expect(refused.ok).toBe(false);
    expect(refused.problems[0]).toMatch(/^It deletes data/);
    expect(checkGeneratedSql(sql, { allowDataLoss: true }).ok).toBe(true);
  });

  test.each([
    ["DO ''", "DO 'BEGIN DELETE FROM books; END';"],
    ["DO E''", "DO E'BEGIN TRUNCATE books; END';"],
    ["a function body written as ''", "CREATE FUNCTION wipe() RETURNS void LANGUAGE sql AS 'DELETE FROM books';"],
    ["DO '' with a quote inside", "DO 'BEGIN DELETE FROM books WHERE title = ''x''; END';"],
  ])("data loss in a body written as %s is refused", (_label, sql) => {
    const result = checkGeneratedSql(sql);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/It deletes data \((?:DELETE|TRUNCATE)/);
    expect(result.risk?.dataLoss.length).toBeGreaterThan(0);
  });

  test("a body that deletes nothing adds no data loss", () => {
    expect(checkGeneratedSql("DO 'BEGIN RAISE NOTICE ''hi''; END';").ok).toBe(true);
  });
});

describe("unknownTablesInSql", () => {
  const snapshot = shop();

  test("tables that exist, or are created in the same SQL, are fine", () => {
    expect(
      unknownTablesInSql(
        "CREATE TABLE reviews (id int, book_id int REFERENCES books(id));\nINSERT INTO reviews SELECT 1, id FROM public.books;",
        snapshot
      )
    ).toEqual([]);
  });

  test("a made-up table is named once", () => {
    expect(
      unknownTablesInSql("UPDATE invoices SET x = 1; SELECT * FROM invoices JOIN authors ON true;", snapshot)
    ).toEqual(["invoices"]);
  });

  test("names in comments do not count", () => {
    expect(unknownTablesInSql("-- FROM ghosts\nSELECT 1 FROM books;", snapshot)).toEqual([]);
  });

  test("keywords after FROM, UPDATE and REFERENCES are not tables", () => {
    const sql = [
      "ALTER TABLE books ADD COLUMN author_id int REFERENCES authors(id) ON UPDATE CASCADE ON DELETE SET NULL;",
      "INSERT INTO books (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id;",
      "SELECT * FROM books FOR UPDATE OF books NOWAIT;",
      "SELECT * FROM ONLY books;",
    ].join("\n");
    expect(unknownTablesInSql(sql, snapshot)).toEqual([]);
  });

  test("a WITH part, a string and a function body's INTO are not tables", () => {
    expect(unknownTablesInSql("WITH recent AS (SELECT * FROM books) SELECT * FROM recent;", snapshot)).toEqual([]);
    expect(unknownTablesInSql("SELECT 'FROM ghosts' FROM books;", snapshot)).toEqual([]);
    expect(
      unknownTablesInSql("CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ DECLARE n int; BEGIN SELECT 1 INTO n; RETURN n; END $$;", snapshot)
    ).toEqual([]);
  });

  test("a table a trigger function writes to must exist too", () => {
    const sql = [
      "CREATE FUNCTION log_price() RETURNS trigger LANGUAGE plpgsql AS $$",
      "BEGIN INSERT INTO product_audit (id) VALUES (NEW.id); RETURN NEW; END $$;",
      "CREATE TRIGGER log_price AFTER UPDATE ON books FOR EACH ROW EXECUTE FUNCTION log_price();",
    ].join("\n");
    expect(unknownTablesInSql(sql, snapshot)).toEqual(["product_audit"]);
    expect(
      unknownTablesInSql("CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS 'BEGIN UPDATE ghosts SET id = 1; END';", snapshot)
    ).toEqual(["ghosts"]);
  });

  test("a body's variables, cursors and catalog reads are not tables", () => {
    const sql = [
      "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$",
      "DECLARE n int; r record; c refcursor;",
      "BEGIN",
      "  SELECT count(*) INTO n FROM books;",
      "  OPEN c FOR SELECT * FROM books;",
      "  FETCH c INTO r;",
      "  FETCH NEXT FROM c INTO r;",
      "  MOVE FORWARD 1 FROM c;",
      "  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'x') THEN",
      "    INSERT INTO books (id) SELECT 1 FROM information_schema.columns LIMIT 1;",
      "  END IF;",
      "  n := EXTRACT(year FROM now());",
      "  RETURN n;",
      "END $$;",
    ].join("\n");
    expect(unknownTablesInSql(sql, snapshot)).toEqual([]);
  });

  test("a table in another schema is checked even when a column has its name", () => {
    // stores has a notes column, but there is no notes table.
    expect(unknownTablesInSql("DELETE FROM archive.notes;", snapshot)).toEqual(["notes"]);
  });

  test("the rollback may drop what the script created", () => {
    expect(unknownTablesInSql("DROP TABLE IF EXISTS reviews;", snapshot, new Set(["reviews"]))).toEqual([]);
    expect(unknownTablesInSql("DROP TABLE IF EXISTS reviews;", snapshot)).toEqual(["reviews"]);
  });
});

describe("tableRefsInSql", () => {
  test("reads the schema, the name and whether it is created", () => {
    expect(tableRefsInSql('CREATE TABLE IF NOT EXISTS shop."Reviews" (id int); ALTER TABLE books RENAME TO volumes;')).toEqual([
      { schema: "shop", name: "reviews", creates: true },
      { schema: null, name: "books", creates: false },
      { schema: null, name: "volumes", creates: true },
    ]);
  });
});

describe("schema text", () => {
  test("a table reads as short DDL with keys, defaults and indexes", () => {
    expect(tableText(books)).toBe(
      [
        "TABLE books",
        "  id integer NOT NULL",
        "  title text NOT NULL",
        "  author_id integer",
        "  price numeric(10,2) DEFAULT 0",
        "  PRIMARY KEY books_pkey (id)",
        "  FOREIGN KEY books_author_id_fkey (author_id) REFERENCES authors (id) ON DELETE CASCADE",
        "  INDEX books_title_idx USING btree (title)",
        "  INDEX books_cheap_idx USING btree (price) WHERE (price < 5)",
      ].join("\n")
    );
  });

  test("the whole schema fits when there is room", () => {
    const slice = schemaSlice(shop(), { maxTokens: 10_000 });
    expect(slice.whole).toBe(true);
    expect(slice.text).toBe(schemaText(shop()));
    expect(slice.omitted).toEqual([]);
  });

  test("a tight budget keeps the focus and its neighbours, and names the rest", () => {
    const whole = estimateTokens(schemaText(shop()));
    // Room for the slice's longer header and its closing note, not for stores.
    const budget = whole - estimateTokens(tableText(stores)) + 60;
    const slice = schemaSlice(shop(), { focus: ["books"], maxTokens: budget });
    expect(slice.whole).toBe(false);
    expect(slice.included).toEqual(["books", "authors", "order_items"]);
    expect(slice.omitted).toEqual(["stores"]);
    expect(slice.text).toContain("ALSO IN THIS SCHEMA, NOT SHOWN: stores");
    expect(slice.tokens).toBeLessThanOrEqual(budget);
  });

  test("the text stays inside the budget whenever the focus fits", () => {
    const whole = estimateTokens(schemaText(shop()));
    for (let budget = whole; budget >= 160; budget -= 3) {
      const slice = schemaSlice(shop(), { focus: ["books"], maxTokens: budget });
      expect(slice.included).toContain("books");
      expect(slice.tokens).toBeLessThanOrEqual(budget);
    }
  });

  test("the focus table goes in even when it alone is over the budget", () => {
    const slice = schemaSlice(shop(), { focus: ["books"], maxTokens: 40 });
    expect(slice.included).toEqual(["books"]);
    expect(slice.omitted).toEqual(["authors", "order_items", "stores"]);
  });

  test("schema text never carries where the database lives", () => {
    const text = schemaText({ ...shop(), database: "secret_db_name" } as SchemaSnapshot);
    expect(text).not.toContain("secret_db_name");
  });

  test.each([
    ["add a column to the book table", ["books"]],
    ["count Books by author", ["authors", "books"]],
    ["which order items have no book", ["books", "order_items"]],
    ["list every store in each city", ["stores"]],
    ["nothing relevant", []],
  ])("mentionedObjects(%s)", (sentence, expected) => {
    expect(mentionedObjects(shop(), sentence).sort()).toEqual(expected);
  });
});

describe("readAiSettingsChange", () => {
  test.each([
    [{ enabled: true }, { enabled: true }],
    [{ features: { "schema-chat": false } }, { features: { "schema-chat": false } }],
    [{ enabled: false, features: {} }, { enabled: false, features: {} }],
  ])("accepts %o", (body, change) => {
    expect(readAiSettingsChange(body)).toEqual(change);
  });

  test.each([
    [null, "Expected a JSON object."],
    [[], "Expected a JSON object."],
    [{}, "Nothing to change."],
    [{ enabled: "yes" }, "enabled must be true or false."],
    [{ features: [] }, "features must be an object of feature names to true or false."],
    [{ features: { "make-coffee": true } }, "There is no AI feature called make-coffee."],
    [{ features: { "schema-chat": 1 } }, "schema-chat must be true or false."],
  ])("refuses %o", (body, message) => {
    expect(readAiSettingsChange(body)).toBe(message);
  });
});
