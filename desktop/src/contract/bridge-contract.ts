/**
 * Proves, while the app is built, that the two descriptions of the bridge
 * between the app and the web app agree.
 *
 * The web app's side is src/shared/bridge.ts, a copy of
 * my-app/lib/desktop-bridge.ts (src/test/bridge-copy.test.ts keeps the two
 * copies identical). The main process cannot use that file: it describes the
 * browser window (`Window`), which the main process's settings leave out on
 * purpose, so src/shared/ipc.ts repeats the shapes the two sides pass to each
 * other. Each line below compiles only when both shapes are exactly the same,
 * so they cannot drift apart without the build failing.
 *
 * Checked by tsconfig.contract.json, which emits nothing.
 */
import type * as Bridge from "../shared/bridge";
import type * as Ipc from "../shared/ipc";

/** `true` only when A and B are the same type, not merely compatible ones. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

export const signInResult: Same<Bridge.DesktopSignInResult, Ipc.SignInResult> = true;
export const foundDatabase: Same<Bridge.FoundDatabase, Ipc.FoundDatabase> = true;
export const themeChoice: Same<Bridge.ThemeChoice, Ipc.ThemeChoice> = true;

// Every method the web app can call has a message channel in the main process.
export const bridgeChannels: Same<keyof Bridge.DesktopBridge, keyof typeof Ipc.BRIDGE> = true;
