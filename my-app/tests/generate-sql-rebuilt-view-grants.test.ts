// generate-sql: a view the script drops and rebuilds must get its owner and
// grants back.
//
// DROP VIEW takes a view's owner and grants with it, and CREATE VIEW makes the
// new one owned by whoever runs the script and granted to nobody. The grants
// are usually identical in both schemas, so they are in no diff, and nothing
// wrote them out again: after the migration, the role the application reads
// the view as got "permission denied". When the grants did differ, only the
// difference was written, so the grants both sides shared were lost the same
// way.
//
// Checked on a real PostgreSQL 18 while fixing it, with a view owned by
// app_owner and granted to reporter over a column changing from integer to
// numeric: before, the rebuilt view was owned by the role that ran the script
// and granted to nobody, and comparing again still showed its grants as
// different; after, the owner and the grant are back and nothing differs.
import { compareSchemas } from "@/lib/compare";
import {
  generateMigration,
  generateRollback,
  statementsThatRun,
  type MigrationOptions,
} from "@/lib/generate-sql";
import type { PrivilegeGrant, PrivilegeSnapshot, SchemaSnapshot, ViewSnapshot } from "@/lib/postgres";
import { column, schema, table } from "./helpers/snapshots";

function runs(source: SchemaSnapshot, target: SchemaSnapshot, options: MigrationOptions = {}): string[] {
  return statementsThatRun(generateMigration(compareSchemas(source, target), options)).map((s) => s.sql);
}

function viewGrants(grants: PrivilegeGrant[], over: Partial<PrivilegeSnapshot> = {}): PrivilegeSnapshot {
  const text = grants.map((g) => `${g.grantee}=${g.privileges.join(",")}`).join(" ");
  return {
    objectKind: "VIEW",
    objectName: "big_orders",
    owner: "app_owner",
    grants,
    definition: text,
    normalizedDefinition: text,
    ...over,
  };
}

const reporter: PrivilegeGrant = { grantee: "reporter", privileges: ["SELECT"], grantable: [] };
const analyst: PrivilegeGrant = { grantee: "analyst", privileges: ["SELECT"], grantable: [] };

/**
 * orders, with `amount` typed as `amountType`, and a view reading it. A column
 * type change is refused while a view reads the column, so the generator drops
 * the view and rebuilds it even though it is the same on both sides.
 */
function shop(
  amountType: string,
  privileges: PrivilegeSnapshot[] | undefined,
  options: { materialized?: boolean } = {}
): SchemaSnapshot {
  const view: ViewSnapshot = {
    name: "big_orders",
    materialized: options.materialized ?? false,
    dependsOn: ["orders"],
    definition: " SELECT id, amount FROM orders WHERE amount > 100;",
    normalizedDefinition: "select id, amount from orders where amount > 100",
    columns: ["id", "amount"],
  };
  return schema(
    [table("orders", [column("id", { nullable: false }), column("amount", { typeDisplay: amountType })])],
    { views: [view], privileges }
  );
}

describe("a view rebuilt for a column type change", () => {
  it("gets its owner and grants back when both sides had the same ones", () => {
    const sql = runs(
      shop("numeric", [viewGrants([reporter])]),
      shop("integer", [viewGrants([reporter])])
    );

    const create = sql.findIndex((s) => s.includes('CREATE') && s.includes('"big_orders"'));
    const owner = sql.findIndex((s) => s === 'ALTER VIEW "big_orders" OWNER TO "app_owner";');
    const grant = sql.findIndex((s) => /^GRANT SELECT ON TABLE "big_orders" TO "reporter";$/.test(s));
    expect(create).toBeGreaterThanOrEqual(0);
    // After the CREATE, or there is nothing to grant on yet.
    expect(owner).toBeGreaterThan(create);
    expect(grant).toBeGreaterThan(create);
  });

  it("writes every grant the source has, not only the ones that differ", () => {
    // The target lacked analyst. Comparing against it wrote analyst's grant and
    // nothing else, but the rebuild had already taken reporter's away too.
    const sql = runs(
      shop("numeric", [viewGrants([analyst, reporter])]),
      shop("integer", [viewGrants([reporter])])
    );

    expect(sql).toContain('GRANT SELECT ON TABLE "big_orders" TO "analyst";');
    expect(sql).toContain('GRANT SELECT ON TABLE "big_orders" TO "reporter";');
    // A REVOKE would be aimed at grants the rebuild already removed.
    expect(sql.filter((s) => s.startsWith("REVOKE"))).toEqual([]);
    expect(sql.filter((s) => s.includes("OWNER TO"))).toHaveLength(1);
  });

  it("restores them in the rollback too", () => {
    const report = compareSchemas(
      shop("numeric", [viewGrants([reporter])]),
      shop("integer", [viewGrants([reporter])])
    );
    const rollback = generateRollback(report);
    const sql = rollback.statements.map((s) => s.sql);

    expect(sql).toContain('ALTER VIEW "big_orders" OWNER TO "app_owner";');
    expect(sql).toContain('GRANT SELECT ON TABLE "big_orders" TO "reporter";');
  });

  it("holds a materialized view's grants back beside its held-back drop", () => {
    // Safe mode comments out dropping a materialized view, so the old one is
    // still there and the grants have nothing new to go on.
    const source = shop("numeric", [viewGrants([reporter], { objectKind: "MATERIALIZED VIEW" })], { materialized: true });
    const target = shop("integer", [viewGrants([reporter], { objectKind: "MATERIALIZED VIEW" })], { materialized: true });

    expect(runs(source, target).filter((s) => s.includes("OWNER TO") || s.startsWith("GRANT"))).toEqual([]);
    const armed = runs(source, target, { allowDataLoss: true });
    expect(armed).toContain('ALTER MATERIALIZED VIEW "big_orders" OWNER TO "app_owner";');
    expect(armed).toContain('GRANT SELECT ON TABLE "big_orders" TO "reporter";');
  });

  it("writes nothing when the source never recorded privileges", () => {
    const sql = runs(shop("numeric", undefined), shop("integer", undefined));
    expect(sql.filter((s) => s.includes("OWNER TO") || s.startsWith("GRANT"))).toEqual([]);
  });
});

describe("a view the script leaves alone", () => {
  it("gets no ownership or grant statements", () => {
    const sql = runs(shop("integer", [viewGrants([reporter])]), shop("integer", [viewGrants([reporter])]));
    expect(sql).toEqual([]);
  });
});
