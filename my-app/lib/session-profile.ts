/**
 * The profile ID a sign-in session carries, or null when it carries none.
 *
 * The session says who someone is by their profile ID (auth.ts puts it there
 * when they sign in), and everything about them is looked up by it. A session
 * with no ID, or with something else in its place, is read as nobody: it was
 * signed before profile IDs went into sessions, or its sign-in never finished,
 * and either way signing in again fixes it.
 *
 * Its own file, with no imports, so the gates (lib/auth-guard.ts), the old
 * addresses (lib/org-redirect.ts) and their tests can all use it without
 * loading anything that needs a database.
 */
export function sessionProfileId(
  session: { user?: { id?: string | null } | null } | null | undefined
): number | null {
  const id = session?.user?.id;
  if (typeof id !== "string" || !/^[1-9][0-9]*$/.test(id)) return null;
  const profileId = Number(id);
  return Number.isSafeInteger(profileId) ? profileId : null;
}
