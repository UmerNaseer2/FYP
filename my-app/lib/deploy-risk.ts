// What a deploy run risks, read from its SQL, and the forward-only rule.
//
// Pure on purpose (no database, no fetch, no React). The Deploy page, Version
// Sync, the apply route and the approvals route all call these, so the boxes a
// screen asks the operator to tick, the breaking count an approver is shown,
// and the refusal the server sends all come from one reading of the same SQL.
// Before this module each of them read the SQL its own way, and the server
// trusted whatever the page said.
//
// The ranking of change levels is not here: it lives in lib/change-type.ts,
// and this module only asks it which of two levels is louder.
import { describeChangeType, isScriptChangeType, louderChangeType, type ScriptChangeType } from "./change-type";
import { vLabel } from "./rollback-plan";
import { compareVersions, highestVersion, looksLikeVersion, versionKey } from "./script-status";
import { extractEnumAddValues, findMightFailStatements, findRowDestroyingStatements } from "./sql-guard";

/** One migration in a run, as the risk checks read it. */
export type RiskScript = {
  scriptName: string;
  version: string;
  sqlContent: string;
  /**
   * The level the caller sent with the script (the apply body's change_type).
   * Only "breaking", "additive" or "patch" counts. Anything else, "unknown"
   * included, is ignored.
   */
  changeType?: unknown;
};

/**
 * "users_migration v2.0.0". The one way a script is named in these messages.
 * A legacy version that is not a number at all ("unknown") is quoted instead,
 * so it never reads "vunknown".
 */
export function scriptLabel(scriptName: string, version: string): string {
  return looksLikeVersion(version) ? `${scriptName} ${vLabel(version)}` : `${scriptName} "${version}"`;
}

/**
 * "a", "a and b", "a, b and c". Past five names it says how many more, so a
 * refusal for a long run stays readable.
 */
export function listLabels(labels: ReadonlyArray<string>): string {
  const shown = labels.slice(0, 5);
  const hidden = labels.length - shown.length;
  if (hidden > 0) return `${shown.join(", ")} and ${hidden} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

// ─── One script's level ─────────────────────────────────────────────────────

/** How one script's level is read. */
export type ScriptLevel = {
  /** The level to store in script_patch.change_type and hand to lineage. */
  stored: ScriptChangeType;
  /** Whether the script counts in the breaking checks. */
  breaking: boolean;
  /** describeChangeType's note when the SQL is louder than its stamp, else null. Shown next to the script. */
  louderNote: string | null;
};

/**
 * The one rule for a script's level when a caller also sent one.
 *
 * describeChangeType decides from the SQL and its stamp. A level the caller
 * sent can make the script louder but never quieter:
 * - it counts as breaking when describeChangeType says so, OR the caller sent
 *   "breaking";
 * - the level stored is the louder of describeChangeType's recorded level and
 *   the caller's. A caller that sends "additive" over a script stamped
 *   breaking still stores "breaking", so the version ledger and Version Sync
 *   never read a change as smaller than it is.
 */
export function readScriptLevel(script: Pick<RiskScript, "sqlContent" | "changeType">): ScriptLevel {
  const reading = describeChangeType(script.sqlContent);
  const supplied = isScriptChangeType(script.changeType) ? script.changeType : null;
  return {
    stored: supplied ? louderChangeType(reading.recorded, supplied) : reading.recorded,
    breaking: reading.countsAsBreaking || supplied === "breaking",
    louderNote: reading.louderNote,
  };
}

// ─── A whole run ────────────────────────────────────────────────────────────

/** One script named in a risk list. */
export type RiskEntry = {
  /** "users_migration v2.0.0", for messages. */
  label: string;
  scriptName: string;
  /** The version exactly as the caller sent it. */
  version: string;
};

/** Everything a run risks, script by script, in run order. */
export type RunRisk = {
  /**
   * The breaking scripts. louderNote is set when the script's stamp says less
   * than its SQL, which is why it is in this list at all.
   */
  breaking: (RiskEntry & { louderNote: string | null })[];
  /**
   * The scripts that delete rows, with the statements that do it
   * ("DROP COLUMN", "TRUNCATE"). A rollback cannot bring those rows back.
   */
  dataLoss: (RiskEntry & { kinds: string[] })[];
  /**
   * The scripts with a statement the rows already in a table can refuse, such
   * as a NOT NULL column with no default. Warned about, never gated: the run
   * is one transaction, so a failure changes nothing.
   */
  mightFail: (RiskEntry & { kinds: string[] })[];
  /**
   * The enum values the run adds. A real apply commits them before its
   * transaction opens, so a failed run leaves them behind.
   */
  enumAdditions: string[];
};

/**
 * Read a run's risks. Every reader of "is this run breaking, does it delete
 * rows" calls this, so they cannot disagree.
 *
 * Each check reads code only: a DROP inside a comment (the way safe mode
 * leaves a destructive statement for a person to review) is not a statement,
 * so it neither deletes rows nor makes the script breaking.
 */
export function analyseRunRisk(scripts: ReadonlyArray<RiskScript>): RunRisk {
  const risk: RunRisk = { breaking: [], dataLoss: [], mightFail: [], enumAdditions: [] };

  for (const script of scripts) {
    const entry: RiskEntry = {
      label: scriptLabel(script.scriptName, script.version),
      scriptName: script.scriptName,
      version: script.version,
    };

    const level = readScriptLevel(script);
    if (level.breaking) risk.breaking.push({ ...entry, louderNote: level.louderNote });

    const deletes = findRowDestroyingStatements(script.sqlContent);
    if (deletes.length > 0) risk.dataLoss.push({ ...entry, kinds: deletes });

    const mightFail = findMightFailStatements(script.sqlContent);
    if (mightFail.length > 0) risk.mightFail.push({ ...entry, kinds: mightFail });
  }

  // Read across the whole run, the way the apply route hoists them: a value
  // added by one script can be used by a later one.
  risk.enumAdditions = extractEnumAddValues(scripts.map((script) => script.sqlContent).join("\n"));
  return risk;
}

// ─── Forward only ───────────────────────────────────────────────────────────

/** Why one job in a run cannot run. */
export type ForwardOnlyProblem = {
  /** Which job in the run (0-based). */
  index: number;
  /** The whole refusal, for the card. Ends "Nothing ran." */
  message: string;
  /** A few words for that job's own row in the results. */
  reason: string;
};

/**
 * The forward-only rule: each version of a script must be strictly above every
 * version of that script already applied, and above every earlier version of it
 * in the same run. Returns the first job that breaks the rule, or null.
 *
 * `appliedByFamily` is the target's script_patch versions, keyed by script
 * name. Pass {} to check only the order within the run.
 *
 * Versions compare the way everything else compares them (compareVersions), so
 * "1.2" and "1.2.0" are the same version. A ledger row that is not a version
 * at all (a legacy "unknown") counts as 0.0.0: it matches nothing and blocks
 * nothing.
 */
export function checkForwardOnly(
  queue: ReadonlyArray<{ scriptName: string; version: string }>,
  appliedByFamily: Readonly<Record<string, ReadonlyArray<string>>>
): ForwardOnlyProblem | null {
  // The highest version met so far in this run, per script.
  const runMark = new Map<string, string>();

  for (let index = 0; index < queue.length; index++) {
    const { scriptName, version } = queue[index];
    const label = scriptLabel(scriptName, version);
    const applied = (appliedByFamily[scriptName] ?? []).filter(looksLikeVersion);

    // The same version, however it is spelled, is already in the ledger.
    const recorded = applied.find((row) => versionKey(row) === versionKey(version));
    if (recorded !== undefined) {
      return {
        index,
        reason: "Already applied to this schema.",
        message:
          `${label} is already applied (recorded as "${recorded}"). ` +
          "Refresh Pre-flight to see what is pending now. Nothing ran.",
      };
    }

    // A higher version is applied, so this one would run under structure a
    // later version has already changed. Checked before the run's own order,
    // because re-ordering the run cannot fix this one.
    const highestApplied = highestVersion(applied);
    if (highestApplied !== null && compareVersions(version, highestApplied) < 0) {
      return {
        index,
        reason: "A higher version is already applied.",
        message:
          `${label} cannot run: ${vLabel(highestApplied)} is already applied and deploys only ` +
          "move forward. Refresh Pre-flight to see what is pending now. Nothing ran.",
      };
    }

    const earlier = runMark.get(scriptName);
    if (earlier !== undefined && compareVersions(version, earlier) === 0) {
      return {
        index,
        reason: "Listed twice in this run.",
        message:
          `${label} is listed twice in this run (also as ${vLabel(earlier)}), and each version ` +
          "can run only once. If the registry holds both files, delete one of them, then run " +
          "again. Nothing ran.",
      };
    }
    if (earlier !== undefined && compareVersions(version, earlier) < 0) {
      return {
        index,
        reason: "Out of order in this run.",
        message:
          `${label} is listed after ${vLabel(earlier)} in this run. Versions of one script must ` +
          "run in ascending order. Nothing ran.",
      };
    }
    runMark.set(scriptName, version);
  }

  return null;
}
