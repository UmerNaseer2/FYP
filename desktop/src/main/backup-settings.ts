/**
 * What the Settings window's Backup section is told, as answers the page
 * shows as they are.
 *
 * Each refusal is a sentence for a person, written here rather than in the
 * page, so that the page has no rules of its own to fall out of step with the
 * backup's (src/core/backup-file.ts). Only problems a person can do something
 * about are shown in their own words; anything else is unexpected, so the
 * caller logs it and shows one of the general messages below instead. The
 * page only ever learns a backup's file name, never where the file is.
 */
import {
  BACKUP_EXTENSION,
  BackupFileError,
  MAX_PASSPHRASE_LENGTH,
  passphraseProblem,
  type BackupManifest,
} from "../core/backup-file";
import { BackupError } from "./backup";

export const BACKUP_NOT_SAVED = "Schema Studio could not save the backup. Try again, and if it keeps happening, the logs say why.";
export const BACKUP_NOT_CHECKED = "Schema Studio could not open the backup. Try again, and if it keeps happening, the logs say why.";
export const BACKUP_NOT_CHOSEN =
  "Schema Studio could not show the files to choose from. Try again, and if it keeps happening, the logs say why.";
export const BACKUP_BUSY = "Schema Studio is already working on a backup. Wait for it to finish, then try again.";
export const NOTHING_CHOSEN = "Choose a backup first.";
export const RESTORE_QUESTION = "Restore this backup?";
export const RESTORE_FAILED_TITLE = "Schema Studio could not restore the backup";
export const RESTORE_WENT_WRONG =
  "Something went wrong while restoring the backup, and the logs say what. Press Try again to start Schema Studio again. If the backup went in after all, Schema Studio says so when it opens.";
const NOT_THE_SAME = "The two passphrases are not the same. Type it again in both boxes.";
const TYPE_PASSPHRASE = "Type the passphrase the backup was saved with.";
// True of every problem a restore can report: its rows go in all together or
// not at all (src/main/backup.ts), and the keys and settings only change at
// the next start, once they have.
const NOTHING_CHANGED = "Everything is as it was. Press Try again to go back to Schema Studio.";
const REPLACES =
  "Restoring it replaces everything Schema Studio keeps on this computer, such as the saved connections, the comparison and drift history, the people and their roles, and the GitHub registry, with what the backup holds. Paired phones stay paired, but see no connections until you choose them again in Settings.";
const AFTERWARDS = "Schema Studio then starts again, and you sign in again.";

/** What is wrong with the passphrase for a new backup, typed twice, and which box to fix, or null when it will do. */
export function saveProblem(passphrase: string, repeat: string): { field: "passphrase" | "repeat"; message: string } | null {
  const problem = passphraseProblem(passphrase);
  if (problem !== null) return { field: "passphrase", message: problem };
  // Compared the way the backup's key is made from them, so that two ways of
  // typing the same accented letter count as the same. The length check
  // comes first, so that an absurd amount of text is never normalized.
  const same = repeat.length <= MAX_PASSPHRASE_LENGTH * 4 && repeat.normalize("NFC") === passphrase.normalize("NFC");
  return same ? null : { field: "repeat", message: NOT_THE_SAME };
}

/**
 * What is wrong with the passphrase typed to open a backup, or null when it
 * is worth trying. Only an empty box is refused: a backup must still open if
 * the rules for new passphrases ever change, and the backup itself says when
 * a passphrase is wrong.
 */
export function restoreProblem(passphrase: string): string | null {
  return passphrase.length === 0 ? TYPE_PASSPHRASE : null;
}

/**
 * A problem with a backup that the person can do something about, and the
 * box it is about, or null for anything unexpected. A wrong passphrase is
 * about the passphrase box; nothing else is about a box.
 */
export function backupFailure(error: unknown): { field: "passphrase" | null; message: string } | null {
  if (!(error instanceof BackupError)) return null;
  const wrongPassphrase = error.cause instanceof BackupFileError && error.cause.problem === "wrong-passphrase";
  return { field: wrongPassphrase ? "passphrase" : null, message: error.message };
}

/**
 * The file a backup is saved in, ending in .ssbackup. The file dialog on
 * Ubuntu saves under exactly the name typed, and the ending is what the
 * dialog for choosing a backup looks for.
 */
export function withBackupExtension(file: string): string {
  return file.toLowerCase().endsWith(`.${BACKUP_EXTENSION}`) ? file : `${file}.${BACKUP_EXTENSION}`;
}

/**
 * Said when the ending was added to the name typed and a file of that name
 * is already there: the file dialog only asked about replacing the name as
 * typed, so the person never agreed to replace this one.
 */
export function nameTaken(fileName: string): string {
  return `There is already a file called ${fileName} there. Choose another name, then try again.`;
}

/** The question asked before a backup is restored, with what it holds and what restoring it does. */
export function restoreQuestion(manifest: Pick<BackupManifest, "appVersion" | "createdAt">): { message: string; detail: string } {
  const saved = new Date(manifest.createdAt);
  // A manifest's date is checked when it is read, so this is only a guard.
  const made = Number.isNaN(saved.getTime())
    ? `This backup was saved by Schema Studio ${manifest.appVersion}.`
    : `This backup was saved on ${saved.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })} by Schema Studio ${manifest.appVersion}.`;
  return { message: RESTORE_QUESTION, detail: [made, REPLACES, AFTERWARDS].join("\n\n") };
}

/** What the start screen says when a restore under way fails. */
export function restoreFailure(error: unknown): string {
  const failure = backupFailure(error);
  return failure === null ? RESTORE_WENT_WRONG : `${failure.message} ${NOTHING_CHANGED}`;
}
