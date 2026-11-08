// generate-sql: the warning about roles the target may not have.
//
// Roles belong to the whole server, so a script can name one the target has
// never heard of. The warning that says so read every GRANT, REVOKE and OWNER
// TO alike: a script that only moved an owner said "This script grants to",
// and a role the script only revoked from was listed as one to create, though
// the target's own snapshot is where that role came from. The note about OWNER
// TO statements near the end also showed when there were none.
import { compareSchemas } from "@/lib/compare";
import { generateMigration } from "@/lib/generate-sql";
import type { PrivilegeGrant, PrivilegeSnapshot, SchemaSnapshot } from "@/lib/postgres";
import { column, schema, table } from "./helpers/snapshots";

function ordersWith(owner: string, grants: PrivilegeGrant[]): SchemaSnapshot {
  // The comparison matches on the definition text, so the owner goes in it.
  const text = [`owner=${owner}`, ...grants.map((g) => `${g.grantee}=${g.privileges.join(",")}`)].join(" ");
  const privilege: PrivilegeSnapshot = {
    objectKind: "TABLE",
    objectName: "orders",
    owner,
    grants,
    definition: text,
    normalizedDefinition: text,
  };
  return schema([table("orders", [column("id", { nullable: false })])], { privileges: [privilege] });
}

function migrate(source: SchemaSnapshot, target: SchemaSnapshot) {
  return generateMigration(compareSchemas(source, target));
}

const roleWarning = (warnings: string[]) => warnings.find((w) => w.includes("CREATE ROLE"));
const ownerNote = (warnings: string[]) => warnings.find((w) => w.includes("OWNER TO statements"));

const select = (grantee: string, grantable: string[] = []): PrivilegeGrant => ({
  grantee,
  privileges: ["SELECT"],
  grantable,
});

describe("the warning about roles the target may not have", () => {
  it("calls a new owner an owner, not a grant", () => {
    const result = migrate(ordersWith("app_owner", []), ordersWith("postgres", []));

    expect(result.statements.map((s) => s.sql)).toContain('ALTER TABLE "orders" OWNER TO "app_owner";');
    expect(roleWarning(result.warnings)).toMatch(/^This script sets the owner to "app_owner"\. /);
    expect(result.warnings.join("\n")).not.toMatch(/grants to/);
    expect(ownerNote(result.warnings)).toBeDefined();
  });

  it("leaves out a role the script only revokes from, and the owner note with it", () => {
    const result = migrate(ordersWith("app_owner", []), ordersWith("app_owner", [select("analyst")]));

    expect(result.statements.map((s) => s.sql)).toContain('REVOKE SELECT ON TABLE "orders" FROM "analyst";');
    expect(roleWarning(result.warnings)).toBeUndefined();
    expect(ownerNote(result.warnings)).toBeUndefined();
  });

  it("lists every role granted to in order, the owner apart, and not PUBLIC", () => {
    const result = migrate(
      ordersWith("app_owner", [select("reporter", ["SELECT"]), select("analyst"), select("PUBLIC")]),
      ordersWith("postgres", [])
    );

    // The grant option goes after the role, so it must not hide the role.
    expect(result.statements.map((s) => s.sql)).toContain(
      'GRANT SELECT ON TABLE "orders" TO "reporter" WITH GRANT OPTION;'
    );
    expect(roleWarning(result.warnings)).toMatch(
      /^This script grants to "analyst", "reporter" and sets the owner to "app_owner"\. /
    );
  });
});
