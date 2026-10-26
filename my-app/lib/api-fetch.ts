import { ORG_HEADER, orgSlugFromPath } from "./org-slug";

/**
 * fetch() for the screens' own API calls: the same call, plus a header naming
 * the organization the page is open in.
 *
 * The API routes stay at /api/... for every organization, so the address of
 * an API call cannot say which one it acts in. The page's address can:
 * /acme/compare is the Compare page of "acme". This reads the slug from it at
 * the moment of the call and sends it as ORG_HEADER, and the gate in
 * lib/auth-guard.ts checks the caller's membership there before the route
 * does anything.
 *
 * It reads window.location rather than taking the slug from a hook, so a call
 * made from a click handler, an effect or a plain helper all send the right
 * one without the slug being handed down through every component. Next.js
 * moves the address before the new page's effects run, so a call made by a
 * page that has just opened already sees its own organization in it.
 *
 * Every screen calls this instead of fetch() for /api/..., and
 * tests/api-fetch.test.ts fails on a screen that does not. On an address that
 * names no organization (the landing page, a page test) it sends no header,
 * which the gate answers for the desktop and nobody else (see
 * lib/auth-guard.ts).
 */
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const slug = typeof window === "undefined" ? null : orgSlugFromPath(window.location.pathname);
  if (!slug) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set(ORG_HEADER, slug);
  return fetch(input, { ...init, headers });
}
