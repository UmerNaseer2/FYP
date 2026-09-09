import { containsTransactionControl, extractEnumAddValues } from "@/lib/sql-guard";

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
