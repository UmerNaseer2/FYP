import {
  containsTransactionControl,
  doBlockBodies,
  extractEnumAddValues,
  findMightFailStatements,
  findRowDestroyingStatements,
} from "@/lib/sql-guard";

/**
 * The transaction guard is the one thing standing between a migration and a
 * half-applied database: the apply route wraps every run in BEGIN … COMMIT, so
 * a stray COMMIT inside a script would end that transaction early and leave DDL
 * behind with no ledger row. These tests care about both directions — it must
 * catch real transaction control, and it must not cry wolf over the word
 * "commit" sitting harmlessly inside a comment or a string.
 */
describe("containsTransactionControl", () => {
  it("catches the plain verbs", () => {
    expect(containsTransactionControl("CREATE TABLE t (id int);\nCOMMIT;")).toBe(true);
    expect(containsTransactionControl("rollback;")).toBe(true);
    // ABORT is a ROLLBACK synonym, so it ends the transaction just as hard.
    expect(containsTransactionControl("ABORT;")).toBe(true);
    expect(containsTransactionControl("PREPARE TRANSACTION 'x';")).toBe(true);
  });

  it("treats END as COMMIT only at a statement boundary", () => {
    expect(containsTransactionControl("END;")).toBe(true);
    expect(containsTransactionControl("CREATE TABLE t (id int); END TRANSACTION;")).toBe(true);
    expect(containsTransactionControl("END WORK")).toBe(true);
    // END also closes a CASE expression, which is ordinary SQL and must pass.
    expect(
      containsTransactionControl(
        "CREATE VIEW v AS SELECT CASE WHEN id > 0 THEN 'a' ELSE 'b' END FROM t;"
      )
    ).toBe(false);
  });

  it("lets an ordinary migration through", () => {
    expect(
      containsTransactionControl(
        "ALTER TABLE orders ADD COLUMN total numeric;\nCREATE INDEX ON orders (total);"
      )
    ).toBe(false);
  });

  it("ignores the words inside comments", () => {
    expect(containsTransactionControl("-- COMMIT the change\nCREATE TABLE t (id int);")).toBe(
      false
    );
    expect(containsTransactionControl("/* ROLLBACK plan: drop it */ CREATE TABLE t (id int);")).toBe(
      false
    );
  });

  it("ignores the words inside a PL/pgSQL body", () => {
    // BEGIN … END inside $$ … $$ is block structure, not transaction control.
    const sql = [
      "CREATE FUNCTION bump() RETURNS trigger AS $$",
      "BEGIN",
      "  NEW.updated_at := now();",
      "  RETURN NEW;",
      "END",
      "$$ LANGUAGE plpgsql;",
    ].join("\n");
    expect(containsTransactionControl(sql)).toBe(false);
  });

  it("ignores the words inside string literals", () => {
    expect(containsTransactionControl("INSERT INTO log (action) VALUES ('COMMIT');")).toBe(false);
    // '' is an escaped quote, so the literal does not end there.
    expect(containsTransactionControl("INSERT INTO log VALUES ('it''s a COMMIT');")).toBe(false);
  });

  /**
   * The bug this suite exists to pin down.
   *
   * The guard used to strip comments, then dollar bodies, then string literals,
   * each with its own regex pass. That order let a block-comment opener sitting
   * inside a string literal open a comment the SQL parser would never see — and
   * everything up to the next closer, real transaction control included,
   * vanished before the scan ran. A script could then COMMIT halfway through a
   * run and be waved past.
   */
  it("is not fooled by a comment opener hiding in a string literal", () => {
    const sql = [
      "INSERT INTO notes (body) VALUES ('/*');",
      "COMMIT;",
      "INSERT INTO notes (body) VALUES ('*/');",
    ].join("\n");
    expect(containsTransactionControl(sql)).toBe(true);
  });

  it("is not fooled by a dollar-quote tag hiding in a string literal", () => {
    const sql = ["INSERT INTO notes (body) VALUES ('$$');", "COMMIT;", "SELECT '$$';"].join("\n");
    expect(containsTransactionControl(sql)).toBe(true);
  });

  it("is not fooled by a quote hiding inside a comment", () => {
    // The apostrophe in "don't" used to open a literal that swallowed the
    // COMMIT on the next line.
    const sql = ["-- don't do this", "COMMIT;"].join("\n");
    expect(containsTransactionControl(sql)).toBe(true);
  });

  it("reads a backslash escape only inside an E'' string", () => {
    // In an E'' string \\' is an escaped quote, so the literal runs on and the
    // COMMIT inside it is text, not transaction control.
    expect(containsTransactionControl("INSERT INTO t VALUES (E'a\\'b COMMIT');")).toBe(false);
    // In an ordinary literal PostgreSQL treats the backslash as a plain
    // character, so THIS literal ends at the second quote and the COMMIT after
    // it is real.
    expect(containsTransactionControl("INSERT INTO t VALUES ('a\\');\nCOMMIT;")).toBe(true);
  });

  it("handles an unterminated literal without hanging or throwing", () => {
    expect(() => containsTransactionControl("SELECT 'unclosed")).not.toThrow();
    expect(() => containsTransactionControl("/* unclosed")).not.toThrow();
    expect(() => containsTransactionControl("SELECT $$unclosed")).not.toThrow();
  });
});

/**
 * Enum additions are hoisted out of the transaction because PostgreSQL refuses
 * to let a brand-new label be USED in the transaction that created it (55P04).
 * The hoisted copy runs first and the original still runs inside — so only a
 * statement that already says IF NOT EXISTS may be hoisted, or the second run
 * would fail with "enum label already exists".
 */
describe("extractEnumAddValues", () => {
  it("hoists an idempotent addition", () => {
    const sql = "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'elated';\nCREATE INDEX ON t (mood);";
    expect(extractEnumAddValues(sql)).toEqual([
      "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'elated';",
    ]);
  });

  it("leaves an addition without IF NOT EXISTS alone", () => {
    expect(extractEnumAddValues("ALTER TYPE mood ADD VALUE 'elated';")).toEqual([]);
  });

  it("ignores other ALTER TYPE work", () => {
    expect(extractEnumAddValues("ALTER TYPE mood RENAME VALUE 'ok' TO 'fine';")).toEqual([]);
    expect(extractEnumAddValues("ALTER TABLE t ADD COLUMN mood mood;")).toEqual([]);
  });

  it("looks past leading comments", () => {
    const sql = "-- add the new state\nALTER TYPE mood ADD VALUE IF NOT EXISTS 'tired';";
    expect(extractEnumAddValues(sql)).toEqual([
      "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'tired';",
    ]);
  });

  it("does not split a function body at its inner semicolons", () => {
    const sql = [
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END $$ LANGUAGE plpgsql;",
      "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'calm';",
    ].join("\n");
    expect(extractEnumAddValues(sql)).toEqual(["ALTER TYPE mood ADD VALUE IF NOT EXISTS 'calm';"]);
  });

  it("returns them in script order", () => {
    const sql = [
      "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'a';",
      "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'b';",
    ].join("\n");
    expect(extractEnumAddValues(sql)).toEqual([
      "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'a';",
      "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'b';",
    ]);
  });
});

/**
 * The deploy checklist grades a run with changeTypeOf, which answers how far
 * the version moves. A TRUNCATE moves it nowhere, so the checklist reported
 * "nothing in this run is breaking" over a statement that empties a table.
 * This is the second question the screen now asks.
 */
describe("findRowDestroyingStatements", () => {
  it("finds the statements that take rows away", () => {
    expect(findRowDestroyingStatements("TRUNCATE TABLE orders;")).toEqual(["TRUNCATE"]);
    expect(findRowDestroyingStatements("DELETE FROM orders WHERE id = 1;")).toEqual([
      "DELETE",
    ]);
    expect(findRowDestroyingStatements("DROP TABLE orders;")).toEqual(["DROP TABLE"]);
  });

  it("names every distinct kind it found, once each", () => {
    const sql = [
      "TRUNCATE TABLE a;",
      "TRUNCATE TABLE b;",
      "DELETE FROM c;",
    ].join("\n");
    expect(findRowDestroyingStatements(sql)).toEqual(["TRUNCATE", "DELETE"]);
  });

  it("ignores the words in a comment or a string literal", () => {
    const sql = [
      "-- this replaces the old TRUNCATE step",
      "INSERT INTO audit(note) VALUES ('delete from orders');",
    ].join("\n");
    expect(findRowDestroyingStatements(sql)).toEqual([]);
  });

  it("says nothing about a migration that only adds", () => {
    expect(findRowDestroyingStatements("ALTER TABLE orders ADD COLUMN note text;")).toEqual(
      []
    );
  });

  it("counts a dropped column, which takes its values with it", () => {
    expect(
      findRowDestroyingStatements("ALTER TABLE orders DROP COLUMN legacy_ref;")
    ).toEqual(["DROP COLUMN"]);
  });
});

/**
 * The third question, and the one neither of the others answers: will this
 * statement run at all against a table that already has rows in it? A NOT NULL
 * column with no default breaks nothing and deletes nothing — it simply stops.
 */
describe("findMightFailStatements", () => {
  it("finds a NOT NULL column with no default", () => {
    expect(
      findMightFailStatements("ALTER TABLE orders ADD COLUMN ref text NOT NULL;")
    ).toEqual(["NOT NULL column with no default"]);
  });

  it("says nothing when that same column has a default", () => {
    expect(
      findMightFailStatements(
        "ALTER TABLE orders ADD COLUMN ref text NOT NULL DEFAULT '';"
      )
    ).toEqual([]);
  });

  it("reads each column of a multi-column ADD on its own", () => {
    // The safe column must not vouch for the one after it.
    expect(
      findMightFailStatements(
        "ALTER TABLE orders ADD COLUMN a text DEFAULT '', ADD COLUMN b text NOT NULL;"
      )
    ).toEqual(["NOT NULL column with no default"]);
  });

  it("finds the constraints that are validated against existing rows", () => {
    expect(findMightFailStatements("ALTER TABLE orders ALTER COLUMN ref SET NOT NULL;")).toEqual(
      ["SET NOT NULL"]
    );
    expect(
      findMightFailStatements("ALTER TABLE orders ADD CONSTRAINT u UNIQUE (ref);")
    ).toEqual(["UNIQUE constraint"]);
    expect(findMightFailStatements("CREATE UNIQUE INDEX ix ON orders (ref);")).toEqual([
      "UNIQUE index",
    ]);
    expect(
      findMightFailStatements(
        "ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id);"
      )
    ).toEqual(["FOREIGN KEY constraint"]);
    expect(
      findMightFailStatements("ALTER TABLE orders ADD CONSTRAINT ck CHECK (total >= 0);")
    ).toEqual(["CHECK constraint"]);
    expect(
      findMightFailStatements("ALTER TABLE orders ALTER COLUMN total TYPE integer;")
    ).toEqual(["column type change"]);
  });

  it("names every distinct kind it found, once each, in a fixed order", () => {
    const sql = [
      "ALTER TABLE a ALTER COLUMN x SET NOT NULL;",
      "ALTER TABLE b ALTER COLUMN y SET NOT NULL;",
      "CREATE UNIQUE INDEX ix ON c (z);",
    ].join("\n");
    expect(findMightFailStatements(sql)).toEqual(["SET NOT NULL", "UNIQUE index"]);
  });

  it("ignores the words in a comment or a string literal", () => {
    const sql = [
      "-- was: ALTER COLUMN total TYPE integer",
      "INSERT INTO notes(body) VALUES ('set not null on ref');",
    ].join("\n");
    expect(findMightFailStatements(sql)).toEqual([]);
  });

  it("says nothing about a plain nullable column or a plain index", () => {
    expect(findMightFailStatements("ALTER TABLE orders ADD COLUMN note text;")).toEqual([]);
    expect(findMightFailStatements("CREATE INDEX ix ON orders (ref);")).toEqual([]);
  });

  // Generated constraint adds now sit inside a DO block that skips them when
  // they already exist, and a DO body is blanked whole like any other
  // dollar-quoted text. The warning must not vanish along with them.

  /** A statement wrapped the way the generator wraps a constraint add. */
  function guarded(statement: string, tag = "$guard$"): string {
    return [
      `DO ${tag}`,
      "BEGIN",
      "  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('\"orders\"') AND conname = 'c') THEN",
      `    ${statement}`,
      "  END IF;",
      "END",
      `${tag};`,
    ].join("\n");
  }

  const guardedFk =
    'ALTER TABLE "orders" ADD CONSTRAINT "c" FOREIGN KEY (user_id) REFERENCES users(id);';

  it("still finds a foreign key added inside a guard block", () => {
    expect(findMightFailStatements(guarded(guardedFk))).toEqual(["FOREIGN KEY constraint"]);
  });

  it("still finds a CHECK added inside a guard block", () => {
    expect(
      findMightFailStatements(guarded('ALTER TABLE "orders" ADD CONSTRAINT "c" CHECK (total >= 0);'))
    ).toEqual(["CHECK constraint"]);
  });

  it("does not count the NOT NULL restore, which already skips a table with rows", () => {
    const sql = [
      "DO $$",
      "BEGIN",
      "  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('\"orders\"') AND attname = 'note' AND attnotnull) THEN",
      "    NULL;",
      "  ELSIF EXISTS (SELECT 1 FROM \"orders\" LIMIT 1) THEN",
      "    RAISE NOTICE 'Backfill it, then run: ALTER TABLE \"orders\" ALTER COLUMN \"note\" SET NOT NULL;';",
      "  ELSE",
      "    ALTER TABLE \"orders\" ALTER COLUMN \"note\" SET NOT NULL;",
      "  END IF;",
      "END",
      "$$;",
    ].join("\n");
    expect(findMightFailStatements(sql)).toEqual([]);
  });

  it("ignores a constraint that is only mentioned in a comment inside a DO block", () => {
    const sql = guarded("-- was: ADD CONSTRAINT c FOREIGN KEY (user_id) REFERENCES users(id)\n    NULL;");
    expect(findMightFailStatements(sql)).toEqual([]);
  });

  it("reads a $guard$ block the same as a $$ one", () => {
    expect(findMightFailStatements(guarded(guardedFk, "$$"))).toEqual(["FOREIGN KEY constraint"]);
    expect(findMightFailStatements(guarded(guardedFk))).toEqual(
      findMightFailStatements(guarded(guardedFk, "$$"))
    );
  });
});

describe("doBlockBodies", () => {
  it("returns the inside of each DO block, masked, and nothing from outside one", () => {
    const sql = [
      "ALTER TABLE a ADD COLUMN x text;",
      "DO $guard$",
      "BEGIN",
      "  -- a note",
      "  ALTER TABLE b RENAME COLUMN c TO d;",
      "END",
      "$guard$;",
      "DO $$ BEGIN RAISE NOTICE 'drop table'; END $$;",
    ].join("\n");
    const bodies = doBlockBodies(sql);
    expect(bodies).toContain("ALTER TABLE b RENAME COLUMN c TO d;");
    expect(bodies).toContain("RAISE NOTICE");
    expect(bodies).not.toContain("ADD COLUMN");
    expect(bodies).not.toContain("a note");
    expect(bodies).not.toContain("drop table");
  });

  it("finds a DO block that has a comment in front of it", () => {
    expect(doBlockBodies("-- why\nDO $$ BEGIN DROP TABLE t; END $$;")).toContain("DROP TABLE t;");
  });

  it("returns nothing when there is no DO block", () => {
    const sql = "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;";
    expect(doBlockBodies(sql).trim()).toBe("");
  });
});
