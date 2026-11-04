// The text views, checks, indexes, triggers, policies and functions are
// compared by.
//
// normalizeDefinition squeezes whitespace so the same definition read from two
// servers compares equal however each one laid it out. It used to squeeze it
// everywhere, string literals included, so a CHECK on 'a  b' and one on 'a b'
// compared equal and the difference was never reported. These tests pin the
// rule: layout in the SQL is squeezed, text inside quotes and bodies is not.
import { normalizeDefinition, withCurrentNormalization, type SchemaSnapshot } from "@/lib/postgres";

const same = (a: string, b: string) => normalizeDefinition(a) === normalizeDefinition(b);

describe("normalizeDefinition — layout outside quotes", () => {
  it("squeezes every run of whitespace in the SQL to one space and trims the ends", () => {
    expect(normalizeDefinition("  SELECT  id,\n\t  name\r\n   FROM\tt  ")).toBe(
      "SELECT id, name FROM t"
    );
  });

  it("still treats two layouts of the same view as equal", () => {
    // pg_get_viewdef wraps and indents differently between server versions.
    const wrapped = " SELECT o.id,\n    o.status\n   FROM orders o\n  WHERE (o.status = 'open'::text);";
    const oneLine = "SELECT o.id, o.status FROM orders o WHERE (o.status = 'open'::text);";
    expect(same(wrapped, oneLine)).toBe(true);
  });

  it("does not change case anywhere", () => {
    expect(normalizeDefinition("CHECK ((code = 'ABC'::text))")).toBe("CHECK ((code = 'ABC'::text))");
    expect(same("(code = 'ABC'::text)", "(code = 'abc'::text)")).toBe(false);
    expect(same(`("Total" > 0)`, `("total" > 0)`)).toBe(false);
  });
});

describe("normalizeDefinition — text inside quotes is kept as written", () => {
  it("keeps the spaces inside a string literal", () => {
    expect(same("CHECK ((note <> 'a  b'::text))", "CHECK ((note <> 'a b'::text))")).toBe(false);
    expect(normalizeDefinition("CHECK ((note  <>  'a  b'::text))")).toBe(
      "CHECK ((note <> 'a  b'::text))"
    );
  });

  it("keeps a newline inside a string literal", () => {
    expect(same("(note <> 'a\nb'::text)", "(note <> 'a b'::text)")).toBe(false);
  });

  it("keeps the spaces inside a quoted name", () => {
    expect(same(`SELECT "My  Col" FROM t`, `SELECT "My Col" FROM t`)).toBe(false);
    expect(normalizeDefinition(`SELECT   "My  Col"   FROM t`)).toBe(`SELECT "My  Col" FROM t`);
  });

  it("keeps the spaces inside a dollar-quoted body, tagged or not", () => {
    const fn = (body: string) =>
      `CREATE OR REPLACE FUNCTION f()\n RETURNS integer\n LANGUAGE sql\nAS ${body}\n`;
    expect(same(fn("$$ SELECT  1 $$"), fn("$$ SELECT 1 $$"))).toBe(false);
    expect(same(fn("$function$\nBEGIN\n  RETURN 1;\nEND\n$function$"), fn("$function$ BEGIN RETURN 1; END $function$"))).toBe(false);
    // The header around the body is still layout.
    expect(normalizeDefinition(fn("$$ SELECT  1 $$"))).toBe(
      "CREATE OR REPLACE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT  1 $$"
    );
  });

  it("keeps the text of a comment", () => {
    expect(same("SELECT 1 /* a  b */", "SELECT 1 /* a b */")).toBe(false);
  });
});

describe("normalizeDefinition — the end of a literal is found correctly", () => {
  it("reads past a doubled quote inside a literal", () => {
    // If 'it''s' ended the literal early, "  x" would be squeezed, and the
    // SQL after the real end would be kept as if it were still inside.
    expect(same("(note = 'it''s  x'::text)", "(note = 'it''s x'::text)")).toBe(false);
    expect(normalizeDefinition("(note = 'it''s'::text)   AND   (id  >  1)")).toBe(
      "(note = 'it''s'::text) AND (id > 1)"
    );
  });

  it("reads past a backslash-escaped quote inside an E'' string", () => {
    expect(same("(note = E'it\\'s  x'::text)", "(note = E'it\\'s x'::text)")).toBe(false);
    expect(normalizeDefinition("(note = E'it\\'s'::text)   AND   (id  >  1)")).toBe(
      "(note = E'it\\'s'::text) AND (id > 1)"
    );
  });

  it("squeezes the SQL between two literals", () => {
    expect(normalizeDefinition("(a = 'x  y'::text)  OR\n  (b = 'z'::text)")).toBe(
      "(a = 'x  y'::text) OR (b = 'z'::text)"
    );
  });
});

describe("withCurrentNormalization — a baseline stored by an older build", () => {
  it("works each normalizedDefinition out again from its definition", () => {
    // An older build squeezed the body too. Read back as stored, that text
    // would differ from a fresh capture of the same function and be called drift.
    const definition = "CREATE FUNCTION f()\n RETURNS int\nAS $$\n  SELECT  1\n$$";
    const stored = {
      tables: [],
      routines: [{ name: "f", definition, normalizedDefinition: definition.replace(/\s+/g, " ").trim() }],
    } as unknown as SchemaSnapshot;
    const read = withCurrentNormalization(stored);
    expect(read.routines?.[0].normalizedDefinition).toBe(normalizeDefinition(definition));
    // The stored value itself is left alone.
    expect(stored.routines?.[0].normalizedDefinition).toBe("CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$");
  });

  it("reaches the keys and indexes inside each table", () => {
    const check = "CHECK ((note <> 'a  b'::text))";
    const stored = {
      tables: [{ name: "t", columns: [], checkConstraints: [{ name: "c", definition: check, normalizedDefinition: "old" }] }],
    } as unknown as SchemaSnapshot;
    const read = withCurrentNormalization(stored) as unknown as {
      tables: { checkConstraints: { normalizedDefinition: string }[] }[];
    };
    expect(read.tables[0].checkConstraints[0].normalizedDefinition).toBe(check);
  });
});
