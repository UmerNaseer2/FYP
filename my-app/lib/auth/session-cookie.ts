/**
 * Telling a "you are still signed in" cookie from every other cookie.
 *
 * Auth.js keeps the session in a cookie named `authjs.session-token`
 * (`__Secure-authjs.session-token` over https, with `.0`, `.1` and so on added
 * when the value is too long for one cookie). Each time it reads a session it
 * also hands the cookie back with a later end date, so that someone who keeps
 * using the app stays signed in.
 *
 * proxy.ts uses this to drop that hand-back from its own answers. See the note
 * there for why.
 */
const SESSION_COOKIE = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?=([^;]*)/;

/**
 * True for a Set-Cookie line that gives the browser a session again. A line
 * that clears the cookie (an empty value, or a life of zero seconds) is not
 * one: signing out has to keep working.
 */
export function refreshesSession(setCookie: string): boolean {
  const match = setCookie.match(SESSION_COOKIE);
  if (!match) return false;
  if (match[1] === "") return false;
  return !/;\s*Max-Age=0\b/i.test(setCookie);
}
