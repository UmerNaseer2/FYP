// Tests for reading a whole backup file outside the app, which the web site's
// data mover uses. The file is put together by hand from the same pieces a
// saved backup is made of, so no database is needed.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readBackupFile } from "../core/backup-read";
import { BackupFileError, ChunkSealer, encodeRecord, MIN_COST, newBackupKey, type BackupManifest } from "../core/backup-file";

const appVersion = "2.0.0";

/** A passphrase made fresh on every run, so the repository holds none. */
function passphrase(): string {
  return crypto.randomBytes(12).toString("base64url");
}

function manifest(): BackupManifest {
  return {
    appVersion,
    createdAt: new Date(0).toISOString(),
    secrets: { appEncryptionKey: crypto.randomBytes(32).toString("hex"), githubToken: null },
    config: { theme: "dark", github: { owner: "octocat", repo: "schema-registry" } },
    tables: [
      { name: "organizations", columns: ["id", "slug"], rows: 2 },
      { name: "empty_table", columns: ["id"], rows: 0 },
      { name: "connections", columns: ["id", "org_id"], rows: 1 },
    ],
    sequences: [],
  };
}

const ROWS = [
  JSON.stringify({ id: "1", slug: "first" }),
  JSON.stringify({ id: "2", slug: "second" }),
  JSON.stringify({ id: "7", org_id: "2" }),
];

/** Writes a backup the way the app does: the header, then sealed records. */
async function write(t: test.TestContext, pass: string, records: string[]): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-studio-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { header, key } = await newBackupKey(pass, { cost: MIN_COST });
  const sealer = new ChunkSealer(key, header);
  const parts = [header];
  for (const record of records) parts.push(...sealer.write(encodeRecord(record)));
  parts.push(sealer.end());
  const file = path.join(dir, "backup.ssbackup");
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

test("a backup is read whole, with each row under its own table", async (t) => {
  const pass = passphrase();
  const expected = manifest();
  const file = await write(t, pass, [JSON.stringify(expected), ...ROWS]);
  const { manifest: read, rows } = await readBackupFile(file, pass, appVersion);
  assert.deepEqual(read, expected);
  assert.deepEqual([...rows.keys()].sort(), ["connections", "organizations"]);
  assert.deepEqual(rows.get("organizations"), ROWS.slice(0, 2));
  assert.deepEqual(rows.get("connections"), ROWS.slice(2));
});

test("the wrong passphrase reads nothing", async (t) => {
  const file = await write(t, passphrase(), [JSON.stringify(manifest()), ...ROWS]);
  await assert.rejects(readBackupFile(file, passphrase(), appVersion), (error: unknown) => {
    assert.ok(error instanceof BackupFileError);
    assert.equal(error.problem, "wrong-passphrase");
    return true;
  });
});

test("a backup missing rows it promised is refused", async (t) => {
  const pass = passphrase();
  const file = await write(t, pass, [JSON.stringify(manifest()), ...ROWS.slice(0, 2)]);
  await assert.rejects(readBackupFile(file, pass, appVersion), BackupFileError);
});

test("a folder is not a backup", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-studio-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(readBackupFile(dir, passphrase(), appVersion), (error: unknown) => {
    assert.ok(error instanceof BackupFileError);
    assert.equal(error.problem, "not-a-backup");
    return true;
  });
});
