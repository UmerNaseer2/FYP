/**
 * How long Schema Studio keeps someone signed in while it cannot reach
 * Microsoft, and what to do after each time it asks.
 *
 * The person signs in with Microsoft once, and the app keeps them signed in on
 * this computer. At every start, and every six hours while it runs, the app
 * asks Microsoft again whether the account may still come in (a "re-check").
 * Four things can come back:
 *
 *  - "ok": Microsoft still vouches for the account, and the 30-day clock below
 *    starts again.
 *  - "ended": Microsoft said no. The account was disabled, its password was
 *    changed, or an administrator ended its sessions. The person is signed out
 *    at once, whatever the clock says.
 *  - "offline": Microsoft could not be reached at all.
 *  - "unavailable": Microsoft answered, but not with a yes or a no (an outage,
 *    a busy server).
 *
 * Not being able to ask is not a reason to lock somebody out of an app on
 * their own computer, so "offline" and "unavailable" keep them signed in for
 * up to 30 days after Microsoft last said yes. Past that, they sign in again.
 *
 * Pure, and tested in src/test/offline.test.ts.
 */

/** How long the last good re-check is trusted: 30 days. */
export const OFFLINE_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

/** How often a running app asks again: every 6 hours. */
export const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type RecheckOutcome = "ok" | "ended" | "offline" | "unavailable";

/**
 * What to do after a re-check. The two reasons are the `error` values the
 * login screen already knows how to explain (see my-app/app/login/page.tsx).
 */
export type RecheckDecision =
  | { action: "keep" }
  | { action: "sign-out"; reason: "SessionRevoked" | "OfflineTooLong" };

/**
 * True while the last good re-check is recent enough to keep trusting.
 *
 * The clock is this computer's own, so it can be wrong either way. One that
 * went back a little (a time zone fixed, a clock corrected by the network)
 * leaves the last check looking slightly in the future, which still counts as
 * recent. A last check more than 30 days in the future can only come from a
 * clock that was set far ahead, so it counts as too old rather than as a free
 * extra month.
 */
export function withinOfflineWindow(lastOnlineCheck: number | null, now: number): boolean {
  if (lastOnlineCheck === null || !Number.isFinite(lastOnlineCheck) || !Number.isFinite(now)) {
    return false;
  }
  return Math.abs(now - lastOnlineCheck) < OFFLINE_LIMIT_MS;
}

export function decideAfterRecheck(
  outcome: RecheckOutcome,
  lastOnlineCheck: number | null,
  now: number,
): RecheckDecision {
  switch (outcome) {
    case "ok":
      return { action: "keep" };
    case "ended":
      return { action: "sign-out", reason: "SessionRevoked" };
    case "offline":
    case "unavailable":
      return withinOfflineWindow(lastOnlineCheck, now)
        ? { action: "keep" }
        : { action: "sign-out", reason: "OfflineTooLong" };
  }
}
