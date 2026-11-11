/** @jest-environment jsdom */

/**
 * signOutEverywhere (lib/sign-out.ts): where signing out lands.
 *
 * tests/component-studio-shell.test.tsx presses Sign out on the studio's rail,
 * and checks the default (the login screen) in a browser and the hand-off to
 * the desktop app. These add a caller that asks to land somewhere else: the
 * invitation page, which brings someone who signs out to use another account
 * back to the same invitation.
 */
import { installDesktopBridge, removeDesktopBridge } from "./helpers/desktop-bridge";
import { pageLoader, signOutEverywhere } from "@/lib/sign-out";

// next-auth ships as ESM, which Jest cannot load.
const mockSignOut = jest.fn<Promise<void>, [unknown?]>(() => Promise.resolve());
jest.mock("next-auth/react", () => ({
  signOut: (options?: unknown) => mockSignOut(options),
}));

/** Where the invitation page asks to land: the sign-in page, then the same invitation. */
const BACK_TO_INVITE = "/login?callbackUrl=%2Finvite%2Fabc123&account=choose";

/** What /api/auth/session says each time it is asked, in order. The last one repeats. */
let sessionAnswers: unknown[] = [null];
const mockFetch = jest.fn(async (address: string) => {
  expect(address).toBe("/api/auth/session");
  const answer = sessionAnswers.length > 1 ? sessionAnswers.shift() : sessionAnswers[0];
  if (answer instanceof Error) throw answer;
  return { json: async () => answer };
});
const SIGNED_IN = { user: { email: "ada@example.com" }, expires: "2099-01-01" };

// A test page cannot really go anywhere, so the page load is watched instead.
let loaded: jest.SpyInstance;

beforeEach(() => {
  mockSignOut.mockClear();
  mockFetch.mockClear();
  sessionAnswers = [null];
  (globalThis as { fetch: unknown }).fetch = mockFetch;
  loaded = jest.spyOn(pageLoader, "load").mockImplementation(() => {});
});
afterEach(() => {
  removeDesktopBridge();
  loaded.mockRestore();
});

test("lands on the login screen unless told otherwise", async () => {
  await signOutEverywhere();
  // next-auth is told not to load a page itself: this loads it, once the
  // session is known to be gone.
  expect(mockSignOut.mock.calls).toEqual([[{ redirect: false }]]);
  expect(loaded.mock.calls).toEqual([["/login"]]);
});

test("lands where it is told to", async () => {
  await signOutEverywhere(BACK_TO_INVITE);
  expect(mockSignOut.mock.calls).toEqual([[{ redirect: false }]]);
  expect(loaded.mock.calls).toEqual([[BACK_TO_INVITE]]);
});

test("signs out again when a late answer brought the session back", async () => {
  // A call that was still open when Sign out was pressed came back afterwards
  // and gave the browser its cookie again. One sign-out is not enough then.
  sessionAnswers = [SIGNED_IN, null];
  let signOutsBeforeLoad = -1;
  loaded.mockImplementation(() => {
    signOutsBeforeLoad = mockSignOut.mock.calls.length;
  });

  await signOutEverywhere();

  expect(mockSignOut).toHaveBeenCalledTimes(2);
  expect(mockFetch).toHaveBeenCalledTimes(2);
  // The page loads only after the second sign-out, never in between.
  expect(signOutsBeforeLoad).toBe(2);
  expect(loaded.mock.calls).toEqual([["/login"]]);
});

test("gives up after three tries and loads the login screen anyway", async () => {
  sessionAnswers = [SIGNED_IN];
  await signOutEverywhere();
  expect(mockSignOut).toHaveBeenCalledTimes(3);
  expect(loaded.mock.calls).toEqual([["/login"]]);
});

test("reads no answer from the server as signed out", async () => {
  sessionAnswers = [new Error("offline")];
  await signOutEverywhere();
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  expect(loaded.mock.calls).toEqual([["/login"]]);
});

test("inside the desktop app, leaves it to the app wherever it was told to land", async () => {
  // The app always shows its own login screen, and has no invitation page to
  // come back to.
  const bridge = installDesktopBridge();
  await signOutEverywhere(BACK_TO_INVITE);
  expect(bridge.signOut.mock.calls).toEqual([[]]);
  expect(mockSignOut).not.toHaveBeenCalled();
  expect(loaded).not.toHaveBeenCalled();
});
