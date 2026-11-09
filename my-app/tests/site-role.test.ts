// The website role a linked desktop works within (lib/site-role.ts,
// docs/two-way-sync-plan.md step 3): what the desktop accepts from the website,
// how it holds a principal to it, and how it is kept.
//
// The metadata database is a stand-in. Nothing is dialled.
const mockPoolQuery = jest.fn<Promise<unknown>, [string, unknown[]?]>();
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (text: string, values?: unknown[]) => mockPoolQuery(text, values) },
  syncMetadataTables: async () => undefined,
}));

import { ADMIN_ROLE } from "@/lib/permissions";
import {
  applySiteRole,
  loadSiteRole,
  LONGEST_SITE_ROLE_KEY,
  LONGEST_SITE_ROLE_LABEL,
  MOST_SITE_ROLE_PERMISSIONS,
  readSiteRole,
  saveSiteRole,
  siteRoleOf,
} from "@/lib/site-role";
import { principalFor, TEST_ORG } from "./helpers/principals";

const EDITOR = principalFor("editor");
const VIEWER = principalFor("viewer");

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [] });
});

describe("readSiteRole", () => {
  it("reads a role, trims it, drops keys this version does not know and repeats", () => {
    expect(
      readSiteRole({ role: " qa-lead ", label: " QA Lead ", permissions: ["dashboard:read", "moon:land", "dashboard:read"], extra: 1 })
    ).toEqual({ role: "qa-lead", label: "QA Lead", permissions: ["dashboard:read"] });
  });

  it("uses the role's key when the label is blank", () => {
    expect(readSiteRole({ role: "viewer", label: " ", permissions: [] })?.label).toBe("viewer");
  });

  it.each([
    ["not an object", "viewer"],
    ["a list", []],
    ["null", null],
    ["a blank role", { role: " ", label: "x", permissions: [] }],
    ["a role too long", { role: "r".repeat(LONGEST_SITE_ROLE_KEY + 1), label: "x", permissions: [] }],
    ["no label", { role: "viewer", permissions: [] }],
    ["a label too long", { role: "viewer", label: "l".repeat(LONGEST_SITE_ROLE_LABEL + 1), permissions: [] }],
    ["permissions not a list", { role: "viewer", label: "Viewer", permissions: "all" }],
    ["too many permissions", { role: "viewer", label: "Viewer", permissions: new Array(MOST_SITE_ROLE_PERMISSIONS + 1).fill("dashboard:read") }],
    ["a permission not a string", { role: "viewer", label: "Viewer", permissions: [7] }],
    ["a permission too long", { role: "viewer", label: "Viewer", permissions: ["p".repeat(LONGEST_SITE_ROLE_KEY + 1)] }],
  ])("turns away %s", (_name, value) => {
    expect(readSiteRole(value)).toBeNull();
  });

  it("reads back what siteRoleOf sends", () => {
    expect(readSiteRole(siteRoleOf(EDITOR))).toEqual(siteRoleOf(EDITOR));
  });
});

describe("applySiteRole", () => {
  it("keeps only the permissions both roles have, and names the website role", () => {
    const capped = applySiteRole(EDITOR, siteRoleOf(VIEWER));
    expect(capped.permissions).toEqual(EDITOR.permissions.filter((key) => VIEWER.permissions.includes(key)));
    expect(capped.role).toBe("viewer");
    expect(capped.roleLabel).toBe("Viewer on the website");
    expect(capped.orgId).toBe(EDITOR.orgId);
    expect(capped.email).toBe(EDITOR.email);
  });

  it("never adds a permission", () => {
    expect(applySiteRole(VIEWER, siteRoleOf(EDITOR))).toBe(VIEWER);
  });

  it("leaves the principal as it is when nothing is taken away, there is no role, or the website role is Admin", () => {
    expect(applySiteRole(EDITOR, siteRoleOf(EDITOR))).toBe(EDITOR);
    expect(applySiteRole(EDITOR, null)).toBe(EDITOR);
    expect(applySiteRole(EDITOR, { role: ADMIN_ROLE, label: "Admin", permissions: [] })).toBe(EDITOR);
  });

  it("never leaves the desktop's Admin key on a principal it held back", () => {
    const admin = principalFor("admin");
    const capped = applySiteRole(admin, siteRoleOf(VIEWER));
    expect(capped.role).not.toBe(ADMIN_ROLE);
    expect(capped.permissions.length).toBeLessThan(admin.permissions.length);
  });
});

describe("keeping the role", () => {
  it("reads nothing kept as no role", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ site_role: null }] });
    expect(await loadSiteRole(TEST_ORG.id)).toBeNull();
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await loadSiteRole(TEST_ORG.id)).toBeNull();
    expect(mockPoolQuery.mock.calls[0]).toEqual([`SELECT site_role FROM organizations WHERE id = $1`, [TEST_ORG.id]]);
  });

  it("reads a kept role back", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ site_role: siteRoleOf(VIEWER) }] });
    expect(await loadSiteRole(TEST_ORG.id)).toEqual(siteRoleOf(VIEWER));
  });

  it("throws on a kept role it cannot read, rather than give the full role", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ site_role: { role: "" } }] });
    await expect(loadSiteRole(TEST_ORG.id)).rejects.toThrow(/could not be read/);
  });

  it("keeps a role as JSON, and clears it with null", async () => {
    await saveSiteRole(TEST_ORG.id, siteRoleOf(VIEWER));
    await saveSiteRole(TEST_ORG.id, null);
    const [[text, kept], [, cleared]] = mockPoolQuery.mock.calls;
    expect(text).toMatch(/UPDATE organizations SET site_role = \$2::jsonb WHERE id = \$1/);
    expect(JSON.parse((kept as unknown[])[1] as string)).toEqual(siteRoleOf(VIEWER));
    expect(cleared).toEqual([TEST_ORG.id, null]);
  });
});
