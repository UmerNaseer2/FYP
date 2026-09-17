// Reading tables and columns from the system catalogs.
//
// The snapshot used to list tables and columns through information_schema,
// which only shows a table or a column the login has some privilege on. A
// saved login without rights on a table saw it vanish: drift reported the
// table as removed, or said "in sync" while it had changed, and compare and
// generate never saw it. The queries now read pg_class and pg_attribute, which
// list everything.
//
// A fake client cannot show what a real server hides, so these tests pin the
// two queries to the catalogs and check that the rows they return still land
// in the snapshot as before: nullability, collations, and the schema's own
// name taken out of types and defaults.
import { createFakeClient, type FakeClient, type FakeStep } from "./helpers/fake-pg";
import { fetchSchemaSnapshot } from "@/lib/postgres";

// fetchSchemaSnapshot borrows a client from a pg Pool. The stand-in pool hands
// out whichever fake client the running test put here.
const mockPool: { client: FakeClient | null } = { client: null };

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    connect: () => Promise.resolve(mockPool.client),
  })),
}));

const cfg = { host: "db.example.com", port: 5432, database: "shop", user: "reader" };

async function snapshotWith(steps: FakeStep[]) {
  const client = createFakeClient(steps);
  mockPool.client = client;
  const result = await fetchSchemaSnapshot(cfg, "app");
  return { client, result };
}

/** The query that lists the tables, and the one that lists their columns. */
const TABLE_QUERY = /^\s*SELECT c\.relname AS table_name\s+FROM pg_class c\b/;
const COLUMN_QUERY = /\bAS column_name\b/;

describe("fetchSchemaSnapshot — tables and columns", () => {
  it("reads both from the catalogs, so a table the login has no rights on is still listed", async () => {
    const { client, result } = await snapshotWith([]);
    expect(result.ok).toBe(true);

    const texts = client.queries.map((query) => query.text.replace(/\s+/g, " "));
    // No query in the snapshot goes through information_schema any more.
    expect(texts.filter((text) => /information_schema/.test(text))).toEqual([]);

    const tableQuery = texts.find((text) => TABLE_QUERY.test(text));
    expect(tableQuery).toMatch(/JOIN pg_namespace n ON n\.oid = c\.relnamespace/);

    const columnQuery = texts.find((text) => COLUMN_QUERY.test(text));
    expect(columnQuery).toMatch(/FROM pg_class cls/);
    expect(columnQuery).toMatch(/JOIN pg_attribute a ON a\.attrelid = cls\.oid/);
    // information_schema.columns' own rules, written out: a NOT NULL domain
    // makes the column NOT NULL, and the default collation reads as none.
    expect(columnQuery).toContain(
      "NOT (a.attnotnull OR (t.typtype = 'd' AND t.typnotnull)) AS is_nullable"
    );
    expect(columnQuery).toContain("(nco.nspname, co.collname) <> ('pg_catalog', 'default')");

    // Both still skip the app's own bookkeeping tables.
    const listing = client.queries.filter((q) => TABLE_QUERY.test(q.text) || COLUMN_QUERY.test(q.text));
    expect(listing).toHaveLength(2);
    for (const query of listing) {
      expect(query.values).toEqual(["app", ["script_patch", "script_patch_reverted"]]);
    }
  });

  it("builds the table and its columns from the catalog rows", async () => {
    const { result } = await snapshotWith([
      {
        match: COLUMN_QUERY,
        rows: [
          {
            table_name: "orders",
            column_name: "id",
            ordinal_position: 1,
            type_display: "integer",
            is_nullable: false,
            column_default: "nextval('app.orders_id_seq'::regclass)",
            identity: "",
            generated: "",
            collation_schema: null,
            collation_name: null,
          },
          {
            table_name: "orders",
            column_name: "code",
            ordinal_position: 2,
            // A domain declared NOT NULL: the query reports the column as not nullable.
            type_display: "app.short_code",
            is_nullable: false,
            column_default: null,
            identity: "",
            generated: "",
            collation_schema: null,
            collation_name: null,
          },
          {
            table_name: "orders",
            column_name: "note",
            // A dropped column leaves a gap in attnum, and the gap is kept.
            ordinal_position: 4,
            type_display: "text",
            is_nullable: true,
            column_default: null,
            identity: "",
            generated: "",
            collation_schema: "pg_catalog",
            collation_name: "C",
          },
          {
            table_name: "orders",
            column_name: "label",
            ordinal_position: 5,
            type_display: "text",
            is_nullable: true,
            column_default: null,
            identity: "",
            generated: "",
            collation_schema: "app",
            collation_name: "case_insensitive",
          },
          {
            // A column of a table the table query did not list is skipped.
            table_name: "not_a_table",
            column_name: "x",
            ordinal_position: 1,
            type_display: "integer",
            is_nullable: true,
            column_default: null,
            identity: "",
            generated: "",
            collation_schema: null,
            collation_name: null,
          },
        ],
      },
      { match: TABLE_QUERY, rows: [{ table_name: "orders" }] },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tables.map((table) => table.name)).toEqual(["orders"]);
    expect(
      result.data.tables[0].columns.map((column) => ({
        name: column.name,
        ordinalPosition: column.ordinalPosition,
        typeDisplay: column.typeDisplay,
        nullable: column.nullable,
        columnDefault: column.columnDefault,
        collation: column.collation,
      }))
    ).toEqual([
      {
        name: "id",
        ordinalPosition: 1,
        typeDisplay: "integer",
        nullable: false,
        columnDefault: "nextval('orders_id_seq'::regclass)",
        collation: null,
      },
      {
        name: "code",
        ordinalPosition: 2,
        typeDisplay: "short_code",
        nullable: false,
        columnDefault: null,
        collation: null,
      },
      {
        name: "note",
        ordinalPosition: 4,
        typeDisplay: "text",
        nullable: true,
        columnDefault: null,
        collation: '"C"',
      },
      {
        name: "label",
        ordinalPosition: 5,
        typeDisplay: "text",
        nullable: true,
        columnDefault: null,
        collation: '"case_insensitive"',
      },
    ]);
  });
});

// Which indexes the snapshot records.
//
// The query leaves out an index a constraint owns, because that index is
// already reported as the constraint. It used to leave out an index ANY
// constraint pointed at, which is a different and much larger set: a FOREIGN
// KEY's conindid names the index on the OTHER table that the key reads to
// check itself, and PostgreSQL is content for that to be a plain CREATE UNIQUE
// INDEX. Such an index disappeared from the snapshot entirely — no difference
// to report, and no CREATE INDEX in a generated script, which then failed on
// the foreign key with "there is no unique constraint matching given keys".
//
// A fake client cannot run the predicate, so the first test reads it, and the
// second checks that an index the query does return still reaches the table.
const INDEX_QUERY = /\bAS index_name\b/;

describe("fetchSchemaSnapshot — indexes", () => {
  it("only skips an index a primary key, unique or exclusion constraint owns", async () => {
    const { client } = await snapshotWith([]);
    const texts = client.queries.map((query) => query.text.replace(/\s+/g, " "));
    const indexQuery = texts.find((text) => INDEX_QUERY.test(text));

    expect(indexQuery).toBeDefined();
    // Those three are the constraint kinds that own their index. Confirmed on
    // PostgreSQL 18: with the filter absent, a schema whose only plain index
    // was a unique index referenced by a foreign key returned no indexes at
    // all; with it, that index comes back and the exclusion constraint's own
    // index still does not.
    expect(indexQuery).toContain("con.contype IN ('p', 'u', 'x')");
    expect(indexQuery).toContain("con.conindid = x.indexrelid");
    // The partition clone rule is untouched — see the comment beside the query.
    expect(indexQuery).toContain("FROM pg_inherits ii WHERE ii.inhrelid = x.indexrelid");
  });

  it("records an index the query returns against its table", async () => {
    const { result } = await snapshotWith([
      { match: TABLE_QUERY, rows: [{ table_name: "orders" }] },
      {
        match: INDEX_QUERY,
        rows: [
          {
            table_name: "orders",
            index_name: "orders_code_uidx",
            // Written as a real server writes it, schema-qualified.
            definition: "CREATE UNIQUE INDEX orders_code_uidx ON app.orders USING btree (code)",
            is_unique: true,
            method: "btree",
            columns: ["code"],
            predicate: null,
          },
        ],
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const orders = result.data.tables.find((table) => table.name === "orders");
    expect(orders?.indexes).toEqual([
      {
        name: "orders_code_uidx",
        // The own-schema qualifier is stripped, so the same index in another
        // schema compares equal.
        definition: "CREATE UNIQUE INDEX orders_code_uidx ON orders USING btree (code)",
        normalizedDefinition: expect.any(String),
        columns: ["code"],
        isUnique: true,
        method: "btree",
        predicate: null,
      },
    ]);
  });

  // indkey holds more than the columns a lookup can use, and the query used to
  // hand all of it over as `columns`. A fake client cannot run SQL, so the
  // clauses that cut it down are pinned here; what they mean is spelled out
  // beside the query in lib/postgres.ts, and the rules that read `columns`
  // (the foreign-key rule in lib/perf-advice.ts) are tested against it there.
  it("asks the server for the leading key columns only, not the whole of indkey", async () => {
    const { client } = await snapshotWith([]);
    const texts = client.queries.map((query) => query.text.replace(/\s+/g, " "));
    const indexQuery = texts.find((text) => INDEX_QUERY.test(text));

    // INCLUDE columns sit past indnkeyatts. Kept, an index on
    // (customer_id) INCLUDE (total) reads as one that can serve a lookup on
    // (customer_id, total) — it cannot, so a foreign key on those two columns
    // looked indexed when nothing indexed it.
    expect(indexQuery).toContain("WHERE k.ord <= x.indnkeyatts");
    // An expression is attnum 0 and matches no pg_attribute row. Everything
    // from there on is dropped, because a column behind an expression is not a
    // leading column of anything.
    expect(indexQuery).toContain("WHERE e.attnum = 0 AND e.ord <= k.ord");
    // An inner join, now that nothing that could miss is asked for: the LEFT
    // JOIN it replaces returned a NULL for an expression, which became the
    // literal text "null" in the snapshot's column list.
    expect(indexQuery).not.toMatch(/LEFT JOIN pg_attribute a ON a\.attrelid = c\.oid/);
    expect(indexQuery).toContain("JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum");
  });

  it("stops a column list at anything that is not a column name", async () => {
    // The second belt. The query above already stops at an expression, so
    // these nulls are what the OLD one returned — and what the snapshot then
    // wrote down was the four letters "null" in their place, because
    // String(null) is a perfectly good string.
    //
    // Truncating, not dropping: an index on (a, lower(b), c) whose middle
    // entry was simply removed would read as an index on (a, c), and the rules
    // would then match a lookup on (a, c) against an index that cannot serve
    // one.
    const { result } = await snapshotWith([
      { match: TABLE_QUERY, rows: [{ table_name: "orders" }] },
      {
        match: INDEX_QUERY,
        rows: [
          {
            table_name: "orders",
            index_name: "orders_lower_email_idx",
            definition:
              "CREATE INDEX orders_lower_email_idx ON app.orders USING btree (lower(email))",
            is_unique: false,
            method: "btree",
            columns: [null],
            predicate: null,
          },
          {
            table_name: "orders",
            index_name: "orders_a_lower_b_c_idx",
            definition:
              "CREATE INDEX orders_a_lower_b_c_idx ON app.orders USING btree (a, lower(b), c)",
            is_unique: false,
            method: "btree",
            columns: ["a", null, "c"],
            predicate: null,
          },
        ],
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const orders = result.data.tables.find((table) => table.name === "orders");
    // Index order is by name, so a_lower_b_c comes before lower_email.
    expect(orders?.indexes?.map((index) => index.columns)).toEqual([["a"], []]);
  });
});
