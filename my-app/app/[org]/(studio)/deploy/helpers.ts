// Small pure helpers for the Deploy page: sorting and naming scripts, short
// formatters, the version timeline status of a ledger entry, and the text an
// approval or a rehearsal is compared by. No React and no state in here.

import { compareVersions, versionKey, type LedgerEntry } from "@/lib/versions/script-status";
import { describeChangeType, type ScriptChangeType } from "@/lib/versions/change-type";
import { fingerprintBody } from "@/lib/deploy/approval-fingerprint";
import { listVersions, versionRange } from "@/lib/deploy/rollback-plan";
import type { TimelineStatus } from "@/lib/versions/timeline";
import { shortUtcDate } from "@/lib/ui/format-date";
import type { ChangeKind, GitHubScript, RevertedEntry } from "./types";

// The change_type this page sends with a migration, to the apply route and to
// the approvals route: its stamp when it has one, its SQL's grade otherwise.
// The page's own risk reading (runRisk) is given the same value, so the boxes
// on this page and the server's checks read every migration the same way.
export function changeTypeSent(sql: string): ScriptChangeType {
  return describeChangeType(sql).recorded;
}

// Version comparison + the Applied/Pending ledger live in lib/versions/script-status so
// they can be unit-tested in isolation; compareVersions is imported above.
export function sortGitHubScriptsByVersion(scripts: GitHubScript[]): GitHubScript[] {
  return [...scripts].sort((a, b) => compareVersions(a.version, b.version));
}

// Stable unique key, must include schema_name because two schemas can hold the
// same script_name@version pair.
export function scriptKey(s: GitHubScript): string {
  return `${s.schema_name}@${s.script_name}@${s.version}`;
}

export function getSqlLineCount(sql: string): number {
  return sql.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

// The version bump a change kind implies, used for the "bump" summary.
export function bumpWord(kind: ChangeKind): "major" | "minor" | "patch" {
  if (kind === "breaking") return "major";
  if (kind === "additive") return "minor";
  return "patch";
}

// The COMMIT/ROLLBACK pre-flight check uses the SAME helper as the server apply
// route (lib/sql/guard), so the advisory warning here can never disagree with
// what the route actually rejects, including the dollar-quoted-body handling.

// "1 statement" / "4 statements": the count PostgreSQL reported for one script.
export function fmtStatements(n: number): string {
  return `${n} statement${n === 1 ? "" : "s"}`;
}

export function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// Short, safe date for the ledger's applied rows: the UTC day, the same day
// the version timeline on this screen shows for the same row. Returns "" for a
// missing or unparseable timestamp rather than "Invalid Date".
export function fmtDate(iso: string | null): string {
  return shortUtcDate(iso);
}

// Applied / Pending / Skipped (the version ledger, lib/versions/script-status) → the
// "This database" status in the version timeline.
//
// - `current` is the version applied to the target ("v5.0.2"). A skipped
//   version's tooltip names it, so the reason it will not run is one hover
//   away.
// - `rolledBack` is the version's latest rollback, given only when it is not
//   applied now. The status then says when it was rolled back, so "Pending"
//   is not read as "never deployed". The status word stays Pending or
//   Skipped, because that word is what a deploy will do with it.
// - `pullWarned` says part of the registry could not be read. That is a
//   second reason an applied version can have no registry file.
export function ledgerStatus(
  entry: LedgerEntry,
  rolledBack: RevertedEntry | null,
  current: string,
  pullWarned: boolean
): TimelineStatus {
  if (entry.status === "applied") {
    if (entry.inRegistry) return { text: "Applied", tone: "applied" };
    return {
      text: "Applied · no registry file",
      tone: "applied",
      title: pullWarned
        ? "Applied to this database, but the registry has no file for it: applied directly, " +
          "replayed here by Version Sync, or its file could not be read (see the top of the page)."
        : "Applied to this database, but the registry has no file for it: applied directly, " +
          "or replayed here by Version Sync.",
    };
  }
  // " · rolled back 3 Sep 2026", or without the date when it is unreadable.
  const undone = rolledBack ? fmtDate(rolledBack.reverted_at) : "";
  const note = rolledBack ? ` · rolled back${undone ? ` ${undone}` : ""}` : "";
  if (entry.status === "pending") {
    return {
      text: `Pending${note}`,
      tone: "pending",
      title: rolledBack
        ? rolledBackTitle(rolledBack, "pending", current)
        : "Not applied to this database yet. A deploy that includes it runs it.",
    };
  }
  return {
    text: `Skipped${note}`,
    tone: "skipped",
    title: rolledBack
      ? rolledBackTitle(rolledBack, "skipped", current)
      : `Never applied, and below ${current}, the version applied to the target. ` +
        "Deploys only move forward, so this version will not run.",
  };
}

// The note above the version timeline that explains its Skipped rows: what
// happened, that a deploy will not run them, and how to still ship the change
// (the Script Editor saves a change as the family's next version, above the
// version applied to the target).
export function skippedNote(skipped: ReadonlyArray<string>, current: string): string {
  if (skipped.length === 1) {
    return (
      `Skipped: ${listVersions(skipped)} was never applied and is below ${current}, ` +
      `the version applied to the target. Deploys only move forward, so it will not run. ` +
      `If its change is still needed, save it in the Script Editor as a new version above ${current}.`
    );
  }
  return (
    `Skipped: ${listVersions(skipped)} were never applied and are below ${current}, ` +
    `the version applied to the target. Deploys only move forward, so they will not run. ` +
    `If their changes are still needed, save them in the Script Editor as new versions above ${current}.`
  );
}

// Tooltip for "rolled back <date>" on a version that is not applied now: when
// it ran, when it was undone, and whether a deploy would run it again. A
// pending version is in the next deploy's list; a skipped one is below the
// target's version, and deploys only move forward.
export function rolledBackTitle(row: RevertedEntry, status: LedgerEntry["status"], current: string): string {
  const applied = fmtDate(row.applied_at);
  const undone = fmtDate(row.reverted_at);
  const history =
    (applied ? `Applied ${applied}, then rolled back` : "Rolled back") +
    (undone ? ` ${undone}` : "") +
    ", so it is not applied now.";
  return status === "pending"
    ? `${history} A deploy that includes it runs it again.`
    : `${history} It is below ${current}, the version applied to the target, so a deploy will not run it again.`;
}

// The text an approval of this batch is hashed from (lib/deploy/approval-fingerprint,
// the same text the server hashes). The rehearsal pin and the recovery bar
// compare these strings directly: equal text means the same scripts, in the
// same order, with the same SQL, so no hashing is needed to tell.
export function batchBody(scripts: ReadonlyArray<GitHubScript>): string {
  return fingerprintBody(
    scripts.map((s) => ({ scriptName: s.script_name, version: s.version, sqlContent: s.sql_content }))
  );
}

// How the selected batch differs from one that already ran (a rehearsal, or
// the run on screen), so the page can say why that run no longer speaks for
// the selection. null when it still does (the same body).
// - "nothing": nothing is selected now (a re-read found it all applied).
// - "scripts": the same versions, but the SQL changed (a re-pull).
// - "range":   a different set of versions.
export type SelectionChange = "nothing" | "range" | "scripts";
export function selectionChange(
  ranBody: string | null,
  ran: ReadonlyArray<GitHubScript>,
  selected: ReadonlyArray<GitHubScript>,
  selectedBody: string
): SelectionChange | null {
  if (ranBody !== null && ranBody === selectedBody) return null;
  if (selected.length === 0) return "nothing";
  const sameVersions =
    ran.length === selected.length &&
    ran.every((s, i) => versionKey(s.version) === versionKey(selected[i].version));
  return sameVersions ? "scripts" : "range";
}

// Names for two different runs of one family, so a sentence that sets them
// side by side never prints the same words twice. The range reads
// "v5.0.1 → v6.0.0". If the ranges read the same, the counts tell them apart
// ("(3)" and "(2)" when a version between them was added or removed). Failing
// that, every version is listed.
export function nameTwoRuns(ran: ReadonlyArray<string>, now: ReadonlyArray<string>): [string, string] {
  const a = versionRange(ran);
  const b = versionRange(now);
  if (a !== b) return [a, b];
  if (ran.length !== now.length) return [`${a} (${ran.length})`, `${b} (${now.length})`];
  return [listVersions(ran), listVersions(now)];
}
