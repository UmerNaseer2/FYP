// Pure helpers for reasoning about migration-script versions: comparing
// semver-ish strings, and labelling each version of a script family
// Applied / Pending / Superseded against a target database's applied history.
//
// "Pure" on purpose — no DB, no fetch, no React — so it can be unit-tested in
// isolation and reused by the deploy page without dragging UI state along. The
// one import is the SQL reader in change-type, which is pure as well: the
// editor's suggestion has to come from the same rule Deploy grades with.
import { inferChangeTypeFromSql, type ScriptChangeType } from "./change-type";

/** Split a version like "v1.2.0" into [1, 2, 0], ignoring stray non-digits. */
export function versionParts(version: string): number[] {
  return version
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part.replace(/\D/g, ""), 10) || 0);
}

/**
 * Compare two versions as a sort comparator: negative if left < right, positive
 * if left > right, 0 if equal. Pads to 3 segments so "1.2" and "1.2.0" match.
 */
export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  // All numeric segments match → treat as equal. We deliberately do NOT fall
  // back to a string compare here: "v1.2.0", "1.2.0", and "1.2" are the same
  // version, and the ledger relies on that equality. De-duplication of GitHub
  // versions is done by exact string match elsewhere, not via this comparator.
  return 0;
}

// ── Authoring helpers (used by the Script Editor) ───────────────────────────

export type Semver = { major: number; minor: number; patch: number };
export type BumpLevel = "major" | "minor" | "patch";

/**
 * Parse a STRICT semver-ish string: 1 to 3 numeric segments, optional leading
 * "v". "2", "2.1", "v2.1.0" are accepted (missing segments default to 0);
 * anything with letters, extra segments, or empty parts returns null.
 */
export function parseSemver(version: string): Semver | null {
  const cleaned = (version ?? "").trim().replace(/^v/i, "");
  if (!/^\d+(\.\d+){0,2}$/.test(cleaned)) return null;
  const [major = "0", minor = "0", patch = "0"] = cleaned.split(".");
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/** True if `version` is a parseable semver-ish string. */
export function isValidSemver(version: string): boolean {
  return parseSemver(version) !== null;
}

/** Canonical "X.Y.Z" form, e.g. normalizeVersion("v2.1") → "2.1.0". */
export function normalizeVersion(version: string): string | null {
  const s = parseSemver(version);
  return s ? `${s.major}.${s.minor}.${s.patch}` : null;
}

/**
 * The version a family's first script gets, whatever its change level. The
 * same number as the lineage baseline (BASELINE_VERSION in lib/lineage-db.ts),
 * repeated here because this module must stay free of database imports.
 */
export const FIRST_VERSION = "1.0.0";

/**
 * True when `version` starts with a number, after an optional leading "v":
 * "1.2.0", "v2", and an outside four-part "1.2.0.3" all count; "init",
 * "latest" and "" do not.
 *
 * This "digit-first" rule is looser than isValidSemver on purpose. A version
 * that some other tool applied as 1.2.0.3 is still a real floor, and dropping
 * it (as the strict check did) let the editor offer a number below what the
 * target already runs.
 */
export function looksLikeVersion(version: string | null | undefined): version is string {
  return typeof version === "string" && /^v?\d/i.test(version.trim());
}

/**
 * The next version after `base`, bumped at `level`.
 *
 * No prior version means this is the first release, and a first release is
 * always 1.0.0 (FIRST_VERSION) at every level: there is nothing earlier for it
 * to be additive or breaking against, and the level is still recorded with the
 * script. "No prior version" covers null, a blank string and text that does
 * not start with a number. Otherwise the result is always STRICTLY greater
 * than `base`.
 */
export function bumpVersion(base: string | null, level: BumpLevel): string {
  if (!looksLikeVersion(base)) return FIRST_VERSION;
  // Use the tolerant versionParts (not strict parseSemver) so an externally
  // introduced 4+ segment floor like "1.2.0.3" still bumps from its first three
  // parts (→ "1.2.1") instead of collapsing and landing below the floor, which
  // would wedge the picker with every preset disabled.
  const [major = 0, minor = 0, patch = 0] = versionParts(base.trim());
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * The highest version in a list, or null when nothing in it looks like a
 * version (see looksLikeVersion). This is the family's floor: feed it the
 * version applied to the target together with every version in GitHub, and
 * bumpVersion(highestVersion(...), level) is the next number on every screen.
 *
 * Compared with compareVersions, so "1.10.0" beats "1.9.9". On a tie ("1.2"
 * and "1.2.0") the first one seen is kept, trimmed but otherwise as written.
 */
export function highestVersion(versions: ReadonlyArray<string | null | undefined>): string | null {
  let highest: string | null = null;
  for (const version of versions) {
    if (!looksLikeVersion(version)) continue;
    const trimmed = version.trim();
    if (highest === null || compareVersions(trimmed, highest) > 0) highest = trimmed;
  }
  return highest;
}

/** What checkNewVersion found. `highest` is the family's highest version, or null for a new family. */
export type NewVersionCheck = {
  status: "exists" | "not-above" | "ok";
  highest: string | null;
};

/**
 * Is `proposed` a new number strictly above every version the family already
 * has?
 *   - "exists":    the same version is already there (1.2 and 1.2.0 count as
 *                  the same, as they do everywhere else).
 *   - "not-above": it is lower than the family's highest version, so Deploy
 *                  would sort it below scripts already published and never
 *                  offer it.
 *   - "ok":        it is above everything, or the family is empty.
 * Normalise `proposed` first (normalizePushVersion in lib/registry-push.ts):
 * this check does not judge the format.
 */
export function checkNewVersion(existing: ReadonlyArray<string>, proposed: string): NewVersionCheck {
  const highest = highestVersion(existing);
  const taken = existing.some(
    (version) => looksLikeVersion(version) && compareVersions(version, proposed) === 0,
  );
  if (taken) return { status: "exists", highest };
  if (highest !== null && compareVersions(proposed, highest) < 0) return { status: "not-above", highest };
  return { status: "ok", highest };
}

/**
 * The version step each change level asks for: breaking → major, additive →
 * minor, patch → patch. The one place the two words for the same idea meet,
 * so the editor, the push route and Deploy cannot map them differently.
 */
export function levelToBump(level: ScriptChangeType): BumpLevel {
  if (level === "breaking") return "major";
  if (level === "additive") return "minor";
  return "patch";
}

/** The other way round: major → breaking, minor → additive, patch → patch. */
export function bumpToLevel(bump: BumpLevel): ScriptChangeType {
  if (bump === "major") return "breaking";
  if (bump === "minor") return "additive";
  return "patch";
}

/**
 * Suggest a bump level from the SQL.
 *
 * This is the same reader Deploy grades an unstamped script with (gradeSql in
 * lib/change-type.ts), so the editor suggests the level the script will later
 * be shown as. It used to be a plain substring search of its own, which read
 * "drop table" inside a comment as a real drop and called DROP VIEW a patch
 * while Deploy called it breaking.
 */
export function suggestBumpLevel(sql: string): BumpLevel {
  return levelToBump(inferChangeTypeFromSql(sql ?? ""));
}

/**
 * What kind of step a version number takes from the one before it: a new
 * major number is a breaking step, a new minor number an additive one, and
 * anything further right a patch. 1.2.3 → 2.0.0 is breaking, 1.2.3 → 1.3.0 is
 * additive, 1.2.3 → 1.2.4 is a patch.
 *
 * Null when there is no previous version to step from, or when `to` is not
 * above `from` — a number that stands still or goes backwards is not a step.
 * Uses the tolerant versionParts, so an outside "1.2.0.3" → "1.2.1" reads as
 * the patch step it looks like.
 */
export function levelOfStep(from: string | null, to: string): ScriptChangeType | null {
  if (!from || !from.trim()) return null;
  if (compareVersions(from, to) >= 0) return null;
  const before = versionParts(from);
  const after = versionParts(to);
  const length = Math.max(before.length, after.length, 3);
  // The first part that differs decides the kind of step.
  for (let index = 0; index < length; index += 1) {
    if ((before[index] ?? 0) === (after[index] ?? 0)) continue;
    if (index === 0) return "breaking";
    if (index === 1) return "additive";
    return "patch";
  }
  return null;
}

// One applied row, as far as the ledger cares (from script_patch via preflight).
export type AppliedVersion = {
  version: string;
  applied_at: string | null;
};

export type LedgerStatus = "applied" | "pending" | "superseded";

export type LedgerEntry = {
  version: string;
  status: LedgerStatus;
  appliedAt: string | null;
  /**
   * Whether the GitHub registry holds this version for this schema. False for a
   * version that reached the database some other way — a Version Sync replay,
   * or a script applied straight from the editor — which is applied and real,
   * but has no file here to read or to re-deploy from.
   */
  inRegistry: boolean;
};

/**
 * Label each GitHub version of ONE script family against what the target
 * database has already applied. Inputs must already be scoped to a single
 * (database, schema, script_name) — the deploy page does that filtering before
 * calling this, so a script_name@version from another database can never leak
 * in. This is the "forward view (pending vs applied)" computed from the
 * intersection of GitHub and script_patch only.
 *
 *   - applied    → the version is in the target's script_patch history.
 *   - pending    → in GitHub, not applied, and ABOVE the current applied version
 *                  (so the forward-only deploy will pick it up).
 *   - superseded → in GitHub, not applied, but at/below the current version
 *                  (left behind by an out-of-order apply; not in the run).
 *
 * An applied version that GitHub does not have for this schema is still listed,
 * marked inRegistry: false. Leaving it out used to hide it entirely — a Version
 * Sync replay lands in script_patch without ever writing a file here, so the
 * screen showed a stale "current version" and offered to roll back an older one
 * while a newer one was in fact applied.
 *
 * Returns entries sorted ascending by version.
 */
export function buildVersionLedger(
  githubVersions: string[],
  appliedHistory: AppliedVersion[]
): LedgerEntry[] {
  // Map each applied version to its timestamp (first wins if duplicated).
  const appliedAtByVersion = new Map<string, string | null>();
  for (const row of appliedHistory) {
    if (!appliedAtByVersion.has(row.version)) {
      appliedAtByVersion.set(row.version, row.applied_at);
    }
  }

  // Current = the highest applied version by semver (not by apply order, since
  // a hotfix for an older line can be applied after a newer version).
  let current: string | null = null;
  for (const row of appliedHistory) {
    if (current === null || compareVersions(row.version, current) > 0) {
      current = row.version;
    }
  }

  // De-duplicate the GitHub versions, then add any applied version GitHub does
  // not have, then sort ascending.
  const inRegistry = new Set<string>(githubVersions);
  const versions: string[] = [...inRegistry];
  for (const version of appliedAtByVersion.keys()) {
    if (!inRegistry.has(version)) versions.push(version);
  }
  versions.sort(compareVersions);

  return versions.map((version) => {
    if (appliedAtByVersion.has(version)) {
      return {
        version,
        status: "applied" as const,
        appliedAt: appliedAtByVersion.get(version) ?? null,
        inRegistry: inRegistry.has(version),
      };
    }
    if (current === null || compareVersions(version, current) > 0) {
      return { version, status: "pending" as const, appliedAt: null, inRegistry: true };
    }
    return { version, status: "superseded" as const, appliedAt: null, inRegistry: true };
  });
}
