/**
 * The words of the phone's live status screen (src/phone/live.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { dayText } from "../phone/format.js";
import {
  activityProblemText,
  agoText,
  driftCheckedText,
  driftProblemText,
  driftTag,
  durationText,
  healthSinceText,
  longRunningText,
  moreSessionsText,
  offlineText,
  queryTextHint,
  sessionTimeText,
  timeText,
  transactionText,
} from "../phone/live.js";
import type { LiveActivity, LiveDrift, LiveSession } from "../shared/remote/rpc.js";

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function session(changes: Partial<LiveSession> = {}): LiveSession {
  return { pid: 42, kind: "running", querySeconds: 12, xactSeconds: 12, applicationName: "psql", waitingOn: null, query: null, ...changes };
}

function activity(changes: Partial<LiveActivity> = {}): LiveActivity {
  return {
    takenAt: new Date(NOW).toISOString(),
    longRunningSeconds: 60,
    total: 1,
    blocked: 0,
    idleInTransaction: 0,
    longRunning: 0,
    sessions: [session()],
    queryText: true,
    someHidden: false,
    ...changes,
  };
}

function drift(changes: Partial<LiveDrift> = {}): LiveDrift {
  return { id: 1, schema: "public", status: "in_sync", checkedAt: new Date(NOW - 5 * MINUTE).toISOString(), headVersion: "1.0.0", ...changes };
}

test("writes a length of time in the two biggest units it needs, rounded, and says when it is under a second", () => {
  const cases: [number, string][] = [
    [-5, "under 1 s"],
    [0, "under 1 s"],
    [0.4, "under 1 s"],
    [0.9, "under 1 s"],
    [1, "1 s"],
    [12.4, "12 s"],
    [59, "59 s"],
    [60, "1 min"],
    [185, "3 min"],
    [3_599, "59 min"],
    [3_600, "1 h"],
    [7_200, "2 h"],
    [7_500, "2 h 5 min"],
    [86_400, "1 d"],
    [97_200, "1 d 3 h"],
    [172_800, "2 d"],
  ];
  for (const [seconds, text] of cases) assert.equal(durationText(seconds), text, `${seconds} seconds`);
});

test("says how long a session has run, or how long it has sat idle", () => {
  assert.equal(sessionTimeText(session({ querySeconds: 12 })), "For 12 s");
  assert.equal(sessionTimeText(session({ querySeconds: 0.4 })), "For under 1 s");
  assert.equal(sessionTimeText(session({ kind: "blocked", querySeconds: 185 })), "For 3 min");
  assert.equal(sessionTimeText(session({ kind: "idle-in-transaction", querySeconds: 185 })), "Idle for 3 min");
  assert.equal(sessionTimeText(session({ querySeconds: null })), null);
});

test("mentions an open transaction only when it has been open for longer than the statement has run", () => {
  assert.equal(transactionText(session({ querySeconds: 12, xactSeconds: 312 })), "Transaction open for 5 min");
  assert.equal(transactionText(session({ querySeconds: 12, xactSeconds: 12 })), null);
  assert.equal(transactionText(session({ querySeconds: 12, xactSeconds: 12.9 })), null);
  assert.equal(transactionText(session({ querySeconds: null, xactSeconds: 300 })), null);
  assert.equal(transactionText(session({ querySeconds: 12, xactSeconds: null })), null);
});

test("says what long-running means, by the rule saved for this schema", () => {
  assert.equal(longRunningText(activity({ longRunningSeconds: 60 })), "Long-running means over 1 min.");
  assert.equal(longRunningText(activity({ longRunningSeconds: 30 })), "Long-running means over 30 s.");
});

test("says how many sessions were left out, in the right number", () => {
  assert.equal(moreSessionsText(activity({ total: 1 })), null);
  assert.match(moreSessionsText(activity({ total: 2 })) ?? "", /^And 1 more session /);
  assert.match(moreSessionsText(activity({ total: 4 })) ?? "", /^And 3 more sessions /);
});

test("explains hidden SQL only when there is a session to hide it from", () => {
  assert.equal(queryTextHint(activity({ sessions: [], total: 0, queryText: false })), null);
  assert.equal(queryTextHint(activity({ queryText: true, someHidden: false })), null);
  assert.match(queryTextHint(activity({ queryText: false })) ?? "", /turn on Show phones the SQL it is running for this connection in Settings/);
  assert.match(queryTextHint(activity({ queryText: true, someHidden: true })) ?? "", /pg_read_all_stats/);
});

test("makes clear that health is counted since the last reset, not just this moment", () => {
  assert.match(healthSinceText({ since: null, metrics: [] }), /^Totals since PostgreSQL last reset its counters, not just this moment\.$/);
  assert.match(healthSinceText({ since: "not a time", metrics: [] }), /^Totals since PostgreSQL last reset/);
  const since = "2026-10-15T12:00:00.000Z";
  assert.equal(healthSinceText({ since, metrics: [] }), `Totals since ${dayText(Date.parse(since))}, when PostgreSQL last reset its counters, not just this moment.`);
});

test("names a schema's drift, and says so when it has never been checked", () => {
  assert.deepEqual(driftTag(drift({ status: "in_sync" })), { label: "In sync", tone: "good" });
  assert.deepEqual(driftTag(drift({ status: "drifted" })), { label: "Drifted", tone: "bad" });
  assert.deepEqual(driftTag(drift({ status: "unreachable" })), { label: "Could not reach", tone: "warn" });
  assert.deepEqual(driftTag(drift({ status: null })), { label: "Not checked yet", tone: "plain" });
});

test("says how long ago in words a person would use", () => {
  assert.equal(agoText(NOW, NOW), "just now");
  assert.equal(agoText(NOW - 59_000, NOW), "just now");
  // A clock on the phone that runs behind is still "just now", not a time to come.
  assert.equal(agoText(NOW + 5 * MINUTE, NOW), "just now");
  assert.equal(agoText(NOW - MINUTE, NOW), "1 minute ago");
  assert.equal(agoText(NOW - 5 * MINUTE, NOW), "5 minutes ago");
  assert.equal(agoText(NOW - HOUR, NOW), "1 hour ago");
  assert.equal(agoText(NOW - 2 * HOUR, NOW), "2 hours ago");
  assert.equal(agoText(NOW - 30 * HOUR, NOW), `on ${dayText(NOW - 30 * HOUR)}`);
});

test("says when drift was checked, and nothing when that time can't be read", () => {
  assert.equal(driftCheckedText(drift(), NOW), "Checked 5 minutes ago");
  assert.equal(driftCheckedText(drift({ checkedAt: null }), NOW), null);
  assert.equal(driftCheckedText(drift({ checkedAt: "not a time" }), NOW), null);
});

test("writes a time of day with its seconds, since the screen moves every few seconds", () => {
  assert.match(timeText(NOW), /^\d{2}:\d{2}:\d{2}$/);
});

test("tells the person what to do about each problem, and repeats no server's words", () => {
  assert.match(activityProblemText("forbidden"), /Ask an admin for Performance: Read\.$/);
  assert.match(activityProblemText("unreachable"), /could not reach this database/);
  assert.match(activityProblemText("failed"), /could not read this database's activity/);
  assert.match(driftProblemText("forbidden"), /Ask an admin for Drift: Read\.$/);
  assert.equal(driftProblemText("unreachable"), driftProblemText("failed"));
});

test("says when the computer was last seen, and what it needs, when it has gone", () => {
  const needs = " It has to be awake, with Schema Studio running and Let paired phones connect turned on.";
  assert.equal(offlineText(null, NOW), `Computer offline.${needs}`);
  assert.equal(offlineText(NOW - 5 * MINUTE, NOW), `Computer offline, last seen 5 minutes ago.${needs}`);
  assert.equal(offlineText(NOW - 10_000, NOW), `Computer offline, last seen just now.${needs}`);
});
