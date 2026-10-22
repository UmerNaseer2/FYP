/**
 * The pure half of the app's own PostgreSQL (src/core/postgres-files.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DB_NAME,
  DB_USER,
  PG_MAJOR,
  PG_PORT,
  collationNeedsRefresh,
  initdbArgs,
  initdbFallbackArgs,
  metadataDatabaseUrl,
  parsePgVersion,
  parsePostmasterPid,
  pgHbaConf,
  pgIdentConf,
  postgresArgs,
  validOsUser,
} from "../core/postgres-files";

const WRITTEN_BY_APP = "# Written by Schema Studio each time it starts. Changes made here are replaced.\n";

test("ships PostgreSQL 17, with the app's own user and database", () => {
  assert.equal(PG_MAJOR, 17);
  assert.equal(DB_USER, "schema_studio");
  assert.equal(DB_NAME, "schema_studio");
  assert.equal(PG_PORT, 5432);
});

test("sets up a new database that nobody can reach over the network", () => {
  assert.deepEqual(initdbArgs("/data"), [
    "-D",
    "/data",
    "-U",
    "schema_studio",
    "-E",
    "UTF8",
    "--locale=C",
    "--locale-provider=icu",
    "--icu-locale=und",
    "--auth-local=peer",
    "--auth-host=reject",
    "--data-checksums",
    "--no-instructions",
  ]);
});

test("starts the server on its private socket only, with no network address", () => {
  assert.deepEqual(postgresArgs("/data", "/run/user/1000/schema-studio"), [
    "-D",
    "/data",
    "-c",
    "listen_addresses=",
    "-c",
    'unix_socket_directories="/run/user/1000/schema-studio"',
    "-c",
    "unix_socket_permissions=0700",
    "-c",
    "port=5432",
    "-c",
    "max_connections=20",
    "-c",
    "lc_messages=C",
  ]);
});

test("lets in only the app's user, on the socket, vouched for by the operating system", () => {
  assert.equal(
    pgHbaConf(),
    WRITTEN_BY_APP +
      "# The database answers only on a private socket (there is no network\n" +
      "# address), and only to the person this app runs as.\n" +
      "local all schema_studio peer map=studio\n",
  );
});

test("maps the person running the app to the database user, quoting their name", () => {
  assert.equal(pgIdentConf("sam"), WRITTEN_BY_APP + 'studio "sam" schema_studio\n');
  assert.equal(pgIdentConf("first last"), WRITTEN_BY_APP + 'studio "first last" schema_studio\n');
});

test("accepts directory-style user names, and refuses ones that would break the file", () => {
  for (const name of ["sam", "first.last@corp", "with space", "DOMAIN-user"]) {
    assert.equal(validOsUser(name), true, name);
  }
  for (const name of ["", 'a"b', "a\nb", "a\u0000b", "/regex"]) {
    assert.equal(validOsUser(name), false, JSON.stringify(name));
  }
  assert.throws(() => pgIdentConf('a"b'), /cannot be used for the database/);
});

test("reads the major version from PG_VERSION", () => {
  assert.equal(parsePgVersion("17\n"), 17);
  assert.equal(parsePgVersion(" 16 "), 16);
  assert.equal(parsePgVersion("17.2"), null);
  assert.equal(parsePgVersion(""), null);
  assert.equal(parsePgVersion("abc"), null);
});

test("reads the process id and data folder from postmaster.pid", () => {
  const real =
    "4242\n/home/sam/.local/share/schema-studio/postgres/data\n1729500000\n5432\n" +
    "/run/user/1000/schema-studio\n\n  5432001         0\nready   \n";
  assert.deepEqual(parsePostmasterPid(real), {
    pid: 4242,
    dataDir: "/home/sam/.local/share/schema-studio/postgres/data",
  });
  // Negative while PostgreSQL runs in single-user mode, and with Windows line ends.
  assert.deepEqual(parsePostmasterPid("-1234\r\n/d\r\n"), { pid: 1234, dataDir: "/d" });
  assert.deepEqual(parsePostmasterPid("1234"), { pid: 1234, dataDir: "" });
});

test("a postmaster.pid that is not shaped like one gives nothing", () => {
  assert.equal(parsePostmasterPid("0\n/d"), null);
  assert.equal(parsePostmasterPid("99999999999999999999\n/d"), null);
  assert.equal(parsePostmasterPid("abc\n/d"), null);
  assert.equal(parsePostmasterPid(""), null);
});

test("gives the web app an address that points at the socket folder, with no password", () => {
  assert.equal(
    metadataDatabaseUrl("/run/user/1000/schema-studio"),
    "postgres://schema_studio@localhost/schema_studio?host=%2Frun%2Fuser%2F1000%2Fschema-studio&sslmode=disable",
  );
});

test("rebuilds the indexes only when both sort-rule versions are known and differ", () => {
  assert.equal(collationNeedsRefresh("153.120", "153.120"), false);
  assert.equal(collationNeedsRefresh("153.120", "153.121"), true);
  assert.equal(collationNeedsRefresh(null, "153.121"), false);
  assert.equal(collationNeedsRefresh("153.120", null), false);
});

test("falls back to PostgreSQL's own C.UTF-8 sorting when ICU cannot start", () => {
  // The same database and the same network and socket rules, without ICU.
  assert.deepEqual(initdbFallbackArgs("/data"), [
    "-D",
    "/data",
    "-U",
    "schema_studio",
    "-E",
    "UTF8",
    "--locale=C",
    "--auth-local=peer",
    "--auth-host=reject",
    "--data-checksums",
    "--no-instructions",
    "--locale-provider=builtin",
    "--builtin-locale=C.UTF-8",
  ]);
});
