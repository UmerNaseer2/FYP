import type { DesktopBridge } from "@/lib/desktop-bridge";

/**
 * A stand-in for what the desktop app's preload script puts on `window`.
 *
 * Inside the desktop app (desktop/ at the root of this repository) every screen
 * finds `window.schemaStudioDesktop`, and the few that change because of it
 * read it through lib/desktop-bridge.ts. A suite checking one of those installs
 * this fake, drives it, and removes it again.
 *
 * Every method is a jest.fn, so a case can both answer a call and check that it
 * was made. The defaults are the quiet ones: a sign-in that is still waiting
 * for the browser, a search that found nothing, and the rest doing nothing at
 * all, so a case only spells out the call it is about.
 *
 * Remove it after every case that installs it. A bridge left behind turns every
 * later case in the file into a desktop case, and they would then be checking
 * the desktop wording while their names said the browser's.
 */
export type FakeDesktopBridge = { [K in keyof DesktopBridge]: jest.Mock };

export function installDesktopBridge(): FakeDesktopBridge {
  const bridge: FakeDesktopBridge = {
    signIn: jest.fn(() => new Promise(() => {})),
    cancelSignIn: jest.fn(),
    signOut: jest.fn(() => Promise.resolve()),
    findLocalDatabases: jest.fn(() => Promise.resolve([])),
    setTheme: jest.fn(),
    openSettings: jest.fn(),
  };
  window.schemaStudioDesktop = bridge;
  return bridge;
}

export function removeDesktopBridge() {
  delete window.schemaStudioDesktop;
}
