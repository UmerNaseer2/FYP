/**
 * Makes a folder only this person can open, or refuses one that somebody else
 * could have set up.
 *
 * The app's database files, its socket and its secrets all live in folders
 * like this. Each is checked at every start, not only when it is first made,
 * because a folder that is already there may not be one the app made:
 *
 *  - It must be a real folder, not a link to somewhere else. Anyone can write
 *    in /tmp, so another user could leave a link there hoping the app puts its
 *    socket where they can reach it.
 *  - It must belong to the person running the app.
 *  - Nobody else may read or enter it (permissions 0700). The app tightens a
 *    looser folder itself, since only its owner could have loosened it.
 *
 * Tested in src/test/private-dir.test.ts.
 */
import fs from "node:fs";

/** A folder the app will not keep its files in. The message says what to do. */
export class UnsafeDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDirError";
  }
}

function lstatOrNull(dir: string): fs.Stats | null {
  try {
    return fs.lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function ensurePrivateDir(dir: string): void {
  // Missing folders on the way are made 0700 too, as the XDG base directory
  // rules ask for ~/.local/share and the others.
  if (lstatOrNull(dir) === null) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Checked after making it as well: something could have appeared in between.
  const stat = lstatOrNull(dir);
  if (stat === null) {
    throw new UnsafeDirError(`Schema Studio could not make the folder ${dir}.`);
  }
  if (stat.isSymbolicLink()) {
    throw new UnsafeDirError(
      `${dir} is a link to somewhere else rather than a folder. Move it out of the way and open Schema Studio again.`,
    );
  }
  if (!stat.isDirectory()) {
    throw new UnsafeDirError(
      `${dir} is a file rather than a folder. Move it out of the way and open Schema Studio again.`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new UnsafeDirError(
      `${dir} belongs to another user on this computer, so Schema Studio will not keep its files there. Have it removed, then open Schema Studio again.`,
    );
  }
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}
