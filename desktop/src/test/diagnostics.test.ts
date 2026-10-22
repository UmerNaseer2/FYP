/**
 * What Help > Copy Diagnostics puts on the clipboard
 * (src/main/diagnostics.ts), made from real log files in a folder of their
 * own.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { resolveAppPaths } from "../core/paths";
import { makeDiagnostics, type DiagnosticsInput } from "../main/diagnostics";
import { addLogSecret, initLog, logFilePaths } from "../main/log";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-diagnostics-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const paths = resolveAppPaths(
  {
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  },
  os.homedir(),
);
initLog(paths.logs, { echo: false });

function input(changes: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    build: { clientId: null, tenantId: null, commit: "abc1234", dirty: false, builtAt: "2026-10-22T01:02:03.000Z" },
    version: "2.0.0 (abc1234)",
    packaged: false,
    paths,
    secretsKeptIn: "keyring",
    keyringBackend: "gnome_libsecret",
    status: [
      ["Starting", "finished"],
      ["Server", "running on port 4100"],
    ],
    ...changes,
  };
}

test("the database's own log is redacted: the app's keys, email addresses and the home folder", () => {
  const files = logFilePaths();
  assert.ok(files !== null);
  const secret = "key-" + "k".repeat(28);
  const email = ["someone", "example.com"].join("@");
  addLogSecret(secret);
  fs.writeFileSync(
    files.postgres,
    `LOG:  database system is ready\nFATAL:  ${secret} for ${email} in ${path.join(os.homedir(), "project")}\n`,
  );

  const text = makeDiagnostics(input());
  assert.ok(text.includes("LOG:  database system is ready"));
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes(email));
  assert.ok(!text.includes(os.homedir()));
  assert.ok(text.includes("~/project"));
});

test("says which version this is, how far the app got and where its keys are", () => {
  const text = makeDiagnostics(input());
  assert.ok(text.includes("Version: 2.0.0 (abc1234)"));
  assert.ok(text.includes("Built: 2026-10-22T01:02:03.000Z"));
  assert.ok(text.includes("Microsoft sign-in: not set up in this build"));
  assert.ok(text.includes("  Server: running on port 4100"));
  assert.ok(text.includes("Keys kept in: the keyring (gnome_libsecret)"));
});

test("says plainly when the keys were not opened and a log is still empty", () => {
  const text = makeDiagnostics(input({ secretsKeptIn: null, keyringBackend: null }));
  assert.ok(text.includes("Keys kept in: not opened yet"));
  assert.ok(text.includes("The end of server.log\n  (empty, or not written yet)"));
});
