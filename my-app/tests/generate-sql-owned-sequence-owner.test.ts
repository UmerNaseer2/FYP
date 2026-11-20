// generate-sql: no owner change on a sequence that a column owns.
//
// A serial or identity column owns its sequence, and PostgreSQL keeps that
// sequence's owner in step with the table's: ALTER TABLE ... OWNER TO moves it
// along, and an owner change on the sequence by itself is refused with
// "cannot change owner of sequence ... is linked to table ...". Privilege
// entries sort SEQUENCE before TABLE, so the script used to change the
// sequence's owner first, and that one refusal rolled the whole deploy back.
// A client tester hit it on a first deploy of a new table with a serial id.
//
// These tests pin the fix: no OWNER TO for a sequence a column owns, while its
// grants and every other object's owner change are still written.
import { compareSchemas } from "@/lib/compare/diff";
import { generateMigration } from "@/lib/sql/generate";
import type {
  ColumnSnapshot,
  PrivilegeGrant,
  PrivilegeObjectKind,
  PrivilegeSnapshot,
  SchemaSnapshot,
  SequenceSnapshot,
} from "@/lib/postgres";
import { plainSql } from "./helpers/owner-sql";
import { column, schema, table } from "./helpers/snapshots";

function privilege(
  objectKind: PrivilegeObjectKind,
  objectName: string,
  owner: string,
  grants: PrivilegeGrant[] = []
): PrivilegeSnapshot {
  // The comparison matches on the definition text, so the owner goes in it.
  const text = [`owner=${owner}`, ...grants.map((g) => `${g.grantee}=${g.privileges.join(",")}`)].join(" ");
  return { objectKind, objectName, owner, grants, definition: text, normalizedDefinition: text };
}

function sequence(name: string, ownedByTable: string | null): SequenceSnapshot {
  return {
    name,
    dataType: "integer",
    startValue: "1",
    increment: "1",
    minValue: "1",
    maxValue: "2147483647",
    cycles: false,
    cacheSize: "1",
    ownedByTable,
    ownedByColumn: ownedByTable === null ? null : "id",
  };
}

const serialId: ColumnSnapshot = column("id", {
  nullable: false,
  isPrimaryKey: true,
  columnDefault: "nextval('orders_id_seq'::regclass)",
});
const identityId: ColumnSnapshot = column("id", {
  nullable: false,
  isPrimaryKey: true,
  identity: "BY DEFAULT",
});
const usage: PrivilegeGrant = { grantee: "app_rw", privileges: ["USAGE", "SELECT"], grantable: [] };
const readWrite: PrivilegeGrant = {
  grantee: "app_rw",
  privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  grantable: [],
};

/** An `orders` table owned by `owner`, its key's sequence, and their grants. */
function orders(owner: string, id: ColumnSnapshot = serialId): SchemaSnapshot {
  return schema(
    [table("orders", [id, column("note", { typeDisplay: "text" })])],
    {
      sequences: [sequence("orders_id_seq", "orders")],
      privileges: [
        privilege("SEQUENCE", "orders_id_seq", owner, [usage]),
        privilege("TABLE", "orders", owner, [readWrite]),
      ],
    }
  );
}

const empty = (): SchemaSnapshot => schema([], { sequences: [], privileges: [] });

function script(source: SchemaSnapshot, target: SchemaSnapshot): string[] {
  return generateMigration(compareSchemas(source, target)).statements.map(plainSql);
}

const TABLE_OWNER = 'ALTER TABLE "orders" OWNER TO "app_owner";';
const SEQUENCE_OWNER = 'ALTER SEQUENCE "orders_id_seq" OWNER TO "app_owner";';
const SEQUENCE_GRANT = 'GRANT USAGE, SELECT ON SEQUENCE "orders_id_seq" TO "app_rw";';

describe("the owner of a sequence a column owns", () => {
  it("is left to the table's OWNER TO on a new table with a serial key", () => {
    const sql = script(orders("app_owner"), empty());

    expect(sql).toContain(TABLE_OWNER);
    expect(sql).not.toContain(SEQUENCE_OWNER);
    // The sequence's grants are its own, so they stay.
    expect(sql).toContain(SEQUENCE_GRANT);
  });

  it("is left to the table's OWNER TO on a new table with an identity key", () => {
    const sql = script(orders("app_owner", identityId), empty());

    expect(sql).toContain(TABLE_OWNER);
    expect(sql).not.toContain(SEQUENCE_OWNER);
    expect(sql).toContain(SEQUENCE_GRANT);
  });

  it("is left to the table's OWNER TO when an existing table changes owner", () => {
    const sql = script(orders("app_owner"), orders("postgres"));

    expect(sql).toContain(TABLE_OWNER);
    expect(sql).not.toContain(SEQUENCE_OWNER);
    expect(sql.some((line) => /ALTER SEQUENCE .* OWNER TO/.test(line))).toBe(false);
  });

  it("still gives a sequence no column owns its own OWNER TO", () => {
    const loose = (owner: string) =>
      schema([], {
        sequences: [sequence("invoice_numbers", null)],
        privileges: [privilege("SEQUENCE", "invoice_numbers", owner, [usage])],
      });

    const sql = script(loose("app_owner"), empty());

    expect(sql).toContain('ALTER SEQUENCE "invoice_numbers" OWNER TO "app_owner";');
    expect(sql).toContain('GRANT USAGE, SELECT ON SEQUENCE "invoice_numbers" TO "app_rw";');
    // And on one that is already there with another owner.
    expect(script(loose("app_owner"), loose("postgres"))).toContain(
      'ALTER SEQUENCE "invoice_numbers" OWNER TO "app_owner";'
    );
  });

  it("takes the rule the other way round in a rollback", () => {
    // The rollback is the same generator with the two sides swapped, so the
    // sequence the target's column owns is skipped there too.
    const sql = script(orders("postgres"), orders("app_owner"));

    expect(sql).toContain('ALTER TABLE "orders" OWNER TO "postgres";');
    expect(sql).not.toContain('ALTER SEQUENCE "orders_id_seq" OWNER TO "postgres";');
  });
});
