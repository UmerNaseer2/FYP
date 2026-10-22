/**
 * Writing a file so that a crash or a power cut never leaves half of it.
 *
 * The new contents go into a temporary file beside the real one and are
 * forced onto the disk. Only then does the temporary file take the real one's
 * place, in a single rename the operating system does all at once. Whatever
 * happens, the file holds the old contents or the new ones, never a mix, and
 * never an empty file where the settings or secrets used to be.
 *
 * Tested in src/test/atomic-file.test.ts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** ".config.json.1234.0a1b2c3d4e5f.tmp": the file name, the process id, a random part. */
const TEMP_NAME = /^\..+\.(\d+)\.[0-9a-f]{12}\.tmp$/;

export function writeFileAtomic(file: string, data: string | Buffer, mode = 0o600): void {
  const dir = path.dirname(file);
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );

  // "wx" refuses to open a file that is already there, so nothing planted
  // under the temporary name is ever written through.
  let fd: number | null = fs.openSync(temp, "wx", mode);
  try {
    // The mode given to openSync is reduced by the umask; this sets it exactly.
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already failing; the original error is the one worth reporting.
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // Nothing left to tidy.
    }
    throw error;
  }

  // The rename is written down in the folder itself, so the folder is forced
  // onto the disk too. Some file systems cannot do that for a folder; the file
  // is already complete there, so this is best effort.
  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // See above.
  }
}

/** The file's text, or null when there is no such file. Any other failure is thrown. */
export function readFileIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Removes temporary files a crash left behind in `dir`. Only names this module
 * makes are touched, and never one belonging to this run of the app.
 */
export function removeStaleTempFiles(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = TEMP_NAME.exec(name);
    if (!match || Number(match[1]) === process.pid) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // Gone already, or not ours to remove; either way, nothing to do.
    }
  }
}
