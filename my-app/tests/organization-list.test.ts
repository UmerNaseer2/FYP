/**
 * lib/organization-list.ts: the checks a screen runs on what the server
 * answered before drawing from it. GET /api/organizations answers with the
 * whole list, and taking an invitation (POST /api/invites/accept) with the one
 * organization to open.
 *
 * A proxy's error page or an older server can answer with something that only
 * looks right, and a list drawn from that would break halfway through drawing,
 * so anything short of the promised shape is turned down whole.
 */
import { isOrgListing, isOrgSummary } from "@/lib/organization-list";

const ACME = { slug: "acme", name: "Acme" };
const BETA = { slug: "beta-ops", name: "Beta Ops" };

describe("one organization", () => {
  test("is an address and a name", () => {
    expect(isOrgSummary(ACME)).toBe(true);
    // Anything more is left alone: the screens read only these two.
    expect(isOrgSummary({ ...ACME, id: 2 })).toBe(true);
  });

  test.each([
    ["no name", { slug: "acme" }],
    ["no address", { name: "Acme" }],
    ["a name that is not text", { slug: "acme", name: 7 }],
    ["an address that is not text", { slug: null, name: "Acme" }],
    ["a refusal", { error: "Sign in to continue." }],
    ["null", null],
    ["nothing at all", undefined],
    ["a bare string", "acme"],
  ])("is not %s", (_, value) => {
    expect(isOrgSummary(value)).toBe(false);
  });
});

describe("the whole list", () => {
  test("is the organizations and whether another can be made", () => {
    expect(isOrgListing({ organizations: [ACME, BETA], canCreate: true })).toBe(true);
    // Somebody in no organization yet, in the desktop app or the demo.
    expect(isOrgListing({ organizations: [], canCreate: false })).toBe(true);
  });

  test.each([
    ["one entry that is not an organization", { organizations: [ACME, { slug: "beta-ops" }], canCreate: true }],
    ["an entry that is null", { organizations: [ACME, null], canCreate: true }],
    ["one organization where the list belongs", { organizations: ACME, canCreate: true }],
    ["no list", { canCreate: true }],
    ["no word on making another", { organizations: [ACME] }],
    ["a word on making another that is not yes or no", { organizations: [ACME], canCreate: "yes" }],
    ["a refusal", { error: "Sign in to continue." }],
    ["null", null],
    ["a list on its own", [ACME, BETA]],
  ])("is not %s", (_, body) => {
    expect(isOrgListing(body)).toBe(false);
  });
});
