// What the apply route says about the GitHub registry, and how a screen reads it.
//
// Spec feature 07: "Automatically push approved scripts to GitHub." The writing
// is in lib/registry-archive, which only runs on the server — it holds a GitHub
// token and reaches for Buffer. This module is the half both sides need: the
// shape of the answer, and the two sentences a screen shows about it.
//
// Split out rather than exported from registry-archive because Deploy and
// Version Sync are client components. Importing a TYPE from a server module is
// erased and harmless, but importing a FUNCTION from one pulls the token
// handling and the GitHub calls into the browser bundle. Keeping the pure part
// here means neither screen has to know that.

/**
 * What became of one applied version in the registry.
 *
 * "already-saved" is the ordinary answer — every version Deploy runs came out
 * of the registry to begin with — so the apply route leaves those out of its
 * response and only sends what changed or could not be written.
 */
export type ArchivedVersion = {
  script_name: string;
  version: string;
  status: "saved" | "already-saved" | "not-saved";
  /** <database>/<schema>/<script>/v<version>.sql, once the file exists. */
  path: string | null;
  /** Why not, in a sentence. Null unless status is "not-saved". */
  reason: string | null;
  /** Was its rollback written too? False when it has none, or none was needed. */
  rollback_saved: boolean;
};

const STATUSES = new Set(["saved", "already-saved", "not-saved"]);

/**
 * Read the `registry` field of an apply-route answer.
 *
 * Returns [] for anything that is not the expected shape, including a missing
 * field — which is the usual case, because the route sends it only when
 * something was added or failed. An older server has no such field at all, and
 * a screen that showed "the registry says nothing" for that would be reporting
 * a gap that does not exist.
 *
 * Entries are checked one at a time rather than the array as a whole: one
 * malformed row should not hide the rest, and a row about a version that did
 * not write is exactly the row worth keeping.
 */
export function readArchivedVersions(value: unknown): ArchivedVersion[] {
  if (!Array.isArray(value)) return [];
  const out: ArchivedVersion[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.script_name !== "string" || typeof row.version !== "string") continue;
    if (typeof row.status !== "string" || !STATUSES.has(row.status)) continue;
    out.push({
      script_name: row.script_name,
      version: row.version,
      status: row.status as ArchivedVersion["status"],
      path: typeof row.path === "string" ? row.path : null,
      reason: typeof row.reason === "string" ? row.reason : null,
      rollback_saved: row.rollback_saved === true,
    });
  }
  return out;
}

/** One version, named the way both screens name one: `v2.0.0 of "orders_fix"`. */
function name(entry: ArchivedVersion): string {
  return `v${entry.version} of "${entry.script_name}"`;
}

export type RegistryNote = {
  /** What was added to GitHub. Null when nothing was. */
  saved: string | null;
  /** What could not be, and what to do about it. Null when everything was. */
  problem: string | null;
};

/**
 * The two sentences a screen shows after a run.
 *
 * Separate strings rather than one, because they belong in different places:
 * the first is good news that sits with the success message, and the second is
 * a warning the user may have to act on. A screen that joined them would have
 * to pick one tone for both.
 *
 * Both are null on the ordinary run, where every version was already in the
 * registry and there is nothing to say.
 */
export function describeRegistry(entries: ReadonlyArray<ArchivedVersion>): RegistryNote {
  const saved = entries.filter((entry) => entry.status === "saved");
  const failed = entries.filter((entry) => entry.status === "not-saved");

  // The rollbacks are counted but not listed. A reader who wants to know which
  // version has one looks at the version, not at a sentence; what matters here
  // is whether the undo travelled with the migration at all.
  const withoutRollback = saved.filter((entry) => !entry.rollback_saved).length;

  return {
    saved:
      saved.length === 0
        ? null
        : `Recorded ${saved.map(name).join(", ")} in the GitHub registry` +
          (withoutRollback > 0
            ? saved.length === 1
              ? ", without a rollback file."
              : `, ${withoutRollback} of them without a rollback file.`
            : "."),
    problem:
      failed.length === 0
        ? null
        : failed.length === 1
          ? (failed[0].reason ??
             `${name(failed[0])} was not recorded in the GitHub registry.`)
          : `${failed.map(name).join(", ")} were applied but not recorded in the GitHub ` +
            `registry, so it does not yet list them. They are applied and safe — save them ` +
            `from the Script Editor once GitHub is reachable.`,
  };
}
