/** Where a sign-in goes when nothing asked for anywhere else. */
export const DEFAULT_CALLBACK_URL = "/studio";

/**
 * Where to go once signed in: the page that sent the person to the sign-in
 * page, or the studio when nothing did.
 *
 * The proxy and the old addresses (lib/org-redirect.ts) send a signed-out
 * person to /login?callbackUrl=<the page they asked for>, and so do the
 * landing page's "Create account" and an invitation link, so that signing in
 * carries on to that page. Anybody can write a link with any callbackUrl in
 * it, though, so only a path on this site is taken. A link that went to
 * another site straight after a real Microsoft or GitHub sign-in would make a
 * convincing fake of this one.
 *
 * "//host" and "/\host" read as paths but are other sites to a browser, which
 * is why the address is read the way a browser reads it, and kept only when
 * it lands on this site. Even then the path can start "//" once its dot
 * segments are resolved ("/.//host" is "//host" on this site), and on its own
 * that is another site again, so the answer is read back once more before it
 * is used. The sign-in page and the API are refused too: neither is a page
 * anybody was heading for, and the sign-in page would only show itself again.
 *
 * `search` is the sign-in page's query string and `origin` its own origin,
 * both from window.location, passed in so this can be tested without a page.
 */
export function safeCallbackUrl(search: string, origin: string): string {
  const asked = new URLSearchParams(search).get("callbackUrl");
  if (!asked || !asked.startsWith("/")) return DEFAULT_CALLBACK_URL;

  let url: URL;
  try {
    url = new URL(asked, origin);
  } catch {
    return DEFAULT_CALLBACK_URL;
  }
  if (url.origin !== origin) return DEFAULT_CALLBACK_URL;

  const path = url.pathname;
  for (const refused of ["/login", "/api"]) {
    if (path === refused || path.startsWith(`${refused}/`)) return DEFAULT_CALLBACK_URL;
  }
  const answer = path + url.search + url.hash;
  return new URL(answer, origin).origin === origin ? answer : DEFAULT_CALLBACK_URL;
}

/**
 * The query flag that asks the sign-in page to have Microsoft or GitHub show
 * their account picker (see wantsAccountPicker).
 */
const ACCOUNT_PICKER = { name: "account", value: "choose" } as const;

/**
 * The sign-in page's address, carrying on to `callbackUrl` once signed in.
 *
 * With `chooseAccount`, the sign-in also asks Microsoft or GitHub to show
 * their account picker. Both otherwise sign straight back in to the account
 * the browser last used, so someone who signed out to use another account
 * would only be handed the same one again. The invitation page asks for it
 * when an invitation is for an address the person has not signed in with.
 */
export function loginHref(callbackUrl: string, options: { chooseAccount?: boolean } = {}): string {
  const query = new URLSearchParams({ callbackUrl });
  if (options.chooseAccount) query.set(ACCOUNT_PICKER.name, ACCOUNT_PICKER.value);
  return `/login?${query}`;
}

/** Whether the sign-in page's query string (window.location.search) asks for the account picker. */
export function wantsAccountPicker(search: string): boolean {
  return new URLSearchParams(search).get(ACCOUNT_PICKER.name) === ACCOUNT_PICKER.value;
}
