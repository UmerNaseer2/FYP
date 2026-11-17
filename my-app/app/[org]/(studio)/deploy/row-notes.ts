// The sentences the Deploy page writes under a migration row and in the Roll
// back card: rollback file notes, why a version cannot be rolled back, and the
// wording for SQL that deletes rows. Pure functions and constants.

import { levelOfStep } from "@/lib/versions/script-status";
import {
  checkApplications,
  readAppliesToHeader,
  type TargetApplications,
} from "@/lib/deploy/application-targeting";
import { EXECUTE_CANNOT_BE_READ } from "@/lib/sql/guard";
import { louderChangeType, type ChangeTypeReading } from "@/lib/versions/change-type";
import { vLabel, type RollbackStep } from "@/lib/deploy/rollback-plan";
import type { PulledRollbackState } from "@/lib/github/registry-push";
import type { GitHubScript } from "./types";
import { bumpWord } from "./helpers";

// The "Roll back to" choice that undoes every applied version of the family.
// Not a version number, so it can never collide with one.
export const BEFORE_FIRST = "__before_first__";

export type RowNote = { text: string; warn: boolean };

// How the pull read a version's rollback file (its rollback_state). Not
// lib/github/registry-push's rollbackFileState: that one classifies a file's text,
// this one only reads the answer the pull already worked out. The pull sets
// it on every script; without one, the fallback agrees with the apply body,
// which sends down_sql whenever there is one.
export function pulledRollbackState(script: GitHubScript): PulledRollbackState {
  return script.rollback_state ?? (script.down_sql ? "usable" : "none");
}

/**
 * The short notes under one pending migration in stage 1, in reading order:
 *   1. its SQL is always breaking though its label says less (counted anyway);
 *   2. its version number moves by a different step than its level;
 *   3. whether Deploy will be able to undo it once it is applied.
 * `reading` is describeChangeType of its SQL, which the row has worked out
 * already. `previous` is the version it follows on the target: the pending
 * version before it, or the target's current version for the first one.
 */
export function pendingRowNotes(
  script: GitHubScript,
  reading: ChangeTypeReading,
  previous: string | null,
  applications: TargetApplications
): RowNote[] {
  const notes: RowNote[] = [];
  const v = vLabel(script.version);

  // First, because it is the note that decides whether the rest matters: a
  // script this target is not allowed to run is refused by the apply route,
  // and the reader should see that here rather than after pressing Deploy.
  const verdict = checkApplications(readAppliesToHeader(script.sql_content), applications);
  if (verdict.reason) notes.push({ text: verdict.reason, warn: !verdict.allowed });

  if (reading.louderNote) notes.push({ text: reading.louderNote, warn: true });

  // The level wins everywhere on this page (the pill, the Bump summary, what is
  // recorded), so a version number that says otherwise gets a sentence. It is
  // a warning when the number says more than the level: the reader sees, say,
  // a major version that the breaking checks do not count.
  const step = previous ? levelOfStep(previous, script.version) : null;
  if (previous && step && step !== reading.recorded) {
    const why = reading.declared
      ? `this migration is marked ${reading.recorded}`
      : `its SQL grades as ${reading.recorded}`;
    const uncounted =
      step === "breaking" && !reading.countsAsBreaking
        ? " It is not counted in the breaking checks."
        : "";
    notes.push({
      text:
        `${v} is a ${bumpWord(step)} step from ${vLabel(previous)}, but ${why}, ` +
        `so it is recorded as ${reading.recorded}.${uncounted} ` +
        "Major = breaking, minor = additive, patch = small change.",
      warn: louderChangeType(step, reading.recorded) === step,
    });
  }

  const file = `${v}.down.sql`;
  const state = pulledRollbackState(script);
  if (state === "usable") {
    notes.push({
      text: `Has a rollback (${file}). Deploying saves it with this version, so Deploy can undo it later.`,
      warn: false,
    });
  } else if (state === "none") {
    notes.push({
      text: `No rollback file (${file}) in the registry. Once applied, Deploy can undo it only after one is added in the Script Editor.`,
      warn: false,
    });
  } else if (state === "no_statements") {
    notes.push({
      text: `Its rollback file (${file}) is blank or only comments, so it counts as none. Once applied, Deploy can undo it only after a real one is written in the Script Editor.`,
      warn: false,
    });
  } else if (state === "transaction_control") {
    notes.push({
      text: `Its rollback file (${file}) contains COMMIT or ROLLBACK, so it is not saved with this version and Deploy cannot run it. Remove those statements in the Script Editor.`,
      warn: true,
    });
  } else {
    notes.push({
      text: `Its rollback file (${file}) could not be downloaded, so deploying now does not save it with this version. Reload the page to read it again.`,
      warn: true,
    });
  }
  return notes;
}

/**
 * Why one version in a "Roll back to" plan cannot be undone from Deploy, and
 * what to do about it. `editor` is true when the fix is in the Script Editor,
 * so the panel can link there.
 *
 * A registry rollback that cannot run never reaches planRollback (the pull
 * leaves its text out), so the file's rollback_state is what says why.
 * `registryComplete` is false when the pull could not read part of the
 * registry: then a file that seems to be missing may only be unread.
 */
export function rollbackProblemText(
  step: RollbackStep<GitHubScript>,
  registryComplete: boolean
): { text: string; editor: boolean } {
  const v = vLabel(step.version);
  const file = `${v}.down.sql`;
  const fileState = step.registry ? pulledRollbackState(step.registry) : null;

  if ("problem" in step.resolved && step.resolved.problem === "transaction_control") {
    // The copy saved on the ledger row ends the transaction itself, and the
    // registry has nothing that could run in its place.
    const saved =
      `The rollback saved when ${v} was applied contains COMMIT or ROLLBACK, so it ` +
      "cannot run inside the transaction that protects this rollback.";
    if (fileState === null) {
      return {
        text: registryComplete
          ? `${saved} Run it by hand from a SQL console.`
          : `${saved} Part of the registry could not be read (see the top of the page), so a ${file} that could run instead may be missing. Reload the page to try again, or run it by hand from a SQL console.`,
        editor: false,
      };
    }
    if (fileState === "unreadable") {
      return {
        text: `${saved} ${file} could not be downloaded to run instead. Reload the page to read it again, or run the rollback by hand from a SQL console.`,
        editor: false,
      };
    }
    if (fileState === "transaction_control") {
      return {
        text: `${saved} So does ${file} in the registry. Remove those statements from it in the Script Editor, or run the rollback by hand from a SQL console.`,
        editor: true,
      };
    }
    return {
      text: `${saved} A ${file} without them runs instead: write one in the Script Editor, or run the rollback by hand from a SQL console.`,
      editor: true,
    };
  }

  // No rollback that runs, saved or in the registry.
  if (fileState === null) {
    return {
      text: registryComplete
        ? `${v} has no rollback saved with it and no file in the registry for this schema, so Deploy has nothing to run. Undo it by hand from a SQL console, or fix it forward with a new version.`
        : `${v} has no rollback saved with it, and no ${file} was read from the registry: part of the registry could not be read (see the top of the page). Reload the page to try again.`,
      editor: false,
    };
  }
  if (fileState === "unreadable") {
    return {
      text: `${v} has no rollback saved with it, and ${file} could not be downloaded from GitHub. Reload the page to read it again.`,
      editor: false,
    };
  }
  if (fileState === "transaction_control") {
    return {
      text: `${v} has no rollback saved with it, and ${file} contains COMMIT or ROLLBACK, so it cannot run inside the transaction that protects this rollback. Remove those statements from it in the Script Editor, or run it by hand from a SQL console.`,
      editor: true,
    };
  }
  if (fileState === "no_statements") {
    return {
      text: `${v} has no rollback saved with it, and ${file} is blank or only comments. Write the rollback in the Script Editor, then open Deploy again.`,
      editor: true,
    };
  }
  return {
    text: `${v} has no rollback: none was saved when it was applied, and the registry has no ${file}. Add one in the Script Editor (Add a missing rollback), then open Deploy again.`,
    editor: true,
  };
}

/**
 * The toast after an approval request. Under the auth bypass there is only one
 * principal, so whoever asked is also the one who clears it, unless View as
 * has them looking at the app as a role that may not approve.
 */
/**
 * Splits the kinds the row-loss reader found into the two ways to word them.
 *
 * The reader (findRowDestroyingStatements) names what it found: "TRUNCATE",
 * "DELETE", a DROP. One of its names is "EXECUTE (cannot be read)": a DO block
 * that runs SQL from a string. That SQL may delete rows or may not, so the
 * page must not say that it does.
 *
 *   named   the statements that do delete rows
 *   unread  true when part of the SQL could not be read
 */
export function rowLossKinds(kinds: ReadonlyArray<string>): { named: string[]; unread: boolean } {
  return {
    named: kinds.filter((kind) => kind !== EXECUTE_CANNOT_BE_READ),
    unread: kinds.includes(EXECUTE_CANNOT_BE_READ),
  };
}

/** Said in a row-loss box when part of the SQL could not be read. */
export const UNREAD_SQL_SENTENCE =
  "Part of the SQL could not be read: an EXECUTE inside a DO block runs SQL " +
  "that is put together while it runs. It may delete rows. ";

/** One rollback's line in the row-loss box above a rollback. */
export function rollbackLossSentence(version: string, kinds: ReadonlyArray<string>): string {
  const { named, unread } = rowLossKinds(kinds);
  if (named.length === 0) {
    return `Part of the rollback of ${vLabel(version)} could not be read (an EXECUTE inside a DO block) and may delete rows.`;
  }
  return (
    `The rollback of ${vLabel(version)} contains ${named.join(", ")}.` +
    (unread ? " Part of it could not be read as well and may delete more rows." : "")
  );
}

export const APPROVAL_REQUESTED_TOAST = "Asked for approval. Once an Admin says yes, you can run it";
