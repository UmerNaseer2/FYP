/**
 * The pure half of the app's own PostgreSQL: the commands that set it up and
 * start it, the two small files that decide who may connect, and reading the
 * files PostgreSQL leaves in its data folder.
 *
 * The app ships PostgreSQL 17 inside the package and keeps the database in
 * ~/.local/share/schema-studio/postgres/data. That database holds what the web
 * version keeps on its server: saved connections, comparison history, users
 * and their roles. src/main/postgres.ts runs the programs; everything here is
 * text in, text out, and tested in src/test/postgres-files.test.ts.
 */

/** The PostgreSQL major version the app ships. A data folder made by another cannot be opened. */
export const PG_MAJOR = 17;

/** The database user, and the database the web app's tables go in. */
export const DB_USER = "schema_studio";
export const DB_NAME = "schema_studio";

/** PostgreSQL's port number. It is never opened on the network; it only names the socket file. */
export const PG_PORT = 5432;

/**
 * The arguments for initdb, which makes a new, empty database folder.
 *
 *  - The first user is the app's own, schema_studio, not "postgres".
 *  - Text sorts with ICU's language-neutral rules ("und"), close to what the
 *    web version's server does: names in lists come out in dictionary order,
 *    with "apple" next to "Apple", not every capital first. ICU is part of
 *    the bundled PostgreSQL, so the order does not depend on which languages
 *    this computer has installed.
 *  - Nobody can connect over the network ("reject"), and on the socket,
 *    PostgreSQL asks the operating system who is connecting ("peer").
 *  - Checksums let PostgreSQL notice a damaged disk instead of reading
 *    garbage from it.
 */
export function initdbArgs(dataDir: string): string[] {
  return [
    "-D",
    dataDir,
    "-U",
    DB_USER,
    "-E",
    "UTF8",
    "--locale=C",
    "--locale-provider=icu",
    "--icu-locale=und",
    "--auth-local=peer",
    "--auth-host=reject",
    "--data-checksums",
    "--no-instructions",
  ];
}

/**
 * The arguments for a second try at initdb, used only when the first one
 * fails: the same database, but sorting text with PostgreSQL's own built-in
 * C.UTF-8 rules instead of ICU's.
 *
 * ICU needs its data file, which comes with the bundled PostgreSQL. If that
 * cannot be loaded on some unusual system, a database that sorts a little
 * more plainly is far better than none: capitals come before small letters
 * ("Zebra" before "apple"), but changing case and matching letters still
 * follow Unicode, so every language works. The built-in sort order never
 * changes, so a database made this way never needs its indexes rebuilt.
 */
export function initdbFallbackArgs(dataDir: string): string[] {
  const withoutIcu = initdbArgs(dataDir).filter(
    (arg) => arg !== "--locale-provider=icu" && arg !== "--icu-locale=und",
  );
  return [...withoutIcu, "--locale-provider=builtin", "--builtin-locale=C.UTF-8"];
}

/**
 * The arguments for the server itself.
 *
 * `listen_addresses` is empty, so the server opens no network port at all,
 * and the socket lands in `socketDir` (see src/core/socket-dir.ts), readable
 * only by this person. The folder is quoted because PostgreSQL reads the
 * setting as a comma-separated list. Twenty connections is plenty for one
 * person's app and keeps the memory it reserves small.
 */
export function postgresArgs(dataDir: string, socketDir: string): string[] {
  return [
    "-D",
    dataDir,
    "-c",
    "listen_addresses=",
    "-c",
    `unix_socket_directories="${socketDir}"`,
    "-c",
    "unix_socket_permissions=0700",
    "-c",
    `port=${PG_PORT}`,
    "-c",
    "max_connections=20",
    "-c",
    "lc_messages=C",
  ];
}

/**
 * True when `name` can be written into pg_ident.conf safely.
 *
 * The name goes in double quotes, so it may contain spaces, dots or an @ (as
 * names from a company directory often do). It must not contain a double
 * quote or a control character, which would end the quoted name early, and
 * must not start with a slash, which pg_ident.conf reads as a pattern.
 */
export function validOsUser(name: string): boolean {
  return name.length > 0 && !/["\u0000-\u001f\u007f]/.test(name) && !name.startsWith("/");
}

const WRITTEN_BY_APP =
  "# Written by Schema Studio each time it starts. Changes made here are replaced.\n";

/**
 * pg_hba.conf: who may connect, and how. One line: the app's user, on the
 * socket only, vouched for by the operating system through the "studio" map
 * in pg_ident.conf.
 */
export function pgHbaConf(): string {
  return (
    WRITTEN_BY_APP +
    "# The database answers only on a private socket (there is no network\n" +
    "# address), and only to the person this app runs as.\n" +
    `local all ${DB_USER} peer map=studio\n`
  );
}

/** pg_ident.conf: this computer's user `osUser` may connect as the app's database user. */
export function pgIdentConf(osUser: string): string {
  if (!validOsUser(osUser)) {
    throw new Error(`The user name ${JSON.stringify(osUser)} cannot be used for the database.`);
  }
  return WRITTEN_BY_APP + `studio "${osUser}" ${DB_USER}\n`;
}

/** The major version in a data folder's PG_VERSION file, or null when it is not a number. */
export function parsePgVersion(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/**
 * Reads postmaster.pid, the file a running PostgreSQL keeps in its data
 * folder. Line 1 is the process id (negative while it runs in single-user
 * mode), line 2 the data folder. Null when the file is not shaped like one.
 */
export function parsePostmasterPid(text: string): { pid: number; dataDir: string } | null {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const first = lines[0]?.trim() ?? "";
  if (!/^-?\d+$/.test(first)) return null;
  const pid = Math.abs(Number(first));
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { pid, dataDir: lines[1] ?? "" };
}

/**
 * The address the web app is given for its own database (DATABASE_URL_A).
 *
 * "localhost" is only a placeholder: the `host` parameter wins over it, and a
 * host that is a folder means "the socket in this folder". There is no
 * password because peer authentication needs none, and no encryption because
 * nothing leaves this computer.
 */
export function metadataDatabaseUrl(socketDir: string): string {
  return `postgres://${DB_USER}@localhost/${DB_NAME}?host=${encodeURIComponent(socketDir)}&sslmode=disable`;
}

/**
 * True when the database was set up under a different version of the rules
 * for sorting text than the ones PostgreSQL has now.
 *
 * Indexes on text are kept in sorted order. The rules come from ICU, which is
 * bundled with PostgreSQL, so they only change when an update of the app
 * brings a newer ICU. An index sorted under the old rules can then miss rows,
 * so src/main/postgres.ts rebuilds the indexes and records the new version.
 * `recorded` is pg_database.datcollversion and `actual` is what
 * pg_database_collation_actual_version() reports; either is null where
 * PostgreSQL keeps no version, and then there is nothing to compare.
 */
export function collationNeedsRefresh(recorded: string | null, actual: string | null): boolean {
  return recorded !== null && actual !== null && recorded !== actual;
}
