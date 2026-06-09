// Pure, dependency-free helpers for reasoning about migration-script versions:
// comparing semver-ish strings, and labelling each version of a script family
// Applied / Pending / Superseded against a target database's applied history.
//
// "Pure" on purpose — no DB, no fetch, no React — so it can be unit-tested in
// isolation and reused by the deploy page without dragging UI state along.

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
 * The next version after `base`, bumped at `level`. A null/blank/invalid base
 * means "no prior version", so we bump from 0.0.0 (major → 1.0.0, minor →
 * 0.1.0, patch → 0.0.1). The result is always STRICTLY greater than `base`.
 */
export function bumpVersion(base: string | null, level: BumpLevel): string {
  // Use the tolerant versionParts (not strict parseSemver) so an externally
  // introduced 4+ segment floor like "1.2.0.3" still bumps from its first three
  // parts (→ "1.2.1") instead of collapsing to 0.0.0 and landing below the
  // floor — which would wedge the picker with every preset disabled.
  const [major = 0, minor = 0, patch = 0] = base ? versionParts(base) : [];
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Suggest a bump level by inspecting the SQL. Mirrors the deploy page's
 * change-kind heuristic so the editor's suggestion matches how the script will
 * later be classified:
 *   - "major"  → breaking: DROP / ALTER COLUMN / SET NOT NULL / RENAME
 *   - "minor"  → additive: CREATE TABLE / ADD COLUMN / ADD CONSTRAINT / CREATE INDEX
 *   - "patch"  → everything else (data tweaks, comments, defaults, …)
 */
export function suggestBumpLevel(sql: string): BumpLevel {
  const s = (sql ?? "").toLowerCase();
  if (
    s.includes("drop table") ||
    s.includes("drop column") ||
    s.includes("drop constraint") ||
    s.includes(" set not null") ||
    s.includes(" alter column") ||
    s.includes(" rename ")
  ) {
    return "major";
  }
  if (
    s.includes("create table") ||
    s.includes("add column") ||
    s.includes("add constraint") ||
    s.includes("create index")
  ) {
    return "minor";
  }
  return "patch";
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

  // De-duplicate the GitHub versions, then sort ascending.
  const seen = new Set<string>();
  const versions: string[] = [];
  for (const v of githubVersions) {
    if (!seen.has(v)) {
      seen.add(v);
      versions.push(v);
    }
  }
  versions.sort(compareVersions);

  return versions.map((version) => {
    if (appliedAtByVersion.has(version)) {
      return {
        version,
        status: "applied" as const,
        appliedAt: appliedAtByVersion.get(version) ?? null,
      };
    }
    if (current === null || compareVersions(version, current) > 0) {
      return { version, status: "pending" as const, appliedAt: null };
    }
    return { version, status: "superseded" as const, appliedAt: null };
  });
}
