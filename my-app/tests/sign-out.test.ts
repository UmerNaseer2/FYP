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
import { signOutEverywhere } from "@/lib/sign-out";

// next-auth ships as ESM, which Jest cannot load.
const mockSignOut = jest.fn<Promise<void>, [unknown?]>(() => Promise.resolve());
jest.mock("next-auth/react", () => ({
  signOut: (options?: unknown) => mockSignOut(options),
}));

/** Where the invitation page asks to land: the sign-in page, then the same invitation. */
const BACK_TO_INVITE = "/login?callbackUrl=%2Finvite%2Fabc123&account=choose";

beforeEach(() => mockSignOut.mockClear());
afterEach(() => removeDesktopBridge());

test("lands on the login screen unless told otherwise", async () => {
  await signOutEverywhere();
  expect(mockSignOut.mock.calls).toEqual([[{ callbackUrl: "/login" }]]);
});

test("lands where it is told to", async () => {
  await signOutEverywhere(BACK_TO_INVITE);
  expect(mockSignOut.mock.calls).toEqual([[{ callbackUrl: BACK_TO_INVITE }]]);
});

test("inside the desktop app, leaves it to the app wherever it was told to land", async () => {
  // The app always shows its own login screen, and has no invitation page to
  // come back to.
  const bridge = installDesktopBridge();
  await signOutEverywhere(BACK_TO_INVITE);
  expect(bridge.signOut.mock.calls).toEqual([[]]);
  expect(mockSignOut).not.toHaveBeenCalled();
});
