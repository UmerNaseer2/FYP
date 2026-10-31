/**
 * The words the phone app shows on a connection's live status screen: what
 * each session is doing, how a health number reads, how drift stands, and
 * why a part of the screen is missing. Kept apart from the screens so the
 * tests (src/test/phone-live.test.ts) can check every sentence in Node.
 */
import { countText, dayText } from "./format.js";
import type { DriftStatus, HealthLevel, LiveActivity, LiveDrift, LiveHealth, LiveProblem, LiveSession, LiveSessionKind } from "../shared/remote/rpc.js";

/** What a session is doing, in the words the web app's Performance screen uses. */
export const KIND_LABELS: Record<LiveSessionKind, string> = {
  blocked: "Waiting for a lock",
  "idle-in-transaction": "Idle in a transaction",
  "long-running": "Long-running",
  running: "Running",
};

export const HEALTH_LABELS: Record<HealthLevel, string> = {
  good: "Good",
  watch: "Watch",
  bad: "Bad",
  unknown: "Unknown",
};

export const DRIFT_LABELS: Record<DriftStatus, string> = {
  in_sync: "In sync",
  drifted: "Drifted",
  unreachable: "Could not reach",
};

/** The tone a tag takes: red for what is holding someone up or has gone wrong, amber for what to keep an eye on. */
export type Tone = "good" | "warn" | "bad" | "plain";

export const KIND_TONES: Record<LiveSessionKind, Tone> = {
  blocked: "bad",
  "idle-in-transaction": "warn",
  "long-running": "warn",
  running: "plain",
};

export const HEALTH_TONES: Record<HealthLevel, Tone> = {
  good: "good",
  watch: "warn",
  bad: "bad",
  unknown: "plain",
};

export const DRIFT_TONES: Record<DriftStatus, Tone> = {
  in_sync: "good",
  drifted: "bad",
  unreachable: "warn",
};

/** A length of time in a few words, as in "12 s", "3 min" or "2 h 5 min". PostgreSQL measures in fractions of a second, which no one needs here. */
export function durationText(seconds: number): string {
  // A session a moment old is common, and "0 s" would read as if it had not started.
  if (seconds < 1) return "under 1 s";
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/**
 * How long a session has been at it. For a session idle in a transaction the
 * time is how long it has sat idle, which is what makes it a problem, so the
 * line says that rather than leaving it to look like a running query's time.
 */
export function sessionTimeText({ kind, querySeconds }: LiveSession): string | null {
  if (querySeconds === null) return null;
  return kind === "idle-in-transaction" ? `Idle for ${durationText(querySeconds)}` : `For ${durationText(querySeconds)}`;
}

/** A transaction's age, worth showing only when it has outlived the statement running in it. */
export function transactionText({ querySeconds, xactSeconds }: LiveSession): string | null {
  if (xactSeconds === null || querySeconds === null || xactSeconds - querySeconds < 1) return null;
  return `Transaction open for ${durationText(xactSeconds)}`;
}

/** The rule "long-running" follows here, which is a setting people change. */
export function longRunningText(activity: LiveActivity): string {
  return `Long-running means over ${durationText(activity.longRunningSeconds)}.`;
}

/** Said when the list stops short: a message holds only the worst sessions, and the counts above it cover them all. */
export function moreSessionsText(activity: LiveActivity): string | null {
  const more = activity.total - activity.sessions.length;
  return more > 0 ? `And ${countText(more, "more session", "more sessions")} doing less urgent work.` : null;
}

/**
 * Why no SQL shows, when none does. The reason decides who can change it: a
 * setting on the computer, or the rights of the database user behind the
 * connection.
 */
export function queryTextHint(activity: LiveActivity): string | null {
  if (activity.sessions.length === 0) return null;
  if (!activity.queryText) {
    return "The SQL is hidden, because it can hold private data. To show it here, turn on Show phones the SQL it is running for this connection in Settings on the computer.";
  }
  if (activity.someHidden) {
    return "Some SQL is hidden, because PostgreSQL shows a session's SQL only to the role that owns it, to a superuser, or to a member of pg_read_all_stats.";
  }
  return null;
}

/**
 * What the health numbers cover. They are totals since PostgreSQL last reset
 * its counters, not a reading of this moment, so the section says so.
 */
export function healthSinceText(health: LiveHealth): string {
  const since = health.since === null ? Number.NaN : Date.parse(health.since);
  return Number.isNaN(since)
    ? "Totals since PostgreSQL last reset its counters, not just this moment."
    : `Totals since ${dayText(since)}, when PostgreSQL last reset its counters, not just this moment.`;
}

/** One tracked schema's drift in words. A check that was never run has no status. */
export function driftTag(drift: LiveDrift): { label: string; tone: Tone } {
  return drift.status === null ? { label: "Not checked yet", tone: "plain" } : { label: DRIFT_LABELS[drift.status], tone: DRIFT_TONES[drift.status] };
}

/** How long ago something happened, as in "5 minutes ago". After a day the date says more than the count. */
export function agoText(time: number, now: number): string {
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${countText(minutes, "minute", "minutes")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${countText(hours, "hour", "hours")} ago`;
  return `on ${dayText(time)}`;
}

/** When a schema's drift was last looked at, or null when the time cannot be read. */
export function driftCheckedText(drift: LiveDrift, now: number): string | null {
  const time = drift.checkedAt === null ? Number.NaN : Date.parse(drift.checkedAt);
  return Number.isNaN(time) ? null : `Checked ${agoText(time, now)}`;
}

/** The app's way of writing a time of day, as in "14:03:22", in this phone's own time zone. */
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function timeText(time: number): string {
  return TIME.format(time);
}

/** Why the activity part is missing. Who to ask comes first when an admin can fix it. */
export function activityProblemText(problem: LiveProblem): string {
  switch (problem) {
    case "forbidden":
      return "Your role can't see what this database is doing. Ask an admin for Performance: Read.";
    case "unreachable":
      return "Schema Studio could not reach this database, so its activity can't show. It may be down, or its connection details may have changed.";
    case "failed":
      return "The computer could not read this database's activity just now.";
  }
}

/** Why the drift part is missing. */
export function driftProblemText(problem: LiveProblem): string {
  switch (problem) {
    case "forbidden":
      return "Your role can't see drift. Ask an admin for Drift: Read.";
    case "unreachable":
    case "failed":
      return "The computer could not read the drift results just now.";
  }
}

/**
 * The status line when the relay says the computer is away. The computer
 * answers everything a phone asks, so this is the one thing that stops the
 * app, and a sleeping laptop looks the same as a closed app from here.
 */
export function offlineText(lastSeenAt: number | null, now: number): string {
  const seen = lastSeenAt === null ? "Computer offline." : `Computer offline, last seen ${agoText(lastSeenAt, now)}.`;
  return `${seen} It has to be awake, with Schema Studio running and Let paired phones connect turned on.`;
}
