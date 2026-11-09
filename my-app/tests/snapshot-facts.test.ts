import { identifierParts, sequenceOwnerTable } from "@/lib/snapshot-facts";

describe("identifierParts", () => {
  it("splits a dotted name and reads quoted parts exactly", () => {
    expect(identifierParts("shop.orders")).toEqual(["shop", "orders"]);
    expect(identifierParts('"Order Lines"')).toEqual(["Order Lines"]);
    expect(identifierParts('"a""b".c')).toEqual(['a"b', "c"]);
  });

  it("gives null for anything that is not a plain name", () => {
    expect(identifierParts("name DESC")).toBeNull();
    expect(identifierParts("lower(email)")).toBeNull();
    expect(identifierParts('"never closed')).toBeNull();
  });
});

describe("sequenceOwnerTable", () => {
  it("reads a plain owner and a quoted one as the bare table name", () => {
    expect(sequenceOwnerTable({ ownedByTable: "orders" })).toBe("orders");
    expect(sequenceOwnerTable({ ownedByTable: '"AuditLog"' })).toBe("AuditLog");
    expect(sequenceOwnerTable({ ownedByTable: '"order"' })).toBe("order");
  });

  it("takes off the snapshot's own schema, and only that one", () => {
    expect(sequenceOwnerTable({ ownedByTable: 'public."AuditLog"' }, "public")).toBe("AuditLog");
    expect(sequenceOwnerTable({ ownedByTable: "other.orders" }, "public")).toBeNull();
    expect(sequenceOwnerTable({ ownedByTable: "public.orders" })).toBeNull();
  });

  it("gives null for a sequence nothing owns", () => {
    expect(sequenceOwnerTable({ ownedByTable: null })).toBeNull();
  });
});
