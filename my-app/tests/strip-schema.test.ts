// Taking a schema's own name out of what PostgreSQL prints, without touching data.
//
// The snapshot stores defaults, checks, policies, views, triggers and functions
// with their own schema's name taken out, so the same object in app and prod
// compares equal and a migration does not tie the target to the source schema.
// The strip used to run over the whole text, string literals included:
// `current_setting('app.tenant_id')` became `current_setting('tenant_id')` and
// a CHECK on '%@app.example.com' became '%@example.com'. A migration then wrote
// the edited values. These tests pin the rule: names go, literal text stays,
// except a literal cast to an object-name type like regclass, which is a name.
import { stripSchemaFromExpr } from "@/lib/postgres";

const strip = (expr: string, schema = "app") => stripSchemaFromExpr(expr, schema);

describe("stripSchemaFromExpr — string literals", () => {
  it("leaves the text of a string literal as written", () => {
    for (const expr of [
      "(tenant_id = (current_setting('app.tenant_id'::text))::uuid)",
      "((email)::text ~~ '%@app.example.com'::text)",
      "(note <> 'app.'::text)",
      "(path = E'app.\\\\logs'::text)",
    ]) {
      expect(strip(expr)).toBe(expr);
    }
  });

  it("strips inside a literal cast to an object-name type, which is a reference", () => {
    expect(strip("nextval('app.orders_id_seq'::regclass)")).toBe(
      "nextval('orders_id_seq'::regclass)"
    );
    expect(strip(`nextval('app."Orders_id_seq"'::regclass)`)).toBe(
      `nextval('"Orders_id_seq"'::regclass)`
    );
    expect(strip(`nextval('"App".orders_id_seq'::regclass)`, "App")).toBe(
      "nextval('orders_id_seq'::regclass)"
    );
    expect(strip("(tableoid = 'app.orders'::regclass)")).toBe("(tableoid = 'orders'::regclass)");
    expect(strip("'app.touch(app.orders)'::regprocedure")).toBe("'touch(orders)'::regprocedure");
    // Another schema's sequence keeps its schema.
    expect(strip("nextval('other.orders_id_seq'::regclass)")).toBe(
      "nextval('other.orders_id_seq'::regclass)"
    );
  });

  it("reads a quote doubled inside the literal as one quote, and writes it back doubled", () => {
    expect(strip(`nextval('"it''s".orders_id_seq'::regclass)`, "it's")).toBe(
      "nextval('orders_id_seq'::regclass)"
    );
    expect(strip(`nextval('app."o''brien_seq"'::regclass)`)).toBe(
      `nextval('"o''brien_seq"'::regclass)`
    );
  });
});

describe("stripSchemaFromExpr — names", () => {
  it("strips the schema's own name in front of a name, quoted or not", () => {
    expect(strip("'active'::app.order_status")).toBe("'active'::order_status");
    expect(strip("app.gen_code()")).toBe("gen_code()");
    expect(strip(`"app"."Status"`)).toBe(`"Status"`);
  });

  it("keeps another schema's name, and text that only contains the name inside quotes", () => {
    expect(strip("other.gen_code()")).toBe("other.gen_code()");
    expect(strip(`SELECT "v1.app.total" FROM app.orders`)).toBe(`SELECT "v1.app.total" FROM orders`);
  });

  it("keeps a trigger's argument, which the function reads as text", () => {
    expect(
      strip(
        "CREATE TRIGGER orders_audit AFTER UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.audit('app.orders')"
      )
    ).toBe(
      "CREATE TRIGGER orders_audit AFTER UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION audit('app.orders')"
    );
  });

  it("passes null through, and changes nothing without a schema", () => {
    expect(stripSchemaFromExpr(null, "app")).toBeNull();
    expect(stripSchemaFromExpr("app.gen_code()", "")).toBe("app.gen_code()");
  });
});

describe("stripSchemaFromExpr — a function definition", () => {
  it("strips the references in the header and body, and keeps the body's strings", () => {
    const definition = [
      "CREATE OR REPLACE FUNCTION app.tenant_orders()",
      " RETURNS SETOF app.orders",
      " LANGUAGE plpgsql",
      "AS $function$",
      "BEGIN",
      "  -- don't read another tenant's app.orders",
      "  RAISE NOTICE $msg$app.orders isn't filtered yet$msg$;",
      "  RETURN QUERY SELECT * FROM app.orders",
      "    WHERE tenant_id = current_setting('app.tenant_id')::uuid;",
      "END;",
      "$function$",
      "",
    ].join("\n");

    expect(strip(definition)).toBe(
      [
        "CREATE OR REPLACE FUNCTION tenant_orders()",
        " RETURNS SETOF orders",
        " LANGUAGE plpgsql",
        "AS $function$",
        "BEGIN",
        // A comment keeps its text, and the quotes in it open no string.
        "  -- don't read another tenant's orders",
        // A dollar-quoted string inside the body is a string.
        "  RAISE NOTICE $msg$app.orders isn't filtered yet$msg$;",
        "  RETURN QUERY SELECT * FROM orders",
        "    WHERE tenant_id = current_setting('app.tenant_id')::uuid;",
        "END;",
        "$function$",
        "",
      ].join("\n")
    );
  });
});
