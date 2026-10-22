/**
 * What the Schema Studio desktop app adds to the page, and how a screen asks
 * for it.
 *
 * The desktop app (desktop/ at the root of this repository) runs this same Next
 * app inside its own window. Before any of the app's code runs, its preload
 * script puts one object on `window`, `schemaStudioDesktop`, carrying the few
 * things a web page cannot do for itself: open the system browser for a
 * Microsoft sign-in, look for databases running on this computer, follow the
 * Ubuntu light or dark setting, and open the app's own Settings window. In an
 * ordinary browser the object is simply not there, and every screen that uses
 * it carries on doing exactly what it did before.
 *
 * This file exists twice on purpose: here, and as an exact copy in
 * desktop/src/shared/bridge.ts. The two packages are built separately and
 * neither can import from the other, so the desktop app's tests fail if the
 * copies ever differ by a single byte, and its build checks that what its main
 * process sends back matches the types below. A change made to one side only
 * breaks the desktop build, rather than a sign-in on somebody's PC.
 *
 * This module is isomorphic on purpose (no "use client"): getDesktopBridge()
 * answers null on the server, where there is no window, so a caller never has
 * to ask where it is running first.
 */

/**
 * How a Microsoft sign-in in the system browser ended.
 *
 * Only `ok: true` carries a token. The three failures are kept apart because
 * the login screen says something different for each: a cancelled sign-in
 * quietly goes back to the button, while being offline and Microsoft refusing
 * each need words.
 */
export type DesktopSignInResult =
  | { ok: true; idToken: string }
  | { ok: false; reason: "cancelled" | "offline" | "failed"; message: string };

/**
 * A database the desktop app found running on this computer.
 *
 * `user` and `database` are whatever could be learned without a password: a
 * Docker container's POSTGRES_USER and POSTGRES_DB settings, or nothing at all
 * for a server that was only seen answering on a port. The password is never
 * part of this, not even when a container's settings hold one: the person
 * types it, so the app never takes a secret it was not handed.
 */
export type FoundDatabase = {
  /** Seen answering on a port, or read from a running Docker container. */
  source: "port" | "docker";
  /** A name to suggest for the connection, e.g. "Postgres on port 5433". */
  label: string;
  host: string;
  port: number;
  user: string | null;
  database: string | null;
  /** The Docker container's name, when it came from one. */
  container?: string;
};

/** "system" follows the Ubuntu setting; the other two pin the app to one. */
export type ThemeChoice = "system" | "light" | "dark";

export interface DesktopBridge {
  /**
   * Opens the system browser on Microsoft's sign-in page and waits for the
   * person to finish (or for cancelSignIn, or a ten-minute timeout).
   */
  signIn(): Promise<DesktopSignInResult>;
  /** Gives up on a sign-in that signIn() is still waiting for. */
  cancelSignIn(): void;
  /**
   * Signs out of Schema Studio on this computer: forgets the Microsoft account
   * the app was holding and ends the session, then shows the login screen.
   */
  signOut(): Promise<void>;
  /** Looks for PostgreSQL servers on this computer, on the usual ports and in Docker. */
  findLocalDatabases(): Promise<FoundDatabase[]>;
  /** Remembers the theme for the window and every later start of the app. */
  setTheme(choice: ThemeChoice): void;
  /** Opens the desktop app's Settings window, where the GitHub details live. */
  openSettings(): void;
}

declare global {
  interface Window {
    /** Present only inside the desktop app. See the top of lib/desktop-bridge.ts. */
    schemaStudioDesktop?: DesktopBridge;
  }
}

/**
 * The bridge, or null in a browser and on the server.
 *
 * For event handlers and effects. A component that changes what it RENDERS
 * because of the bridge should use hooks/useDesktopBridge instead, which keeps
 * the first render in step with the HTML the server sent.
 */
export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.schemaStudioDesktop ?? null;
}
