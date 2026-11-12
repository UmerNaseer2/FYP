// The logo reveal: the Schema Studio mark builds itself in the middle of the
// screen, then flies into its place at the top of the sidebar.
//
// It plays once per browser tab: the first time the studio opens after you
// sign in, or when the desktop app starts. "Replay intro" in the account menu
// plays it again on purpose.
//
// This file is not a client component on purpose. app/layout.tsx (a server
// file) needs INTRO_HEAD_SCRIPT, and a constant exported from a "use client"
// file arrives on the server as a reference, not as the text.

/** The sessionStorage key that says the intro has already played in this tab. */
export const INTRO_SEEN_KEY = "schema-studio:intro-seen";

/** The window event "Replay intro" sends. components/studio/LogoIntro listens for it. */
export const REPLAY_INTRO_EVENT = "schema-studio:replay-intro";

/**
 * Runs in the page's <head>, before anything is drawn.
 *
 * When the intro has not played in this tab yet, it marks the page
 * `data-intro="pending"`. The stylesheet keeps the studio hidden while that is
 * set, so you never see the app flash up and then vanish behind the intro.
 * If the intro never starts (a script error), the stylesheet shows the studio
 * anyway after a few seconds.
 */
export const INTRO_HEAD_SCRIPT = `try {
  if (!sessionStorage.getItem("${INTRO_SEEN_KEY}")) {
    document.documentElement.setAttribute("data-intro", "pending");
  }
} catch (e) {}`;

/**
 * Asks whether the intro should play now, and if so marks it as played.
 * Only true when the head script marked the page as waiting for it, so a
 * page that never ran that script (a test, say) never plays it by surprise.
 */
export function takeIntroTurn(): boolean {
  if (typeof document === "undefined") return false;
  const waiting = document.documentElement.getAttribute("data-intro") === "pending";
  if (waiting) {
    try {
      sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    } catch {
      // Storage blocked: the intro still plays, it just may play again.
    }
  }
  return waiting;
}

/** Forgets that the intro played, so it plays after the next sign in. */
export function resetIntro(): void {
  try {
    sessionStorage.removeItem(INTRO_SEEN_KEY);
  } catch {
    // Storage blocked: nothing to forget.
  }
}

/** Plays the intro again, from the account menu or the command bar. */
export function replayIntro(): void {
  window.dispatchEvent(new Event(REPLAY_INTRO_EVENT));
}
