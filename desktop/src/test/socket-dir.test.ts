/**
 * Where the app's PostgreSQL puts its socket (src/core/socket-dir.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isUsableSocketDir, socketDirCandidates, socketPathLimit, type SocketDirInput } from "../core/socket-dir";

const LINUX = socketPathLimit("linux");

test("a socket path may be 107 bytes on Linux and 103 on macOS", () => {
  assert.equal(socketPathLimit("linux"), 107);
  assert.equal(socketPathLimit("darwin"), 103);
});

test("a folder fits when the socket's whole path is within the limit, counted in bytes", () => {
  // "/" + the name + "/.s.PGSQL.5432" (14 bytes).
  assert.equal(isUsableSocketDir("/" + "a".repeat(92), LINUX), true);
  assert.equal(isUsableSocketDir("/" + "a".repeat(93), LINUX), false);
  // "é" takes two bytes.
  assert.equal(isUsableSocketDir("/" + "é".repeat(46), LINUX), true);
  assert.equal(isUsableSocketDir("/" + "é".repeat(47), LINUX), false);
});

test("a folder that is relative, or has a quote or an invisible character in it, is never used", () => {
  assert.equal(isUsableSocketDir("run/schema-studio", LINUX), false);
  assert.equal(isUsableSocketDir('/home/sam/"quoted"', LINUX), false);
  assert.equal(isUsableSocketDir("/home/sam\nx", LINUX), false);
  assert.equal(isUsableSocketDir("/home/sam\u007fx", LINUX), false);
});

test("a comma in a folder's name is fine, because the app quotes the folder", () => {
  assert.equal(isUsableSocketDir("/home/a,b/.local/share/schema-studio/run", LINUX), true);
});

const UBUNTU: SocketDirInput = {
  platform: "linux",
  runtimeDir: "/run/user/1000",
  runtimeDirExists: true,
  dataDir: "/home/sam/.local/share/schema-studio",
  uid: 1000,
};

test("tries the login's runtime folder first, then the data folder, then /tmp", () => {
  assert.deepEqual(socketDirCandidates(UBUNTU), [
    "/run/user/1000/schema-studio",
    "/home/sam/.local/share/schema-studio/run",
    "/tmp/schema-studio-1000",
  ]);
});

test("leaves out a runtime folder that is missing, not set, or relative", () => {
  const rest = ["/home/sam/.local/share/schema-studio/run", "/tmp/schema-studio-1000"];
  assert.deepEqual(socketDirCandidates({ ...UBUNTU, runtimeDirExists: false }), rest);
  assert.deepEqual(socketDirCandidates({ ...UBUNTU, runtimeDir: undefined }), rest);
  assert.deepEqual(socketDirCandidates({ ...UBUNTU, runtimeDir: "run/user/1000" }), rest);
});

test("leaves out the data folder when the home folder's path is too long for a socket", () => {
  const dataDir = "/home/" + "x".repeat(100) + "/.local/share/schema-studio";
  assert.deepEqual(socketDirCandidates({ ...UBUNTU, dataDir }), [
    "/run/user/1000/schema-studio",
    "/tmp/schema-studio-1000",
  ]);
});
