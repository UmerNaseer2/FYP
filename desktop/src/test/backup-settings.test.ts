/**
 * What Settings' Backup section is told (src/main/backup-settings.ts): which
 * box a problem is about, the file a backup is saved in, the question asked
 * before a restore, and what the start screen says when one fails.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BackupFileError, MAX_PASSPHRASE_LENGTH, MIN_PASSPHRASE_LENGTH, passphraseProblem } from "../core/backup-file";
import { BackupError } from "../main/backup";
import {
  backupFailure,
  nameTaken,
  RESTORE_QUESTION,
  RESTORE_WENT_WRONG,
  restoreFailure,
  restoreProblem,
  restoreQuestion,
  saveProblem,
  withBackupExtension,
} from "../main/backup-settings";

// Made here rather than written out, so that nothing in the tests looks like a real passphrase.
const PASSPHRASE = "word ".repeat(4).trim();

/** A problem the backup itself reports, wrapped the way src/main/backup.ts passes it on. */
function fileProblem(problem: ConstructorParameters<typeof BackupFileError>[0]): BackupError {
  const cause = new BackupFileError(problem);
  return new BackupError(cause.message, { cause });
}

test("a new backup's passphrase follows the backup's own rules, in the passphrase box", () => {
  const short = "x".repeat(MIN_PASSPHRASE_LENGTH - 1);
  assert.deepEqual(saveProblem(short, short), { field: "passphrase", message: passphraseProblem(short) });
  const long = "x".repeat(MAX_PASSPHRASE_LENGTH + 1);
  assert.deepEqual(saveProblem(long, long), { field: "passphrase", message: passphraseProblem(long) });
});

test("a new backup's passphrase must be typed the same twice, and a difference is about the second box", () => {
  assert.equal(saveProblem(PASSPHRASE, PASSPHRASE), null);
  for (const repeat of ["", `${PASSPHRASE} `, PASSPHRASE.toUpperCase(), "x".repeat(MAX_PASSPHRASE_LENGTH * 4 + 1)]) {
    const problem = saveProblem(PASSPHRASE, repeat);
    if (problem === null) throw new Error(`Expected a problem with the repeat ${JSON.stringify(repeat.slice(0, 20))}, but there was none.`);
    assert.equal(problem.field, "repeat");
    assert.match(problem.message, /^The two passphrases are not the same\./);
  }
  // The passphrase is checked first, so a short one that is typed differently is about the first box.
  assert.equal(saveProblem("short", "other")?.field, "passphrase");
});

test("two ways of typing the same accented letter count as the same passphrase", () => {
  const composed = PASSPHRASE + String.fromCharCode(0xe9);
  const decomposed = PASSPHRASE + String.fromCharCode(0x65, 0x301);
  assert.notEqual(composed, decomposed);
  assert.equal(saveProblem(composed, decomposed), null);
  assert.equal(saveProblem(decomposed, composed), null);
});

test("a backup's passphrase is only refused before trying it when the box is empty", () => {
  assert.equal(restoreProblem(""), "Type the passphrase the backup was saved with.");
  // Shorter than a new backup may have, since the rules for new ones may change.
  assert.equal(restoreProblem("x"), null);
  assert.equal(restoreProblem(PASSPHRASE), null);
});

test("a wrong passphrase is about the passphrase box, and other backup problems about no box", () => {
  assert.deepEqual(backupFailure(fileProblem("wrong-passphrase")), {
    field: "passphrase",
    message: "The passphrase does not open this backup. Check it, then try again.",
  });
  for (const problem of ["not-a-backup", "newer", "damaged", "does-not-fit"] as const) {
    assert.deepEqual(backupFailure(fileProblem(problem)), { field: null, message: new BackupFileError(problem).message });
  }
  const own = "Schema Studio cannot find that file anymore. Choose it again.";
  assert.deepEqual(backupFailure(new BackupError(own)), { field: null, message: own });
});

test("anything that is not a backup problem is unexpected, so its words are never shown", () => {
  for (const error of [new Error("connect ECONNREFUSED /tmp/.s.PGSQL.5432"), new BackupFileError("damaged"), "text", null, undefined]) {
    assert.equal(backupFailure(error), null);
  }
});

test("a backup is saved in a file ending in .ssbackup", () => {
  assert.equal(withBackupExtension("/home/sam/Documents/monday"), "/home/sam/Documents/monday.ssbackup");
  assert.equal(withBackupExtension("/home/sam/monday.ssbackup"), "/home/sam/monday.ssbackup");
  assert.equal(withBackupExtension("/home/sam/MONDAY.SSBACKUP"), "/home/sam/MONDAY.SSBACKUP");
  assert.equal(withBackupExtension("/home/sam/monday.ssbackup.old"), "/home/sam/monday.ssbackup.old.ssbackup");
  assert.equal(withBackupExtension("/home/sam/monday.backup"), "/home/sam/monday.backup.ssbackup");
  assert.equal(
    nameTaken("monday.ssbackup"),
    "There is already a file called monday.ssbackup there. Choose another name, then try again.",
  );
});

test("the question before a restore says when the backup was saved, by which version, and what restoring does", () => {
  const createdAt = "2026-10-24T09:30:00.000Z";
  const question = restoreQuestion({ appVersion: "2.0.0", createdAt });
  assert.equal(question.message, RESTORE_QUESTION);
  const parts = question.detail.split("\n\n");
  assert.equal(parts.length, 3);
  const when = new Date(createdAt).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
  assert.equal(parts[0], `This backup was saved on ${when} by Schema Studio 2.0.0.`);
  assert.match(parts[1], /^Restoring it replaces everything Schema Studio keeps on this computer/);
  assert.match(parts[1], /Paired phones stay paired/);
  assert.equal(parts[2], "Schema Studio then starts again, and you sign in again.");
  assert.equal(
    restoreQuestion({ appVersion: "2.0.0", createdAt: "not a date" }).detail.split("\n\n")[0],
    "This backup was saved by Schema Studio 2.0.0.",
  );
});

test("a restore that fails says why and that nothing changed, or that the logs say what went wrong", () => {
  assert.equal(
    restoreFailure(fileProblem("does-not-fit")),
    "This backup does not fit this version of Schema Studio, so it cannot be restored. Everything is as it was. Press Try again to go back to Schema Studio.",
  );
  assert.equal(restoreFailure(new Error("Connection terminated unexpectedly")), RESTORE_WENT_WRONG);
  assert.match(RESTORE_WENT_WRONG, /Press Try again/);
});
