/**
 * Writing files so a crash never leaves half of one (src/core/atomic-file.ts),
 * tried on real files in a fresh temporary folder.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readFileIfExists, removeStaleTempFiles, writeFileAtomic } from "../core/atomic-file";

/** A new empty folder for one test, removed when the test ends. */
function tempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-studio-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function modeOf(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

test("writes the file so that only its owner can read it", (t) => {
  const file = path.join(tempDir(t), "config.json");
  writeFileAtomic(file, "hello");
  assert.equal(fs.readFileSync(file, "utf8"), "hello");
  assert.equal(modeOf(file), 0o600);
});

test("sets the mode it is given exactly, whatever the umask would allow", (t) => {
  const file = path.join(tempDir(t), "shared.txt");
  writeFileAtomic(file, "x", 0o664);
  assert.equal(modeOf(file), 0o664);
});

test("replaces the old contents and leaves no temporary file behind", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "config.json");
  writeFileAtomic(file, "one");
  writeFileAtomic(file, Buffer.from("two"));
  assert.equal(fs.readFileSync(file, "utf8"), "two");
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
});

test("a write that fails leaves no temporary file behind", (t) => {
  const dir = tempDir(t);
  // A folder where the file should be: the final step cannot replace it.
  fs.mkdirSync(path.join(dir, "config.json"));
  assert.throws(() => writeFileAtomic(path.join(dir, "config.json"), "x"), { code: "EISDIR" });
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
});

test("a write into a folder that does not exist fails", (t) => {
  const file = path.join(tempDir(t), "missing", "config.json");
  assert.throws(() => writeFileAtomic(file, "x"), { code: "ENOENT" });
});

test("reading a file that is not there gives null, and anything else that goes wrong is thrown", (t) => {
  const dir = tempDir(t);
  assert.equal(readFileIfExists(path.join(dir, "missing.json")), null);
  fs.writeFileSync(path.join(dir, "here.json"), "text");
  assert.equal(readFileIfExists(path.join(dir, "here.json")), "text");
  assert.throws(() => readFileIfExists(dir), { code: "EISDIR" });
});

test("tidies up temporary files a crash left behind, and nothing else", (t) => {
  const dir = tempDir(t);
  const otherPid = process.pid + 1;
  const names = {
    leftByCrash: `.config.json.${otherPid}.0123456789ab.tmp`,
    thisRun: `.config.json.${process.pid}.0123456789ab.tmp`,
    notANumber: ".config.json.abc.0123456789ab.tmp",
    // Different letters from leftByCrash, because macOS treats names that
    // differ only in case as the same file.
    capitals: `.config.json.${otherPid}.ABCDEF012345.tmp`,
    notes: "notes.txt",
    config: "config.json",
  };
  for (const name of Object.values(names)) fs.writeFileSync(path.join(dir, name), "");

  removeStaleTempFiles(dir);

  const left = new Set(fs.readdirSync(dir));
  assert.equal(left.has(names.leftByCrash), false);
  for (const name of [names.thisRun, names.notANumber, names.capitals, names.notes, names.config]) {
    assert.equal(left.has(name), true, name);
  }
});

test("tidying a folder that does not exist does nothing", (t) => {
  assert.doesNotThrow(() => removeStaleTempFiles(path.join(tempDir(t), "missing")));
});
