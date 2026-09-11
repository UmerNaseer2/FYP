// ---------------------------------------------------------------------------
// compare-selection.ts
// The small decisions behind the Compare screen's pickers, kept pure so they
// can be unit-tested and imported by the page itself.
//
// Nothing here opens a connection or imports pg. The browser bundle imports
// this file, and a database driver must never ride along with it.
// ---------------------------------------------------------------------------

/**
 * The selection currently on screen: one source and an ordered list of
 * targets. It is what Save writes into a comparison set, and what "Use as
 * source" and deleting a set turn back into a URL.
 *
 * `connectionId` is null when that side has no saved connection — never
 * picked, or deleted since a set was saved. The label then names what it was.
 */
export type CurrentSelection = {
  sourceConnectionId: number | null;
  sourceConnectionLabel: string;
  sourceSchema: string;
  allowDataLoss: boolean;
  compareData: boolean;
  targets: { connectionId: number | null; connectionLabel: string; schema: string }[];
};

// Every way a client can spell "this machine". Folded together so a connection
// saved as `localhost` and a copy saved as `127.0.0.1` read as the one database
// they are. An empty host is what the driver dials as localhost too.
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * A key that is the same for two connection configs reaching the same
 * database: host, port and database name.
 *
 * Compare used to ask "is this the same SAVED connection?", and a second saved
 * entry for the same database — a copy, or one with another user — answered
 * "no". Comparing a schema with itself through two entries then showed
 * "0 changes", which reads as two databases agreeing.
 *
 * Only the spellings of this machine are folded together. The same server
 * reached through two DNS names, or by name and by IP, still counts as two:
 * telling those apart needs a DNS lookup, and this runs on every comparison.
 */
export function databaseIdentity(config: {
  host?: string | null;
  port?: number | string | null;
  database?: string | null;
}): string {
  const typedHost = (config.host ?? "").trim().toLowerCase();
  const host = LOCAL_HOSTS.has(typedHost) ? "localhost" : typedHost;
  // A missing port is PostgreSQL's default, which is what the driver dials.
  const typedPort = Number(config.port);
  const port = Number.isInteger(typedPort) && typedPort > 0 ? typedPort : 5432;
  const database = (config.database ?? "").trim();
  return `${host}:${port}/${database}`;
}

/**
 * Which schema a picker shows after its connection changes.
 *
 * The same name when the new database has it — dev.public to staging.public is
 * the usual move — then `public`, which nearly every database has, then the
 * first one listed. An empty list gives "", and the server picks the default
 * for an empty schema when the form is submitted.
 */
export function pickSchemaAfterConnectionChange(previous: string, list: string[]): string {
  if (previous.length > 0 && list.includes(previous)) return previous;
  if (list.includes("public")) return "public";
  return list[0] ?? "";
}

/**
 * For each key, the index of the first EARLIER key equal to it, or null.
 *
 * `findDuplicateTargets(["a", "b", "a"])` is `[null, null, 0]`: the third
 * target repeats the first. The first occurrence is never the duplicate — it
 * is the one that gets compared.
 */
export function findDuplicateTargets(keys: string[]): (number | null)[] {
  const firstSeen = new Map<string, number>();
  return keys.map((key, index) => {
    const earlier = firstSeen.get(key);
    if (earlier !== undefined) return earlier;
    firstSeen.set(key, index);
    return null;
  });
}

/**
 * The same comparison turned around one target: that target becomes the
 * source, and the old source takes its place at the head of the targets.
 *
 * Every target is compared with the source and never with its neighbours, so
 * this is how "staging against prod" is reached when both are targets — one
 * click instead of rebuilding the pickers.
 */
export function swapSourceWithTarget(
  selection: CurrentSelection,
  index: number,
): CurrentSelection {
  const chosen = selection.targets[index];
  if (!chosen) return selection;
  return {
    ...selection,
    sourceConnectionId: chosen.connectionId,
    sourceConnectionLabel: chosen.connectionLabel,
    sourceSchema: chosen.schema,
    targets: [
      {
        connectionId: selection.sourceConnectionId,
        connectionLabel: selection.sourceConnectionLabel,
        schema: selection.sourceSchema,
      },
      ...selection.targets.filter((_, position) => position !== index),
    ],
  };
}

/**
 * A selection as the query string the Compare form would submit for it.
 *
 * Used where the page navigates to a comparison instead of submitting the
 * form: after deleting a saved set, and for "Use as source". The field names
 * are the form's, so the server reads both the same way.
 *
 * A side with no connection is written as an empty value rather than left
 * out. Left out, the server would fill it with a default connection — a
 * database nobody chose, compared under that side's name. Empty, it shows as
 * "no connection picked" until somebody picks one.
 *
 * No `run` parameter: the caller decides whether the link runs the
 * comparison or only fills in the pickers.
 */
export function selectionToQuery(selection: CurrentSelection): string {
  const params = new URLSearchParams();
  params.set(
    "sourceConnection",
    selection.sourceConnectionId === null ? "" : String(selection.sourceConnectionId),
  );
  params.set("sourceSchema", selection.sourceSchema);
  for (const target of selection.targets) {
    params.append(
      "targetConnection",
      target.connectionId === null ? "" : String(target.connectionId),
    );
    params.append("targetSchema", target.schema);
  }
  if (selection.allowDataLoss) params.set("allowDataLoss", "1");
  if (selection.compareData) params.set("compareData", "1");
  return params.toString();
}

/**
 * Why the source has no connection to read, in a sentence that says what to do.
 *
 * `label` is the name a saved set remembers for a source whose connection was
 * deleted; null when the set is not the reason. `connectionId` is what the URL
 * asked for, "" when nothing was picked.
 */
export function missingSourceMessage(connectionId: string, label: string | null): string {
  if (label !== null) {
    return label.trim().length > 0
      ? `The source connection "${label}" no longer exists — it was deleted. Pick another source connection, then press Compare.`
      : "The source connection this set used was deleted. Pick another source connection, then press Compare.";
  }
  if (connectionId.length > 0) {
    return `The source connection #${connectionId} does not exist — it may have been deleted. Pick another source connection, then press Compare.`;
  }
  return "No source connection is picked. Pick one, then press Compare.";
}

/** The same, for one target. Shown under its picker and in its result card. */
export function missingConnectionMessage(
  connectionId: string,
  missingLabel: string | null,
): string {
  if (missingLabel !== null) {
    return missingLabel.trim().length > 0
      ? `"${missingLabel}" no longer exists — it was deleted. Pick another connection for this target, or remove it.`
      : "The connection this set used for this target was deleted. Pick another connection for this target, or remove it.";
  }
  if (connectionId.length > 0) {
    return `Connection #${connectionId} does not exist — it may have been deleted. Pick another connection for this target, or remove it.`;
  }
  return "No connection is picked for this target. Pick one, then press Compare.";
}
