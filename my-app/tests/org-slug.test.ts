// org-slug: the rules for an organization's slug, the part of its address
// after the domain, and the check that no folder in app/ can take an
// organization's address from it.
//
// An organization's pages sit at /<slug>/... (app/[org]). Next.js serves a
// folder with a fixed name before a dynamic one, so a slug that is also a
// top-level folder in app/ would open that folder's page instead of the
// organization's, every time. RESERVED_SLUGS keeps those words from ever
// becoming a slug, and the last test here fails when a folder is added to app/
// without being listed there.
import fs from "fs";
import path from "path";
import {
  ORG_SLUG_PATTERN,
  RESERVED_SLUGS,
  isOrgSlug,
  isReservedSlug,
  orgHref,
  orgSlugFromPath,
} from "@/lib/org-slug";

const APP = path.join(__dirname, "..", "app");
const SLUG = new RegExp(ORG_SLUG_PATTERN);

describe("isOrgSlug", () => {
  test("takes lowercase letters, digits and dashes, 3 to 40 long", () => {
    expect(isOrgSlug("acme")).toBe(true);
    expect(isOrgSlug("swinburne-fyp")).toBe(true);
    expect(isOrgSlug("team-42")).toBe(true);
    expect(isOrgSlug("abc")).toBe(true);
    expect(isOrgSlug("a".repeat(40))).toBe(true);
  });

  test("turns down anything else", () => {
    expect(isOrgSlug("")).toBe(false);
    expect(isOrgSlug("ab")).toBe(false);
    expect(isOrgSlug("a".repeat(41))).toBe(false);
    expect(isOrgSlug("Acme")).toBe(false);
    expect(isOrgSlug("-acme")).toBe(false);
    expect(isOrgSlug("acme-")).toBe(false);
    expect(isOrgSlug("ac me")).toBe(false);
    expect(isOrgSlug("acme_co")).toBe(false);
    expect(isOrgSlug("acme.co")).toBe(false);
    expect(isOrgSlug("acme/x")).toBe(false);
  });

  test("turns down a reserved word even though it has the right shape", () => {
    expect(isReservedSlug("studio")).toBe(true);
    expect(isOrgSlug("studio")).toBe(false);
    expect(isOrgSlug("login")).toBe(false);
    expect(isOrgSlug("api")).toBe(false);
    expect(isReservedSlug("acme")).toBe(false);
  });

  test("the default organization's slug is free", () => {
    // lib/db/bootstrap.ts gives the organization existing data moves into
    // this slug; a reserved one would make its pages unreachable.
    expect(isOrgSlug("swinburne-fyp")).toBe(true);
  });
});

describe("orgSlugFromPath", () => {
  test("reads the organization from the first part of the path", () => {
    expect(orgSlugFromPath("/acme/compare")).toBe("acme");
    expect(orgSlugFromPath("/acme")).toBe("acme");
    expect(orgSlugFromPath("/acme/")).toBe("acme");
    expect(orgSlugFromPath("/swinburne-fyp/schemas/12")).toBe("swinburne-fyp");
  });

  test("finds none on the landing page, the app's own pages or a malformed path", () => {
    expect(orgSlugFromPath("/")).toBeNull();
    expect(orgSlugFromPath("")).toBeNull();
    expect(orgSlugFromPath("/studio")).toBeNull();
    expect(orgSlugFromPath("/login")).toBeNull();
    expect(orgSlugFromPath("/api/me")).toBeNull();
    expect(orgSlugFromPath("/Acme/compare")).toBeNull();
    expect(orgSlugFromPath("acme/compare")).toBeNull();
    expect(orgSlugFromPath("//acme")).toBeNull();
  });
});

describe("orgHref", () => {
  test("puts the organization in front of the path", () => {
    expect(orgHref("acme", "/studio")).toBe("/acme/studio");
    expect(orgHref("acme", "/drift?tab=detail&schema=4")).toBe("/acme/drift?tab=detail&schema=4");
  });

  test("leaves the path alone when there is no organization", () => {
    expect(orgHref(null, "/studio")).toBe("/studio");
    expect(orgHref(undefined, "/compare?a=1")).toBe("/compare?a=1");
    expect(orgHref("", "/studio")).toBe("/studio");
  });
});

describe("reserved words", () => {
  test("every reserved word has a slug's shape, so none is listed for nothing", () => {
    const pointless = [...RESERVED_SLUGS].filter((word) => !SLUG.test(word));
    expect(pointless).toEqual([]);
  });

  test("every folder in app/ that could pass for an organization's slug is reserved", () => {
    // Route groups "(studio)" and dynamic segments "[org]" add nothing to the
    // address, and Next.js keeps "_private" and "@slot" folders out of it, so
    // only plain folders can collide. A plain folder whose name could never be
    // a slug (too short, a capital letter) cannot collide either.
    const folders = fs
      .readdirSync(APP, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !/^[([_@]/.test(name));
    // A guard on the guard: if the walk ever found nothing, the check below
    // would pass over an empty list.
    expect(folders).toEqual(expect.arrayContaining(["api", "login"]));
    const unlisted = folders.filter((name) => SLUG.test(name) && !RESERVED_SLUGS.has(name));
    expect(unlisted).toEqual([]);
  });
});
