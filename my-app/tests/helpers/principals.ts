// Whole principals for route tests that replace lib/auth-guard.
//
// A route suite mocks the gate so it can test the route without a session or
// a metadata database. The real gate never answers ok:true without a whole
// principal, so a mock that hands back `null` or half of one tests a route
// that can never run: the route reads `roleLabel` for a refusal, `permissions`
// for a second check, or `bypass` for a message, and gets undefined.
//
// principalFor("editor") is what the real gate would hand a route for a
// signed-in editor on a new install: the built-in role, its name as people read
// it, and exactly the permissions it starts with. Pass `over` for anything a
// test needs to differ, such as a particular email.
//
// Inside a jest.mock() factory, load this file with require() rather than an
// import (eslint.config.mjs says why). The import of lib/auth-guard below is
// type-only, so this file never loads the gate itself, or next-auth with it.
//
// This file is not a test itself: Jest only runs tests/**/*.test.ts.
import type { Principal } from "@/lib/auth-guard";
import { BYPASS_PRINCIPAL } from "@/lib/auth-mode";
import { BUILT_IN_ROLE_INFO, presetFor, type BuiltInRole } from "@/lib/permissions";

export function principalFor(role: BuiltInRole, over: Partial<Principal> = {}): Principal {
  return {
    email: `${role}@test`,
    name: `A ${role}`,
    role,
    roleLabel: BUILT_IN_ROLE_INFO[role].label,
    permissions: presetFor(role) ?? [],
    bypass: false,
    viewingAs: null,
    ...over,
  };
}

/**
 * The one principal the auth bypass has while "View as" is not set: a full
 * admin, under the bypass's own email and name.
 */
export function bypassAdminPrincipal(): Principal {
  return principalFor("admin", {
    email: BYPASS_PRINCIPAL.email,
    name: BYPASS_PRINCIPAL.name,
    bypass: true,
  });
}
