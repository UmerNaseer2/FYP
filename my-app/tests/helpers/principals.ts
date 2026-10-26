// Whole principals for route tests that replace lib/auth-guard.
//
// A route suite mocks the gate so it can test the route without a session or
// a metadata database. The real gate never answers ok:true without a whole
// principal, so a mock that hands back `null` or half of one tests a route
// that can never run: the route reads `roleLabel` for a refusal, `permissions`
// for a second check, or `bypass` for a message, and gets undefined.
//
// principalFor("editor") is what the real gate would hand a route for an
// editor of TEST_ORG on a new install: the built-in role, its name as people
// read it, and exactly the permissions it starts with. Pass `over` for anything
// a test needs to differ, such as a particular email.
//
// Inside a jest.mock() factory, load this file with require() rather than an
// import (eslint.config.mjs says why). The import of lib/auth-guard below is
// type-only, so this file never loads the gate itself, or next-auth with it.
//
// This file is not a test itself: Jest only runs tests/**/*.test.ts.
import type { Principal } from "@/lib/auth-guard";
import { BYPASS_PRINCIPAL } from "@/lib/auth-mode";
import { BUILT_IN_ROLE_INFO, presetFor, type BuiltInRole } from "@/lib/permissions";

/**
 * The organization every principal here acts in. Its id is not 1 on purpose:
 * the default organization of a real install usually is, so a route that wrote
 * a literal 1, rather than passing the principal's orgId on, could pass a test
 * that expected 1 by luck.
 */
export const TEST_ORG = {
  id: 7,
  slug: "swinburne-fyp",
  name: "Swinburne FYP",
  isDefault: true,
  twoPersonRule: true,
} as const;

/**
 * The profile ID of each role's principal. A different one for each, so a
 * test with two principals can tell them apart, and none of them 1, for the
 * same reason as TEST_ORG's id.
 */
const PROFILE_IDS: Record<BuiltInRole, number> = { viewer: 21, editor: 22, admin: 23 };

export function principalFor(role: BuiltInRole, over: Partial<Principal> = {}): Principal {
  return {
    profileId: PROFILE_IDS[role],
    email: `${role}@test`,
    name: `A ${role}`,
    role,
    roleLabel: BUILT_IN_ROLE_INFO[role].label,
    permissions: presetFor(role) ?? [],
    bypass: false,
    viewingAs: null,
    orgId: TEST_ORG.id,
    orgSlug: TEST_ORG.slug,
    orgName: TEST_ORG.name,
    orgIsDefault: TEST_ORG.isDefault,
    orgTwoPersonRule: TEST_ORG.twoPersonRule,
    ...over,
  };
}

/**
 * The one principal the auth bypass has while "View as" is not set: a full
 * admin, under the bypass's own email and name.
 */
export function bypassAdminPrincipal(): Principal {
  return principalFor("admin", {
    profileId: null,
    email: BYPASS_PRINCIPAL.email,
    name: BYPASS_PRINCIPAL.name,
    bypass: true,
  });
}
