// registry-paths, organization folders: where each organization's scripts sit
// in the GitHub registry, and the one path the default organization may not
// use because it would land inside another organization's folder.
//
// The layout: the default organization keeps the repository root, so the
// scripts saved before organizations existed stay where they are; every other
// organization gets orgs/<id>/. The id, not the slug, because a slug can be
// renamed and a folder can't follow it.
import {
  familyFolderPath,
  isOrganizationFolder,
  registryRoot,
  reservedFolderProblem,
} from "@/lib/registry-paths";

describe("registryRoot", () => {
  it("is the repository root for the default organization", () => {
    expect(registryRoot({ orgId: 7, orgIsDefault: true })).toBe("");
  });

  it("is orgs/<id> for any other organization", () => {
    expect(registryRoot({ orgId: 12, orgIsDefault: false })).toBe("orgs/12");
  });
});

describe("familyFolderPath", () => {
  it("joins the three names under the root", () => {
    expect(familyFolderPath("", "db", "public", "orders_fix")).toBe("db/public/orders_fix");
    expect(familyFolderPath("orgs/12", "db", "public", "orders_fix")).toBe("orgs/12/db/public/orders_fix");
  });
});

describe("isOrganizationFolder", () => {
  it("is true only for orgs followed by digits alone", () => {
    expect(isOrganizationFolder("orgs", "12")).toBe(true);
    expect(isOrganizationFolder("orgs", "0")).toBe(true);
    expect(isOrganizationFolder("orgs", "12a")).toBe(false);
    expect(isOrganizationFolder("orgs", "public")).toBe(false);
    expect(isOrganizationFolder("orgs", "")).toBe(false);
    // GitHub paths are case sensitive, so "Orgs" is an ordinary database.
    expect(isOrganizationFolder("Orgs", "12")).toBe(false);
    expect(isOrganizationFolder("db", "12")).toBe(false);
  });
});

describe("reservedFolderProblem", () => {
  it("refuses, for the default organization, a path inside another organization's folder", () => {
    const problem = reservedFolderProblem("", "orgs", "12");
    expect(problem).toContain("other organizations' scripts");
    expect(problem).toContain("Rename the schema");
  });

  it("allows the default organization a database named orgs with an ordinary schema", () => {
    expect(reservedFolderProblem("", "orgs", "public")).toBeNull();
    expect(reservedFolderProblem("", "orgs", "12a")).toBeNull();
    expect(reservedFolderProblem("", "Orgs", "12")).toBeNull();
  });

  it("never refuses another organization, whose names all sit inside its own folder", () => {
    expect(reservedFolderProblem("orgs/12", "orgs", "5")).toBeNull();
    expect(reservedFolderProblem("orgs/12", "orgs", "12")).toBeNull();
  });
});
