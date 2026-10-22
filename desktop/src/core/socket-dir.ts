/**
 * Where the app's own PostgreSQL puts its socket, the special file the server
 * and the app talk through.
 *
 * The app's database never listens on the network, not even on this
 * computer's own address. It answers only on a unix socket inside a folder
 * that nobody else can open, and before letting anyone in, PostgreSQL asks the
 * operating system who is on the other end ("peer" authentication). Nobody
 * else on the computer can reach it, and there is no password to steal.
 *
 * A socket's full path has a hard length limit (108 bytes on Linux, 104 on
 * macOS, each counting a final zero byte), so the folder must be short enough.
 * The first of these that fits is used:
 *
 *  1. $XDG_RUNTIME_DIR/schema-studio: the per-login folder Ubuntu keeps in
 *     memory (/run/user/1000) and empties at log out;
 *  2. <data folder>/run, when the home folder's path is short enough;
 *  3. /tmp/schema-studio-<user id>, as a last resort.
 *
 * Pure: the caller says whether the runtime folder exists, and makes and
 * checks the folder it picks (src/core/private-dir.ts). Tested in
 * src/test/socket-dir.test.ts.
 */
import path from "node:path";

/** The file PostgreSQL makes inside the folder for its port 5432. */
export const SOCKET_FILE = ".s.PGSQL.5432";

/** The longest socket path this platform accepts, in bytes. */
export function socketPathLimit(platform: NodeJS.Platform): number {
  return platform === "darwin" ? 103 : 107;
}

/**
 * True when PostgreSQL and the app can both use this folder for the socket.
 *
 * PostgreSQL reads its socket folder setting as a comma-separated list, and
 * the app passes the folder inside double quotes so that a comma in a home
 * folder's name does no harm. A double quote of its own, or an invisible
 * control character, could still break out of that, so either one rules a
 * folder out.
 */
export function isUsableSocketDir(dir: string, limit: number): boolean {
  if (!path.isAbsolute(dir)) return false;
  if (/["\u0000-\u001f\u007f]/.test(dir)) return false;
  return Buffer.byteLength(path.join(dir, SOCKET_FILE)) <= limit;
}

export type SocketDirInput = {
  platform: NodeJS.Platform;
  /** $XDG_RUNTIME_DIR, when it is set. */
  runtimeDir: string | undefined;
  /** Whether that folder exists. Ubuntu makes it at log in; a bare shell may not have one. */
  runtimeDirExists: boolean;
  /** The app's data folder, ~/.local/share/schema-studio. */
  dataDir: string;
  /** This person's user id, which keeps the /tmp folder theirs alone. */
  uid: number;
};

/** The folders to try, best first, leaving out any the socket would not fit in. */
export function socketDirCandidates(input: SocketDirInput): string[] {
  const candidates: string[] = [];
  if (input.runtimeDir && path.isAbsolute(input.runtimeDir) && input.runtimeDirExists) {
    candidates.push(path.join(input.runtimeDir, "schema-studio"));
  }
  candidates.push(path.join(input.dataDir, "run"));
  candidates.push(`/tmp/schema-studio-${input.uid}`);
  const limit = socketPathLimit(input.platform);
  return candidates.filter((dir) => isUsableSocketDir(dir, limit));
}
