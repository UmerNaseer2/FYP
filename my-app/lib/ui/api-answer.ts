/**
 * Reading what an API route answered, for the screens that show a refusal in
 * the route's own words.
 *
 * Every route here refuses with `{ error: "..." }` written for the person
 * looking at the screen, so a screen shows that sentence rather than making up
 * its own. Something else can answer, though: a proxy's HTML error page, or a
 * server that went away halfway through. These read what they can and say
 * null for the rest, so each screen falls back to wording of its own.
 *
 * Isomorphic on purpose (no "use client"): there is nothing here a server
 * could not run.
 */

/** The `error` a route sent with a refusal, or null when it sent none. */
export function errorFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { error } = body as { error?: unknown };
  return typeof error === "string" && error !== "" ? error : null;
}

/** A response's JSON, or null when it has none: a proxy's HTML page, say. */
export async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
