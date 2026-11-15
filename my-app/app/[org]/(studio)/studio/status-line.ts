/**
 * The one status line on a Dashboard card: the state, who found it, when, and
 * how often the schema is checked. For example:
 *
 *   "Found by the scheduled check 1 day ago. Checks every 15 minutes."
 *   "Not checked yet. Checks every 15 minutes."
 *
 * Everything here is plain text in, plain text out, so it is easy to test.
 */

/** What ran the last recorded check (the `source` of a drift event), if known. */
export type CheckSource = string | null | undefined;

/** "5 minutes ago", "1 day ago". Empty when the time is missing or unreadable. */
export function longAgo(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.floor(Math.max(0, nowMs - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** "Checks every 15 minutes." 0 minutes means nobody checks it on a timer. */
export function cadenceSentence(intervalMinutes: number | null | undefined): string {
  const minutes = Math.floor(Number(intervalMinutes) || 0);
  if (minutes <= 0) return "Checks only when someone asks.";
  if (minutes === 1) return "Checks every minute.";
  if (minutes === 1440) return "Checks once a day.";
  if (minutes % 1440 === 0) return `Checks every ${minutes / 1440} days.`;
  if (minutes === 60) return "Checks every hour.";
  if (minutes % 60 === 0) return `Checks every ${minutes / 60} hours.`;
  return `Checks every ${minutes} minutes.`;
}

/** The check that found something, in words. Null when we do not know which. */
function whoFound(source: CheckSource): string | null {
  switch (source) {
    case "scheduled":
      return "the scheduled check";
    case "manual":
      return "a check someone ran";
    case "tracking":
      return "the first check after tracking";
    case "deploy":
      return "the check after a deploy";
    case "rebaseline":
      return "the check after a re-baseline";
    default:
      return null;
  }
}

/** Upper-case the first letter, to start a sentence with whoFound's words. */
function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type StatusLineInput = {
  /** "in_sync" | "drifted" | "unreachable", or null when never checked. */
  status: string | null;
  /** When the last RESULT was recorded. */
  foundAt: string | null;
  /** When a check last RAN. A check that changes nothing records no result. */
  lastRanAt?: string | null;
  /** What ran the check that recorded the result, if the page could read it. */
  source?: CheckSource;
  intervalMinutes?: number | null;
};

/** The whole line. `nowMs` is passed in so the age can tick with the clock. */
export function statusLine(input: StatusLineInput, nowMs: number): string {
  const cadence = cadenceSentence(input.intervalMinutes);
  const who = whoFound(input.source);
  // A leading space, so the age can be left out without a double space.
  const found = longAgo(input.foundAt, nowMs);
  const when = found ? ` ${found}` : "";

  if (input.status === "drifted") {
    return who ? `Found by ${who}${when}. ${cadence}` : `Drift found${when}. ${cadence}`;
  }

  if (input.status === "unreachable") {
    return `${who ? sentenceStart(who) : "The last check"} could not connect${when}. ${cadence}`;
  }

  if (input.status === "in_sync") {
    // Checks that find nothing new keep running without recording a result,
    // so the newest run can be later than the result, and by another check.
    const ran = longAgo(input.lastRanAt ?? input.foundAt, nowMs);
    const laterRun =
      !!input.lastRanAt &&
      !!input.foundAt &&
      new Date(input.lastRanAt).getTime() - new Date(input.foundAt).getTime() > 60_000;
    if (who && !laterRun) return `${sentenceStart(who)} found it in sync${when}. ${cadence}`;
    return ran
      ? `Matched its saved version at the last check, ${ran}. ${cadence}`
      : `Matched its saved version at the last check. ${cadence}`;
  }

  return `Not checked yet. ${cadence}`;
}
