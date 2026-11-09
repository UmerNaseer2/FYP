/**
 * The words the phone app shows for what the computer sends: environment
 * names, counts, kinds of change, what the signed-in role may do, waits,
 * dates, and SQL with the characters that do not show on screen marked. Kept
 * apart from the screens so the tests (src/test/phone-format.test.ts) can
 * check every sentence in Node.
 */
import type {
  ChangeKind,
  Environment,
  ForeignKeyOverview,
  HelloResult,
  Severity,
  TargetSummary,
} from "../shared/remote/rpc.js";

/** Each environment's name, as the web app (my-app/lib/environments.ts) and the computer's Settings write it. */
export const ENVIRONMENT_LABELS: Record<Environment, string> = {
  unset: "Unlabelled",
  dev: "Dev",
  staging: "Staging",
  prod: "Production",
};

/** What became of an object, in the web app's words. */
export const CHANGE_LABELS: Record<ChangeKind, string> = {
  added: "Added",
  dropped: "Dropped",
  changed: "Changed",
  renamed: "Renamed",
  "rename-suggested": "Possible rename",
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  breaking: "Breaking",
  safe: "Safe",
  info: "Info",
};

/** A count and what it counts, such as "1 table" or "3 tables". */
export function countText(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * A target's result in a few words, for the top of its card. When it was not
 * compared, the computer's own sentence (TargetSummary.error) goes under it.
 */
export function targetHeadline(target: TargetSummary): string {
  switch (target.status) {
    case "compared":
      return target.changes === 0 ? "No differences" : countText(target.changes, "difference", "differences");
    case "same-as-source":
      return "Same as the source";
    case "unreachable":
      return "Could not connect";
    case "schema-missing":
      return "No such schema";
    case "duplicate":
      return "Compared already";
    case "no-connection":
      return "Connection not found";
    case "failed":
      return "Could not compare";
  }
}

/**
 * A foreign key on one line: its columns, an arrow, and the table and columns
 * they point at. The table's schema is left out when it is the one on screen.
 */
export function foreignKeyText(key: ForeignKeyOverview, schema: string): string {
  const table =
    key.referencedTable === null
      ? "a table PostgreSQL did not name"
      : key.referencedSchema === null || key.referencedSchema === schema
        ? key.referencedTable
        : `${key.referencedSchema}.${key.referencedTable}`;
  const columns = key.referencedColumns.length > 0 ? ` (${key.referencedColumns.join(", ")})` : "";
  return `${key.columns.join(", ")} \u{2192} ${table}${columns}`;
}

/**
 * Characters that do not show on screen, or show as something they are not,
 * in SQL someone reads before deciding on it. A carriage return with no line
 * feed straight after it ends a `--` comment for PostgreSQL, while a browser
 * shows it as a space, so `-- adds an index` + CR + `DROP TABLE accounts;`
 * looks like one comment and drops the table. The others are the other
 * control characters, zero-width and invisible ones, the marks that turn text
 * the other way round, the line and paragraph separators and the byte order
 * mark. Tabs, line feeds and CRLF line endings are SQL as people write it.
 */
const HIDDEN = /\r(?!\n)|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

/** Whether `text` holds any character that does not show on screen (HIDDEN). */
export function hasHiddenCharacters(text: string): boolean {
  return text.search(HIDDEN) !== -1;
}

/**
 * `text` with each character that does not show on screen (HIDDEN) put in
 * sight: a lone carriage return as ␍ and the line break PostgreSQL reads it
 * as, and any other as its code, as in ⟦U+200B⟧. It is only for showing: the
 * phone works out fingerprints from the SQL exactly as the computer sent it.
 */
export function showHiddenCharacters(text: string): string {
  return text.replace(HIDDEN, (found) =>
    found === "\r" ? "\u{240D}\n" : `\u{27E6}U+${found.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}\u{27E7}`,
  );
}

/**
 * What the role signed in on the computer lets this phone do, or null when it
 * may do all of it. A phone may do only what that role may do in the app.
 */
export function accessProblem(hello: HelloResult): string | null {
  if (!hello.signedIn) {
    return "No one is signed in to Schema Studio on the computer. Sign in there, then choose Check again.";
  }
  const role = hello.role === null ? "The role signed in on the computer" : `The ${hello.role} role signed in on the computer`;
  if (!hello.canReadSchemas && !hello.canCompare) return `${role} may not look at schemas or compare them.`;
  if (!hello.canReadSchemas) return `${role} may compare schemas, but not look through them.`;
  if (!hello.canCompare) return `${role} may look at schemas, but not compare them.`;
  return null;
}

/** How long until the next try, as "Trying again in 12 s". Never "in 0 s": by then the try is under way. */
export function retryText(retryAt: number, now: number): string {
  return `Trying again in ${Math.max(1, Math.ceil((retryAt - now) / 1000))} s`;
}

/** The web app's way of writing a day, as in "23 Oct 2026", in this phone's own time zone. */
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** A day, as in "23 Oct 2026". */
export function dayText(time: number): string {
  return DAY.format(time);
}

/**
 * A name for this device, from what the browser says it runs on, which the
 * person can change before pairing. An iPad's browser says it is a Mac, so a
 * Mac with a touch screen is taken for an iPad. On a laptop, the name says
 * which browser, as each browser there pairs by itself.
 */
export function defaultPhoneName(userAgent: string, maxTouchPoints: number): string {
  if (/\biPhone\b/.test(userAgent)) return "iPhone";
  if (/\biPad\b/.test(userAgent) || (/\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1)) return "iPad";
  if (/\bAndroid\b/.test(userAgent)) return /\bMobile\b/.test(userAgent) ? "Android phone" : "Android tablet";
  const browser = firstMatch(userAgent, BROWSERS);
  const system = firstMatch(userAgent, SYSTEMS);
  return browser !== null && system !== null ? `${browser} on ${system}` : "Phone";
}

// In this order, because browsers name each other: Edge and Opera also say Chrome, and Chrome also says Safari.
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\bFirefox\//, "Firefox"],
  [/\bChrome\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

// In this order, because Ubuntu also says Linux.
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\bMacintosh\b/, "Mac"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "Chromebook"],
  [/\bUbuntu\b/, "Ubuntu"],
  [/\bLinux\b/, "Linux"],
];

function firstMatch(text: string, names: readonly (readonly [RegExp, string])[]): string | null {
  for (const [pattern, name] of names) {
    if (pattern.test(text)) return name;
  }
  return null;
}
