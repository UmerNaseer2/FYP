/**
 * What GET /api/organizations answers (app/api/organizations/route.ts), and
 * the check a screen runs on it before trusting it.
 *
 * Two screens read the list: "Your organizations"
 * (components/onboarding/OnboardingPage.tsx) and the organization picker on
 * the studio's rail (components/studio/OrgSwitcher.tsx). Both check the body
 * the same way, here, because a proxy's error page or an older server can
 * answer with something else, and a list drawn from a body that only looked
 * right would break in the middle of drawing it.
 *
 * Isomorphic on purpose (no "use client"): there is nothing here a server
 * could not run.
 */

/** One organization in the list: its address and its name, and nothing else about it. */
export type OrgSummary = { slug: string; name: string };

/**
 * The whole answer. `canCreate` says whether POST /api/organizations would let
 * this person make one: false in the desktop app and in the demo.
 */
export type OrgListing = { organizations: OrgSummary[]; canCreate: boolean };

/** Whether a body is the list GET /api/organizations promises. */
export function isOrgListing(body: unknown): body is OrgListing {
  if (typeof body !== "object" || body === null) return false;
  const { organizations, canCreate } = body as { organizations?: unknown; canCreate?: unknown };
  return (
    Array.isArray(organizations) && organizations.every(isOrgSummary) && typeof canCreate === "boolean"
  );
}

/**
 * Whether a value is one organization as the list gives it. Taking an
 * invitation (POST /api/invites/accept) answers with one too.
 */
export function isOrgSummary(value: unknown): value is OrgSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OrgSummary).slug === "string" &&
    typeof (value as OrgSummary).name === "string"
  );
}
