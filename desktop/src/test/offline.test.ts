/**
 * How long the app keeps someone signed in without reaching Microsoft
 * (src/core/offline.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { OFFLINE_LIMIT_MS, RECHECK_INTERVAL_MS, decideAfterRecheck, withinOfflineWindow } from "../core/offline";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 21, 9, 30);

test("trusts the last good check for 30 days, and asks again every 6 hours", () => {
  assert.equal(OFFLINE_LIMIT_MS, 30 * DAY);
  assert.equal(RECHECK_INTERVAL_MS, 6 * HOUR);
});

test("a check up to 30 days old is still trusted; one exactly 30 days old is not", () => {
  assert.equal(withinOfflineWindow(NOW - OFFLINE_LIMIT_MS + 1, NOW), true);
  assert.equal(withinOfflineWindow(NOW - OFFLINE_LIMIT_MS, NOW), false);
  assert.equal(withinOfflineWindow(NOW - 3 * DAY, NOW), true);
});

test("a check slightly in the future (a clock put back) still counts; one far in the future does not", () => {
  assert.equal(withinOfflineWindow(NOW + DAY, NOW), true);
  assert.equal(withinOfflineWindow(NOW + OFFLINE_LIMIT_MS, NOW), false);
});

test("no check at all, or a time that is not a time, is never trusted", () => {
  assert.equal(withinOfflineWindow(null, NOW), false);
  assert.equal(withinOfflineWindow(Number.NaN, NOW), false);
  assert.equal(withinOfflineWindow(Number.POSITIVE_INFINITY, NOW), false);
  assert.equal(withinOfflineWindow(NOW, Number.NaN), false);
});

test("Microsoft saying yes keeps the person signed in", () => {
  assert.deepEqual(decideAfterRecheck("ok", NOW - 40 * DAY, NOW), { action: "keep" });
  assert.deepEqual(decideAfterRecheck("ok", null, NOW), { action: "keep" });
});

test("Microsoft saying no signs the person out at once, however recent the last yes", () => {
  assert.deepEqual(decideAfterRecheck("ended", NOW - HOUR, NOW), { action: "sign-out", reason: "SessionRevoked" });
});

test("not reaching Microsoft keeps the person signed in for up to 30 days", () => {
  for (const outcome of ["offline", "unavailable"] as const) {
    assert.deepEqual(decideAfterRecheck(outcome, NOW - 29 * DAY, NOW), { action: "keep" }, outcome);
    assert.deepEqual(
      decideAfterRecheck(outcome, NOW - 31 * DAY, NOW),
      { action: "sign-out", reason: "OfflineTooLong" },
      outcome,
    );
    assert.deepEqual(decideAfterRecheck(outcome, null, NOW), { action: "sign-out", reason: "OfflineTooLong" }, outcome);
  }
});
