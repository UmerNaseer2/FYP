// generate-sql: an owner change a login may not make is skipped, not fatal.
//
// Only a superuser, or a login that may act as the new owner, can give an
// object to another role. The apply route runs a script in one transaction, so
// one refused ALTER ... OWNER TO used to undo the whole deploy. A client tester
// hit it with the reader login the setup guide makes: 'must be able to SET ROLE
// "postgres"'. The owner change now sits in a DO block that catches that one
// refusal and raises a warning naming the object (ownerStatement in
// lib/sql/generate/privileges.ts). tests/generate-sql-db-owner-guard.test.ts
// runs these blocks on a real server as such a login.
import { compareSchemas } from "@/lib/compare/diff";
import { generateMigration, generateRollback } from "@/lib/sql/generate";
import type { SqlStatement } from "@/lib/sql/generate";
import type { PrivilegeGrant, PrivilegeSnapshot, SchemaSnapshot } from "@/lib/postgres";
import { findRowDestroyingStatements } from "@/lib/sql/guard";
import { gradeSql } from "@/lib/versions/change-type";
import { plainSql } from "./helpers/owner-sql";
import { column, schema, table } from "./helpers/snapshots";

function tableWith(name: string, owner: string, grants: PrivilegeGrant[]): SchemaSnapshot {
  // The comparison matches on the definition text, so the owner goes in it.
  const text = [`owner=${owner}`, ...grants.map((g) => `${g.grantee}=${g.privileges.join(",")}`)].join(" ");
  const privilege: PrivilegeSnapshot = {
    objectKind: "TABLE",
    objectName: name,
    owner,
    grants,
    definition: text,
    normalizedDefinition: text,
  };
  return schema([table(name, [column("id", { nullable: false })])], { privileges: [privilege] });
}

const ordersWith = (owner: string, grants: PrivilegeGrant[] = []) => tableWith("orders", owner, grants);

const select = (grantee: string): PrivilegeGrant => ({ grantee, privileges: ["SELECT"], grantable: [] });

function migrate(source: SchemaSnapshot, target: SchemaSnapshot) {
  return generateMigration(compareSchemas(source, target));
}

function ownerChanges(statements: SqlStatement[]): SqlStatement[] {
  return statements.filter((statement) => statement.kind === "ALTER_OWNER");
}

describe("an owner change the login may not make", () => {
  it("is written in a block that skips it with a warning naming the object", () => {
    const [owner, ...others] = ownerChanges(migrate(ordersWith("app_owner"), ordersWith("postgres")).statements);

    expect(others).toEqual([]);
    expect(owner.sql).toBe(
      [
        "DO $guard$",
        "BEGIN",
        '  ALTER TABLE "orders" OWNER TO "app_owner";',
        "EXCEPTION WHEN insufficient_privilege THEN",
        "  RAISE WARNING 'The owner of % was not changed: %', 'table orders', SQLERRM;",
        "END",
        "$guard$;",
      ].join("\n")
    );
    expect(owner).toMatchObject({
      description: 'Set owner of table orders to "app_owner" (was "postgres")',
      severity: "breaking",
      tableName: "orders",
      role: "app_owner",
    });
  });

  it("catches only the refusal, so a role that does not exist still stops the run", () => {
    const [owner] = ownerChanges(migrate(ordersWith("app_owner"), ordersWith("postgres")).statements);

    expect(owner.sql.match(/EXCEPTION WHEN/g)).toHaveLength(1);
    expect(owner.sql).not.toMatch(/\bOTHERS\b/i);
    expect(owner.sql).not.toMatch(/\bEXECUTE\b/);
  });

  it("is only a note on a table the script creates, which has no owner to lose", () => {
    const { statements } = migrate(ordersWith("app_owner"), schema([], { privileges: [] }));
    const [owner] = ownerChanges(statements);

    expect(owner).toMatchObject({ description: 'Set owner of table orders to "app_owner"', severity: "info" });
    expect(plainSql(owner)).toBe('ALTER TABLE "orders" OWNER TO "app_owner";');
    // A CREATE names no role, so the role warning never reads one off it.
    expect(statements.find((statement) => statement.kind === "CREATE_TABLE")).not.toHaveProperty("role");
  });

  it("puts the role on every grant, revoke and owner change, PUBLIC included", () => {
    const { statements } = migrate(
      ordersWith("app_owner", [select("PUBLIC"), select("analyst")]),
      ordersWith("postgres", [select("reporter")])
    );

    expect(statements.map((statement) => [statement.kind, statement.role])).toEqual(
      expect.arrayContaining([
        ["ALTER_OWNER", "app_owner"],
        ["GRANT", "PUBLIC"],
        ["GRANT", "analyst"],
        ["REVOKE", "reporter"],
      ])
    );
    expect(statements.map((statement) => statement.sql)).toContain('GRANT SELECT ON TABLE "orders" TO PUBLIC;');
  });

  it("picks another dollar tag when the name holds the first one", () => {
    const [owner] = ownerChanges(
      migrate(tableWith("a$guard$b", "app_owner", []), tableWith("a$guard$b", "postgres", [])).statements
    );

    expect(owner.sql.startsWith("DO $guard1$\n")).toBe(true);
    expect(owner.sql.endsWith("\n$guard1$;")).toBe(true);
    expect(plainSql(owner)).toBe('ALTER TABLE "a$guard$b" OWNER TO "app_owner";');
  });

  it("doubles a quote in the name it reports, and passes a % as text", () => {
    const [owner] = ownerChanges(
      migrate(tableWith("it's 100%", "app_owner", []), tableWith("it's 100%", "postgres", [])).statements
    );

    expect(owner.sql).toContain(
      "RAISE WARNING 'The owner of % was not changed: %', 'table it''s 100%', SQLERRM;"
    );
    expect(plainSql(owner)).toBe(`ALTER TABLE "it's 100%" OWNER TO "app_owner";`);
  });

  it("grades and guards the same as the plain ALTER it holds", () => {
    const { statements } = migrate(ordersWith("app_owner"), ordersWith("postgres"));
    const [owner] = ownerChanges(statements);

    expect(gradeSql(owner.sql)).toEqual(gradeSql(plainSql(owner)));
    expect(gradeSql(owner.sql).level).toBe("breaking");
    expect(findRowDestroyingStatements(statements.map((statement) => statement.sql).join("\n"))).toEqual([]);
  });

  it("says in the owner note that such a login skips the change and the rest runs", () => {
    const { warnings } = migrate(ordersWith("app_owner"), ordersWith("postgres"));
    const note = warnings.find((warning) => warning.includes("OWNER TO statements"));

    expect(note).toMatch(/skips that owner change with a warning, the rest of the script still runs/);
  });

  describe("next to the schema's own grants", () => {
    const entry = (
      objectKind: PrivilegeSnapshot["objectKind"],
      objectName: string,
      owner: string,
      grants: PrivilegeGrant[],
      identityArguments?: string
    ): PrivilegeSnapshot => {
      const text = [`owner=${owner}`, ...grants.map((g) => `${g.grantee}=${g.privileges.join(",")}`)].join(" ");
      return { objectKind, objectName, identityArguments, owner, grants, definition: text, normalizedDefinition: text };
    };
    const create = (grantee: string): PrivilegeGrant => ({ grantee, privileges: ["CREATE"], grantable: [] });
    // PostgreSQL gives an object to a role only when that role may create in
    // its schema. Entries sort by name, and "function" comes before "schema".
    const report = compareSchemas(
      schema([], {
        privileges: [
          entry("FUNCTION", "add_one", "app_owner", [], "integer"),
          entry("SCHEMA", "public", "postgres", [create("app_owner")]),
          entry("TABLE", "orders", "app_owner", []),
        ],
      }),
      schema([], {
        privileges: [
          entry("FUNCTION", "add_one", "postgres", [], "integer"),
          entry("SCHEMA", "public", "postgres", [create("old_owner")]),
          entry("TABLE", "orders", "postgres", []),
        ],
      })
    );

    it("grants on the schema before any owner change, and revokes on it last", () => {
      const sql = generateMigration(report).statements.map(plainSql);

      expect(sql).toEqual([
        'GRANT CREATE ON SCHEMA "public" TO "app_owner";',
        'ALTER FUNCTION "add_one"(integer) OWNER TO "app_owner";',
        'ALTER TABLE "orders" OWNER TO "app_owner";',
        'REVOKE CREATE ON SCHEMA "public" FROM "old_owner";',
      ]);
    });

    it("keeps that order in the rollback", () => {
      const sql = generateRollback(report).statements.map(plainSql);

      expect(sql).toEqual([
        'GRANT CREATE ON SCHEMA "public" TO "old_owner";',
        'ALTER FUNCTION "add_one"(integer) OWNER TO "postgres";',
        'ALTER TABLE "orders" OWNER TO "postgres";',
        'REVOKE CREATE ON SCHEMA "public" FROM "app_owner";',
      ]);
    });
  });

  describe("when one schema is copied into another", () => {
    const usage = (grantee: string): PrivilegeGrant => ({ grantee, privileges: ["USAGE"], grantable: [] });
    const schemaPrivilege = (name: string, owner: string, grants: PrivilegeGrant[]): PrivilegeSnapshot => {
      const text = [`owner=${owner}`, ...grants.map((g) => `${g.grantee}=${g.privileges.join(",")}`)].join(" ");
      return { objectKind: "SCHEMA", objectName: name, owner, grants, definition: text, normalizedDefinition: text };
    };
    // The client's test form copies shop_v2 into shop_v1 inside one database.
    const report = compareSchemas(
      schema([], { schema: "shop_v2", privileges: [schemaPrivilege("shop_v2", "app_owner", [usage("analyst")])] }),
      schema([], {
        schema: "shop_v1",
        privileges: [schemaPrivilege("shop_v1", "postgres", [usage("analyst"), usage("reporter")])],
      })
    );

    it("names the target schema, and the owner it had", () => {
      const { statements } = generateMigration(report);
      const [owner] = ownerChanges(statements);

      expect(plainSql(owner)).toBe('ALTER SCHEMA "shop_v1" OWNER TO "app_owner";');
      expect(owner.sql).toContain("'schema shop_v1'");
      expect(owner.description).toBe('Set owner of schema shop_v1 to "app_owner" (was "postgres")');
      expect(owner.severity).toBe("breaking");
      expect(statements.map((statement) => statement.sql).join("\n")).not.toContain("shop_v2");
    });

    it("reads the target's grants, so it revokes the extra one and grants nothing twice", () => {
      const sql = generateMigration(report).statements.map(plainSql);

      expect(sql).toEqual(['ALTER SCHEMA "shop_v1" OWNER TO "app_owner";', 'REVOKE USAGE ON SCHEMA "shop_v1" FROM "reporter";']);
    });

    it("puts the owner and the grant back in the rollback", () => {
      const sql = generateRollback(report).statements.map(plainSql);

      expect(sql).toEqual(['ALTER SCHEMA "shop_v1" OWNER TO "postgres";', 'GRANT USAGE ON SCHEMA "shop_v1" TO "reporter";']);
    });
  });
});
