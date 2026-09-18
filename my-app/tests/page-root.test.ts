/**
 * The root path, which exists only to forward to the dashboard.
 *
 * Small, but it has been wrong once in a way nothing else would catch. An
 * earlier version tried to finish the Azure sign-in here by calling signIn()
 * from "next-auth/react" when the browser came back to "/?code=…" — a helper
 * that reaches for `window`, awaited in a Server Component, so every return
 * from Microsoft became a 500 on the app's front door. NextAuth already
 * completes that exchange at its own callback route, so the only correct thing
 * for this file to do is forward, unconditionally.
 *
 * Node, not jsdom: the point of the test is that this runs where there is no
 * window, which is where it broke.
 */

const redirects: string[] = [];
jest.mock("next/navigation", () => ({
  redirect: (href: string) => {
    redirects.push(href);
  },
}));

import RootPage from "@/app/page";

describe("the root path", () => {
  it("forwards to the dashboard and does nothing else", () => {
    // One assertion, and it is the whole contract: forwarding is all that
    // should happen. Calling this in a Node environment is what proves it —
    // the version that reached for `window` here would throw before the
    // redirect ever ran.
    RootPage();
    expect(redirects).toEqual(["/studio"]);
  });
});
