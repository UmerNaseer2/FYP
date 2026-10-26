/**
 * safeCallbackUrl: where the sign-in page sends someone once they are signed
 * in. A path on this site is kept, query and all; anything that would leave
 * the site, or come back to the sign-in page, becomes the studio.
 *
 * Anybody can put any callbackUrl in a link to the sign-in page, so each way
 * of naming another site that still starts with "/" is pinned down here. The
 * other site's page is never "/studio", so an answer that kept its path would
 * fail too, not only one that kept the whole address.
 *
 * loginHref and wantsAccountPicker, at the end: the sign-in page's address as
 * the app writes it, and the flag in it that has Microsoft or GitHub show
 * their account picker. tests/page-login.test.tsx checks the page passes that
 * request on.
 */

import {
  DEFAULT_CALLBACK_URL,
  loginHref,
  safeCallbackUrl,
  wantsAccountPicker,
} from "@/lib/callback-url";

const ORIGIN = "https://studio.example";

/** The answer for a sign-in page reached with this callbackUrl. */
function after(asked: string): string {
  return safeCallbackUrl(`?callbackUrl=${encodeURIComponent(asked)}`, ORIGIN);
}

test("goes to the studio when nothing asked for anywhere else", () => {
  expect(DEFAULT_CALLBACK_URL).toBe("/studio");
  expect(safeCallbackUrl("", ORIGIN)).toBe("/studio");
  expect(safeCallbackUrl("?error=AccessDenied", ORIGIN)).toBe("/studio");
  expect(safeCallbackUrl("?callbackUrl=", ORIGIN)).toBe("/studio");
});

test("keeps a path on this site, with its query and fragment", () => {
  expect(after("/acme/studio")).toBe("/acme/studio");
  expect(after("/invite/abc123")).toBe("/invite/abc123");
  expect(after("/onboarding")).toBe("/onboarding");
  expect(after("/acme/connections?tab=prod#top")).toBe("/acme/connections?tab=prod#top");
});

test("reads the address the way a browser would", () => {
  // Dot segments are resolved, so what is checked is where the browser ends up.
  expect(after("/acme/../invite/abc123")).toBe("/invite/abc123");
  expect(after("/acme/../login")).toBe("/studio");
});

test.each([
  ["a full address on another site", "https://evil.example/phish"],
  ["a full address on this site, which nothing here ever sends", `${ORIGIN}/acme/studio`],
  ["another site written as a path", "//evil.example/phish"],
  ["another site behind a backslash", "/\\evil.example/phish"],
  ["another site behind two backslashes", "\\\\evil.example/phish"],
  ["another site with a tab hidden in it", "/\t/evil.example/phish"],
  ["another site behind a dot segment", "/.//evil.example/phish"],
  ["another site behind an encoded dot segment", "/%2e//evil.example/phish"],
  ["another site behind a parent segment", "/acme/..//evil.example/phish"],
  ["a script", "javascript:alert(1)"],
  ["a relative path", "acme/studio"],
])("goes to the studio instead of %s", (_, asked) => {
  expect(after(asked)).toBe("/studio");
});

test.each([
  ["/login"],
  ["/login?error=AccessDenied"],
  ["/login/"],
  ["/api/auth/signout"],
  ["/api"],
])("goes to the studio instead of %s, which nobody was heading for", (asked) => {
  expect(after(asked)).toBe("/studio");
});

test("keeps pages whose names only start like the refused ones", () => {
  expect(after("/loginhelp")).toBe("/loginhelp");
  expect(after("/apiary/studio")).toBe("/apiary/studio");
});

describe("the sign-in page's address", () => {
  /** The query string of a link loginHref wrote, as the sign-in page will find it. */
  function searchOf(href: string): string {
    return new URL(href, ORIGIN).search;
  }

  test("carries on to the page asked for", () => {
    expect(loginHref("/invite/abc123")).toBe("/login?callbackUrl=%2Finvite%2Fabc123");
    expect(loginHref("/invite/abc123", { chooseAccount: false })).toBe(
      "/login?callbackUrl=%2Finvite%2Fabc123",
    );
  });

  test("keeps the page's own query and fragment inside callbackUrl", () => {
    // Written unencoded, "&tab=prod" would be the sign-in page's own setting
    // and "#top" its own fragment, and the person would land on the bare page.
    const asked = "/acme/connections?tab=prod&env=staging#top";
    expect(safeCallbackUrl(searchOf(loginHref(asked)), ORIGIN)).toBe(asked);
    expect(safeCallbackUrl(searchOf(loginHref(asked, { chooseAccount: true })), ORIGIN)).toBe(asked);
  });

  test("asks for the account picker only when told to", () => {
    const choosing = loginHref("/invite/abc123", { chooseAccount: true });
    expect(choosing).toBe("/login?callbackUrl=%2Finvite%2Fabc123&account=choose");
    expect(wantsAccountPicker(searchOf(choosing))).toBe(true);
    expect(wantsAccountPicker(searchOf(loginHref("/invite/abc123")))).toBe(false);
  });

  test.each([
    ["the flag on its own", "?account=choose", true],
    ["the flag beside a callbackUrl", "?callbackUrl=%2Finvite%2Fabc123&account=choose", true],
    ["no query at all", "", false],
    ["only a callbackUrl", "?callbackUrl=%2Finvite%2Fabc123", false],
    ["another value", "?account=other", false],
    ["an empty value", "?account=", false],
    ["the name with no value", "?account", false],
    // The page being carried on to may have a query of its own. What is in
    // there is that page's business, not a request to the sign-in page.
    ["the flag inside the callbackUrl", `?callbackUrl=${encodeURIComponent("/x?account=choose")}`, false],
  ])("wantsAccountPicker reads %s as %s", (_, search, wanted) => {
    expect(wantsAccountPicker(search)).toBe(wanted);
  });
});
