// The two reads the next version of a script is worked out from. Both push
// screens (the Migration Workbench on Compare, and the Script Editor) use
// these, so they always offer the same number:
//
//   floor = highestVersion([applied, ...versions in GitHub])
//   next  = bumpVersion(floor, level)            (lib/script-status.ts)
//
// Both are plain fetches of this app's own routes, so this file is safe to
// import from a client component: the GitHub token never leaves the server.
import { looksLikeVersion } from "@/lib/script-status";

/** What GitHub holds for one script family, or why it could not be read. */
export type FamilyVersionsRead = { ok: true; versions: string[] } | { ok: false; error: string };

/** What the target has applied for one script family; { ok: false } when it could not be read. */
export type AppliedVersionRead = { ok: true; version: string | null } | { ok: false };

/**
 * GET /api/github/family: the versions of one script already in GitHub.
 *
 * The route's own message is passed on when it sends one: it already says
 * why GitHub could not be read and that the next version can't be worked
 * out until it can.
 */
export async function readFamilyVersions(
  database: string,
  schema: string,
  script: string,
): Promise<FamilyVersionsRead> {
  const query = new URLSearchParams({ database, schema, script });
  try {
    const res = await fetch(`/api/github/family?${query.toString()}`, { cache: "no-store" });
    const data = (await res.json().catch(() => null)) as
      | { ok?: unknown; versions?: unknown; error?: unknown }
      | null;
    if (res.ok && data?.ok === true && Array.isArray(data.versions)) {
      return { ok: true, versions: data.versions.filter((v): v is string => typeof v === "string") };
    }
    return {
      ok: false,
      error:
        typeof data?.error === "string" && data.error.trim() !== ""
          ? data.error
          : `Could not read the versions of "${script}" from GitHub (status ${res.status}). The next version can't be worked out until it can.`,
    };
  } catch {
    return {
      ok: false,
      error: `Could not reach the server to read the versions of "${script}" from GitHub. The next version can't be worked out until it can.`,
    };
  }
}

/**
 * POST /api/scripts/preflight: the highest version of one script applied to
 * the target. Read-only: the route writes nothing to the target.
 *
 * Only a value that looks like a version (digit first, see looksLikeVersion)
 * can raise the floor; anything else, like an outside "init" baseline, counts
 * as none. A leading "v" is dropped, because the screens add it themselves
 * and "vv1.2.0" would be wrong.
 */
export async function readAppliedVersion(
  connectionId: number,
  schemaName: string,
  scriptName: string,
): Promise<AppliedVersionRead> {
  try {
    const res = await fetch("/api/scripts/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId, schemaName, scriptName }),
    });
    const data = (await res.json().catch(() => null)) as { currentVersion?: unknown } | null;
    if (!res.ok || !data) return { ok: false };
    const current = typeof data.currentVersion === "string" ? data.currentVersion : null;
    return { ok: true, version: looksLikeVersion(current) ? current.trim().replace(/^v/i, "") : null };
  } catch {
    return { ok: false };
  }
}
