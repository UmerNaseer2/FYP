/**
 * Which drift checks earn a desktop notification, and what it says.
 *
 * The app's server checks each tracked schema on its own timer
 * (my-app/lib/drift-scheduler.ts) and writes what it found to drift_events.
 * The desktop reads the new rows (src/main/drift-watcher.ts) and asks this
 * file what to say about them. Only scheduled checks count: a manual check,
 * a deploy, a re-baseline and an acknowledgement were done by someone at the
 * screen, who knows already. Each row is judged against the row before it,
 * so a schema that stays drifted the same way, or stays out of reach, is
 * told about once rather than at every check.
 *
 * Nothing the database said goes into a notification, since an unreachable
 * check keeps the database's own error, which can name a host. The words are
 * fixed, with only the schema's and the connection's names put in.
 *
 * Pure: no Electron and no database. Tested in src/test/drift-alerts.test.ts.
 */

/** What a check counted, as the server saves it with the row (my-app/lib/lineage-db.ts). */
export type DriftCounts = {
  /** Tables the database has that the baseline does not. */
  tablesAdded: number;
  /** Tables the baseline has that the database does not. */
  tablesRemoved: number;
  tablesChanged: number;
  constraintsChanged: number;
  /** Views, functions, sequences, types, extensions and grants. */
  objectsChanged: number;
};

/** One row of the drift log, with what the watcher's query adds about the rows before it. */
export type DriftRow = {
  id: number;
  trackedSchemaId: number;
  status: string;
  source: string;
  /** What the check found, in short. Null on the rows a person's action wrote. */
  fingerprint: string | null;
  counts: DriftCounts | null;
  schemaName: string;
  label: string | null;
  connectionName: string | null;
  /** The status of the row just before this one for the same schema, whatever wrote it. */
  previousStatus: string | null;
  /** The newest earlier fingerprint for the same schema and the same baseline. */
  lastFingerprint: string | null;
};

/**
 * What a check found that is news: drift where there was none, drift that
 * changed, drift gone, a database out of reach, and one back in reach.
 */
export type DriftAlertKind = "drifted" | "changed" | "in_sync" | "unreachable" | "reachable";

export type DriftAlert = {
  kind: DriftAlertKind;
  eventId: number;
  trackedSchemaId: number;
  /** The schema's label, or else its name, made fit for one line. */
  name: string;
  connectionName: string | null;
  counts: DriftCounts | null;
  /** Whether the check found drift, which "reachable" says too. */
  drifted: boolean;
};

export type DriftNotification = {
  title: string;
  body: string;
  /** The page of the app a click on the notification opens. */
  page: string;
};

/** The most of a name a notification shows, in characters. */
const NAME_LIMIT = 48;

/** How many lines a notification about several schemas has at most. */
const MAX_LINES = 4;

const TITLE: Record<DriftAlertKind, string> = {
  drifted: "Drift found",
  changed: "Drift changed",
  in_sync: "Back in sync",
  unreachable: "Database not reachable",
  reachable: "Database reachable again",
};

/** The most pressing first, when one notification is about several schemas. */
const RANK: Record<DriftAlertKind, number> = { drifted: 0, changed: 1, unreachable: 2, reachable: 3, in_sync: 4 };

/** One line each, for a notification about several schemas. */
const SHORT: Record<DriftAlertKind, (subject: string) => string> = {
  drifted: (subject) => `${subject} has drifted`,
  changed: (subject) => `The drift in ${subject} has changed`,
  in_sync: (subject) => `${subject} is back in sync`,
  unreachable: (subject) => `${subject} cannot be reached`,
  reachable: (subject) => `${subject} can be reached again`,
};

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * The counts a check saved with its row, or null when it saved none. A count
 * left out reads as 0: rows saved before the server counted other objects do
 * not have that one.
 */
export function readCounts(detail: unknown): DriftCounts | null {
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return null;
  const saved = detail as Record<string, unknown>;
  return {
    tablesAdded: readCount(saved.tablesAdded),
    tablesRemoved: readCount(saved.tablesRemoved),
    tablesChanged: readCount(saved.tablesChanged),
    constraintsChanged: readCount(saved.constraintsChanged),
    objectsChanged: readCount(saved.objectsChanged),
  };
}

/** A row's number, which PostgreSQL may give as digits when it is a big one. */
function readId(value: unknown): number | null {
  const id = typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function readText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Reads one row of the watcher's query (src/main/drift-watcher.ts), or gives
 * null for a row the alerts cannot use. The summary the server saved is never
 * read, as it can hold the database's own error.
 */
export function readDriftRow(raw: Record<string, unknown>): DriftRow | null {
  const id = readId(raw.id);
  const trackedSchemaId = readId(raw.tracked_schema_id);
  const status = readText(raw.status);
  const source = readText(raw.source);
  const schemaName = readText(raw.schema_name);
  if (id === null || trackedSchemaId === null || status === null || source === null || schemaName === null) return null;
  return {
    id,
    trackedSchemaId,
    status,
    source,
    fingerprint: readText(raw.fingerprint),
    counts: readCounts(raw.detail),
    schemaName,
    label: readText(raw.label),
    connectionName: readText(raw.connection_name),
    previousStatus: readText(raw.previous_status),
    lastFingerprint: readText(raw.last_fingerprint),
  };
}

/** A name made fit for one line of a notification, or null when nothing of it is left. */
function cleanName(text: string | null): string | null {
  if (text === null) return null;
  // Format characters (zero-width ones, and the ones that turn the text after
  // them around) go, and line breaks, tabs and other control characters
  // become one space.
  const clean = text
    .replace(/\p{Cf}+/gu, "")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  if (clean === "") return null;
  // Counted in characters, not UTF-16 units, so that an emoji is never cut in half.
  const characters = Array.from(clean);
  if (characters.length <= NAME_LIMIT) return clean;
  return `${characters.slice(0, NAME_LIMIT - 1).join("").trimEnd()}\u{2026}`;
}

/** What is news in a scheduled check, judged against the row before it, or null when nothing is. */
function alertKind(row: DriftRow): DriftAlertKind | null {
  const before = row.previousStatus;
  switch (row.status) {
    case "unreachable":
      return before === "unreachable" ? null : "unreachable";
    case "in_sync":
      if (before === "drifted") return "in_sync";
      return before === "unreachable" ? "reachable" : null;
    case "drifted":
      if (before === "unreachable") return "reachable";
      if (before !== "drifted") return "drifted";
      // Still drifted. A deploy or an acknowledgement in between has no
      // fingerprint, so this compares with the last check against the same
      // baseline, which says whether the drift itself is different now.
      return row.fingerprint !== null && row.lastFingerprint !== null && row.fingerprint !== row.lastFingerprint
        ? "changed"
        : null;
    default:
      return null;
  }
}

/** The alert a row of the drift log earns, or null when it is not news. */
export function driftAlert(row: DriftRow): DriftAlert | null {
  if (row.source !== "scheduled") return null;
  const kind = alertKind(row);
  if (kind === null) return null;
  return {
    kind,
    eventId: row.id,
    trackedSchemaId: row.trackedSchemaId,
    name: cleanName(row.label) ?? cleanName(row.schemaName) ?? `Schema ${row.trackedSchemaId}`,
    connectionName: cleanName(row.connectionName),
    counts: row.counts,
    drifted: row.status === "drifted",
  };
}

function counted(count: number, one: string, many: string): string | null {
  if (count === 0) return null;
  return `${count} ${count === 1 ? one : many}`;
}

/** The counts in words, such as "2 tables added and 1 constraint changed", or null when all are 0. */
function countsText(counts: DriftCounts | null): string | null {
  if (counts === null) return null;
  const parts = [
    counted(counts.tablesAdded, "table added", "tables added"),
    counted(counts.tablesRemoved, "table removed", "tables removed"),
    counted(counts.tablesChanged, "table changed", "tables changed"),
    counted(counts.constraintsChanged, "constraint changed", "constraints changed"),
    counted(counts.objectsChanged, "other object changed", "other objects changed"),
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The schema, and the connection it is on when that has a name. */
function subjectOf(alert: DriftAlert): string {
  return alert.connectionName === null ? alert.name : `${alert.name} on ${alert.connectionName}`;
}

function singleBody(alert: DriftAlert): string {
  const subject = subjectOf(alert);
  const counts = countsText(alert.counts);
  switch (alert.kind) {
    case "drifted":
      return counts === null
        ? `${subject} no longer matches its baseline.`
        : `${subject} no longer matches its baseline: ${counts}.`;
    case "changed":
      return counts === null ? `The drift in ${subject} has changed.` : `The drift in ${subject} has changed. Now: ${counts}.`;
    case "in_sync":
      return `${subject} matches its baseline again.`;
    case "unreachable":
      return `Schema Studio could not reach ${subject} to check it for drift. It tries again at the next check.`;
    case "reachable":
      if (!alert.drifted) return `Schema Studio can reach ${subject} again, and it matches its baseline.`;
      return counts === null
        ? `Schema Studio can reach ${subject} again, but it differs from its baseline.`
        : `Schema Studio can reach ${subject} again, but it differs from its baseline: ${counts}.`;
  }
}

/**
 * The notification body with the characters of markup written out. On Linux
 * the notification shows its body as simple markup, so a name such as
 * "<b>orders" would otherwise turn bold, or not show at all.
 */
function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * One notification for the alerts of one look at the drift log, or null when
 * there are none. Only the newest alert about each schema counts, as it says
 * how things are now. Set `markup` where the body is shown as markup (Linux);
 * the title never is.
 */
export function driftNotification(alerts: readonly DriftAlert[], options: { markup: boolean }): DriftNotification | null {
  const newest = new Map<number, DriftAlert>();
  for (const alert of alerts) {
    const known = newest.get(alert.trackedSchemaId);
    if (known === undefined || alert.eventId > known.eventId) newest.set(alert.trackedSchemaId, alert);
  }
  const chosen = [...newest.values()];
  if (chosen.length === 0) return null;
  let text: DriftNotification;
  if (chosen.length === 1) {
    const only = chosen[0];
    text = { title: TITLE[only.kind], body: singleBody(only), page: `/drift?tab=detail&schema=${only.trackedSchemaId}` };
  } else {
    chosen.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.eventId - b.eventId);
    // A notification shows only a few lines, so past that the rest are counted.
    const shown = chosen.length <= MAX_LINES ? chosen : chosen.slice(0, MAX_LINES - 1);
    const lines = shown.map((alert) => `\u{2022} ${SHORT[alert.kind](subjectOf(alert))}`);
    if (shown.length < chosen.length) lines.push(`And ${chosen.length - shown.length} more.`);
    // The Drift page on its own opens on the schema with the worst drift.
    text = { title: `Drift alerts for ${chosen.length} schemas`, body: lines.join("\n"), page: "/drift" };
  }
  return options.markup ? { ...text, body: escapeMarkup(text.body) } : text;
}
