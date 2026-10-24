/**
 * Locking a backup with a passphrase, sealing its contents in chunks, and
 * reading its records and manifest back (src/core/backup-file.ts), with
 * anything changed, cut short or added on refused.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  BackupFileError,
  CHUNK_BYTES,
  ChunkOpener,
  ChunkSealer,
  ContentsReader,
  defaultBackupName,
  encodeRecord,
  HEADER_BYTES,
  isNewerVersion,
  MAX_RECORD_BYTES,
  MIN_COST,
  newBackupKey,
  newRestoreId,
  openBackupKey,
  parseBackupManifest,
  parsePendingRestore,
  passphraseProblem,
  readBackupHeader,
  RecordReader,
  restoreComment,
  restoreIdFromComment,
  TAG_BYTES,
  type BackupProblem,
} from "../core/backup-file";

const SEALED_CHUNK = CHUNK_BYTES + TAG_BYTES;

/** A passphrase made fresh on every run, so the repository holds none. */
function passphrase(): string {
  return crypto.randomBytes(12).toString("base64url");
}

/** For assert.throws and assert.rejects: a BackupFileError about `expected`. */
function problem(expected: BackupProblem) {
  return (error: unknown) => error instanceof BackupFileError && error.problem === expected;
}

// One key for the tests that only seal and open, since every key costs a run of scrypt.
const sharedSecret = passphrase();
const shared = newBackupKey(sharedSecret, { cost: MIN_COST });

/** Numbers that look random but are the same on every run, so a failure can be repeated. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** `data` cut into pieces of 1 to `largest` bytes. */
function cut(data: Buffer, largest: number, random: () => number): Buffer[] {
  const pieces: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const size = 1 + Math.floor(random() * largest);
    pieces.push(data.subarray(offset, offset + size));
    offset += size;
  }
  return pieces;
}

/** `plain` sealed, written to the sealer in pieces of up to `largest` bytes. */
function seal(key: Buffer, header: Buffer, plain: Buffer, largest = 3 * CHUNK_BYTES): Buffer {
  const sealer = new ChunkSealer(key, header);
  const sealed: Buffer[] = [];
  for (const piece of cut(plain, largest, seeded(plain.length + largest))) sealed.push(...sealer.write(piece));
  sealed.push(sealer.end());
  return Buffer.concat(sealed);
}

/** `sealed` opened, written to the opener in pieces of up to `largest` bytes. */
function open(key: Buffer, header: Buffer, sealed: Buffer, largest = 3 * CHUNK_BYTES): Buffer {
  const opener = new ChunkOpener(key, header);
  const plain: Buffer[] = [];
  for (const piece of cut(sealed, largest, seeded(sealed.length + largest + 1))) plain.push(...opener.write(piece));
  plain.push(opener.end());
  return Buffer.concat(plain);
}

/** A manifest as a backup of a small database would have it. */
function sampleManifest() {
  return {
    appVersion: "2.0.0",
    createdAt: "2026-10-24T05:00:00.000Z",
    secrets: { appEncryptionKey: crypto.randomBytes(32).toString("hex"), githubToken: "test-token-" + crypto.randomBytes(8).toString("hex") },
    config: { theme: "dark", github: { owner: "octocat", repo: "schema-registry" } },
    tables: [
      { name: "roles", columns: ["name", "description"], rows: 2 },
      { name: "drift_events", columns: ["id"], rows: 0 },
      { name: "connections", columns: ["id", "name"], rows: 1 },
    ],
    sequences: [{ table: "connections", column: "id", lastValue: "41", isCalled: true }],
  };
}

test("contents of any size come back exactly, however they are written and read", async () => {
  const { header, key } = await shared;
  for (const size of [0, 1, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 2 * CHUNK_BYTES, 3 * CHUNK_BYTES + 5, 5 * 1024 * 1024 + 3]) {
    const plain = crypto.randomBytes(size);
    for (const largest of [1000, CHUNK_BYTES + 7, 4 * CHUNK_BYTES]) {
      const sealed = seal(key, header, plain, largest);
      // Every chunk but the last is full, and every chunk has its tag, even an empty last one.
      assert.equal(sealed.length, size + TAG_BYTES * Math.max(1, Math.ceil(size / CHUNK_BYTES)), `size ${size}`);
      for (const readLargest of [999, SEALED_CHUNK, 4 * CHUNK_BYTES]) {
        assert.ok(open(key, header, sealed, readLargest).equals(plain), `size ${size}, written ${largest} and read ${readLargest} at most at a time`);
      }
    }
  }
});

test("the sealer gives out each full chunk once more follows it, keeping back only the last", async () => {
  const { header, key } = await shared;
  const sealer = new ChunkSealer(key, header);
  assert.deepEqual(sealer.write(Buffer.alloc(CHUNK_BYTES)), []);
  assert.deepEqual(
    sealer.write(Buffer.alloc(1)).map((chunk) => chunk.length),
    [SEALED_CHUNK],
  );
  assert.deepEqual(sealer.write(Buffer.alloc(CHUNK_BYTES - 1)), []);
  assert.equal(sealer.end().length, SEALED_CHUNK);
  assert.throws(() => sealer.write(Buffer.alloc(1)), /nothing more after the last chunk/);
  assert.throws(() => sealer.end(), /sealed once/);
});

test("the opener holds a full chunk back until more follows, since it may be the last", async () => {
  const { header, key } = await shared;
  const sealed = seal(key, header, crypto.randomBytes(CHUNK_BYTES + 1));
  const opener = new ChunkOpener(key, header);
  assert.deepEqual(opener.write(sealed.subarray(0, SEALED_CHUNK)), []);
  assert.deepEqual(
    opener.write(sealed.subarray(SEALED_CHUNK, SEALED_CHUNK + 1)).map((plain) => plain.length),
    [CHUNK_BYTES],
  );
  assert.deepEqual(opener.write(sealed.subarray(SEALED_CHUNK + 1)), []);
  assert.equal(opener.end().length, 1);
  assert.throws(() => opener.write(Buffer.alloc(1)), /nothing more after the last chunk/);
  assert.throws(() => opener.end(), /opened once/);
});

test("sealing and opening take a 32 byte key and the whole 73 byte header", async () => {
  const { header, key } = await shared;
  assert.throws(() => new ChunkSealer(key.subarray(0, 16), header), /key of 32 bytes/);
  assert.throws(() => new ChunkOpener(key, header.subarray(0, HEADER_BYTES - 1)), /header of 73 bytes/);
});

test("a changed byte anywhere in the sealed contents, or another header or key, is refused", async () => {
  const { header, key } = await shared;
  const sealed = seal(key, header, crypto.randomBytes(2 * CHUNK_BYTES + 100));
  // The first chunk's start, end and tag, the second chunk's start, and the last chunk.
  for (const at of [0, CHUNK_BYTES - 1, CHUNK_BYTES, SEALED_CHUNK - 1, SEALED_CHUNK, 2 * SEALED_CHUNK + 50, sealed.length - 1]) {
    const changed = Buffer.from(sealed);
    changed[at] ^= 1;
    assert.throws(() => open(key, header, changed), problem("damaged"), `byte ${at}`);
  }
  const otherHeader = Buffer.from(header);
  otherHeader[HEADER_BYTES - 1] ^= 1;
  assert.throws(() => open(key, otherHeader, sealed), problem("damaged"));
  assert.throws(() => open(crypto.randomBytes(32), header, sealed), problem("damaged"));
});

test("contents cut short are refused, even where a chunk ends", async () => {
  const { header, key } = await shared;
  const sealed = seal(key, header, crypto.randomBytes(3 * CHUNK_BYTES + 5));
  // 3 * SEALED_CHUNK drops the whole last chunk, and SEALED_CHUNK ends after the first.
  for (const length of [sealed.length - 1, 3 * SEALED_CHUNK, 2 * SEALED_CHUNK + 1, SEALED_CHUNK, TAG_BYTES, 0]) {
    assert.throws(() => open(key, header, sealed.subarray(0, length)), problem("damaged"), `${length} bytes`);
  }
});

test("anything added after the last chunk is refused, even a real chunk", async () => {
  const { header, key } = await shared;
  const sealed = seal(key, header, crypto.randomBytes(CHUNK_BYTES + 5));
  const another = seal(key, header, crypto.randomBytes(CHUNK_BYTES));
  for (const extra of [Buffer.alloc(1), Buffer.alloc(TAG_BYTES), crypto.randomBytes(SEALED_CHUNK), another]) {
    assert.throws(() => open(key, header, Buffer.concat([sealed, extra])), problem("damaged"), `${extra.length} more bytes`);
  }
});

test("chunks that were moved, dropped or repeated are refused", async () => {
  const { header, key } = await shared;
  const sealed = seal(key, header, crypto.randomBytes(3 * CHUNK_BYTES + 5));
  const chunk = (index: number) => sealed.subarray(index * SEALED_CHUNK, (index + 1) * SEALED_CHUNK);
  const last = sealed.subarray(3 * SEALED_CHUNK);
  const reordered: Record<string, Buffer[]> = {
    swapped: [chunk(1), chunk(0), chunk(2), last],
    "dropped from the middle": [chunk(0), chunk(2), last],
    repeated: [chunk(0), chunk(0), chunk(1), chunk(2), last],
  };
  for (const [name, chunks] of Object.entries(reordered)) {
    assert.throws(() => open(key, header, Buffer.concat(chunks)), problem("damaged"), name);
  }
});

test("a new backup's header says what the file is and how its key was made", async () => {
  const { header } = await shared;
  assert.equal(header.length, HEADER_BYTES);
  assert.equal(header.subarray(0, 21).toString("latin1"), "SCHEMA STUDIO BACKUP\n");
  // The format version, then scrypt's log2 N, r and p.
  assert.deepEqual([...header.subarray(21, 25)], [1, MIN_COST, 8, 1]);
  const read = readBackupHeader(Buffer.concat([header, crypto.randomBytes(100)]));
  assert.ok(read.bytes.equals(header));
  assert.equal(read.cost, MIN_COST);
  assert.ok(read.salt.equals(header.subarray(25, 41)));
  assert.ok(read.check.equals(header.subarray(41, 73)));
});

test("only the passphrase a backup was saved with opens it", async () => {
  const { header, key } = await shared;
  const read = readBackupHeader(header);
  assert.ok((await openBackupKey(read, sharedSecret)).equals(key));
  await assert.rejects(openBackupKey(read, sharedSecret + "x"), problem("wrong-passphrase"));
  await assert.rejects(openBackupKey(read, sharedSecret.slice(1)), problem("wrong-passphrase"));
});

test("a passphrase opens its backup however its accented letters were typed", async () => {
  const composed = String.fromCharCode(0xe9);
  const decomposed = String.fromCharCode(0x65, 0x301);
  const start = passphrase();
  const { header, key } = await newBackupKey(start + composed, { cost: MIN_COST });
  assert.ok((await openBackupKey(readBackupHeader(header), start + decomposed)).equals(key));
});

test("every backup gets a new salt, so the same passphrase never makes the same key twice", async () => {
  const { header, key } = await shared;
  const again = await newBackupKey(sharedSecret, { cost: MIN_COST });
  assert.ok(!readBackupHeader(again.header).salt.equals(readBackupHeader(header).salt));
  assert.ok(!again.key.equals(key));
});

test("a new backup's cost must be one that this version can open", async () => {
  for (const cost of [14, 19, 15.5, Number.NaN]) {
    await assert.rejects(newBackupKey(sharedSecret, { cost }), /Expected a cost from 15 to 18/, String(cost));
  }
});

test("a file that is not a backup, or has a header no backup has, is refused before any passphrase is tried", async () => {
  const { header } = await shared;
  assert.throws(() => readBackupHeader(Buffer.alloc(0)), problem("not-a-backup"));
  assert.throws(() => readBackupHeader(header.subarray(0, 20)), problem("not-a-backup"));
  assert.throws(() => readBackupHeader(Buffer.from("PK zip files start like this", "latin1")), problem("not-a-backup"));
  assert.throws(() => readBackupHeader(header.subarray(0, HEADER_BYTES - 1)), problem("damaged"));
  const changed = (at: number, value: number) => {
    const copy = Buffer.from(header);
    copy[at] = value;
    return copy;
  };
  assert.throws(() => readBackupHeader(changed(0, 0x73)), problem("not-a-backup"));
  assert.throws(() => readBackupHeader(changed(21, 2)), problem("newer"));
  assert.throws(() => readBackupHeader(changed(21, 0)), problem("damaged"));
  // A cost outside 15 to 18, or another r or p, could make opening the file take minutes or gigabytes.
  for (const [at, value] of [[22, 14], [22, 19], [22, 255], [23, 16], [24, 2]]) {
    assert.throws(() => readBackupHeader(changed(at, value)), problem("damaged"), `byte ${at} as ${value}`);
  }
});

test("a changed salt or check reads as the wrong passphrase, since no passphrase could open the file", async () => {
  const { header } = await shared;
  for (const at of [25, 40, 41, 72]) {
    const copy = Buffer.from(header);
    copy[at] ^= 1;
    await assert.rejects(openBackupKey(readBackupHeader(copy), sharedSecret), problem("wrong-passphrase"), `byte ${at}`);
  }
});

test("a new passphrase needs 12 to 1024 characters, counted as people see them", () => {
  const tooShort = "Use a passphrase of at least 12 characters.";
  const tooLong = "Use a passphrase of at most 1024 characters.";
  // One character in two UTF-16 code units, and one character once normalized.
  const emoji = String.fromCodePoint(0x1f511);
  const decomposed = String.fromCharCode(0x65, 0x301);
  assert.equal(passphraseProblem(""), tooShort);
  assert.equal(passphraseProblem("a".repeat(11)), tooShort);
  assert.equal(passphraseProblem("a".repeat(12)), null);
  assert.equal(passphraseProblem(emoji.repeat(11)), tooShort);
  assert.equal(passphraseProblem(emoji.repeat(12)), null);
  assert.equal(passphraseProblem(decomposed.repeat(11)), tooShort);
  assert.equal(passphraseProblem(decomposed.repeat(12)), null);
  assert.equal(passphraseProblem("a".repeat(1024)), null);
  assert.equal(passphraseProblem(emoji.repeat(1024)), null);
  assert.equal(passphraseProblem("a".repeat(1025)), tooLong);
  assert.equal(passphraseProblem("a".repeat(100_000)), tooLong);
});

/** The records in `contents`, fed to a reader one byte at a time. */
function readByteByByte(contents: Buffer): string[] {
  const reader = new RecordReader();
  const records: string[] = [];
  for (let i = 0; i < contents.length; i++) records.push(...reader.push(contents.subarray(i, i + 1)));
  reader.end();
  return records;
}

test("records come back exactly as they were, however the contents are split", () => {
  const texts = [
    "",
    "{}",
    "two\nlines",
    // A byte order mark at the start is part of the text, so it is kept.
    String.fromCharCode(0xfeff) + "kept",
    // Characters of 2 and 4 bytes, which the splits below cut through.
    String.fromCharCode(0xe9) + String.fromCodePoint(0x1f511),
    "x".repeat(CHUNK_BYTES + 3),
  ];
  const contents = Buffer.concat(texts.map((text) => encodeRecord(text)));
  assert.deepEqual(readByteByByte(contents), texts);
  const whole = new RecordReader();
  assert.deepEqual(whole.push(contents), texts);
  whole.end();
  const pieces = new RecordReader();
  assert.deepEqual(
    cut(contents, 50, seeded(3)).flatMap((piece) => pieces.push(piece)),
    texts,
  );
  pieces.end();
});

test("a record is its length in UTF-8 bytes, big-endian, then the text", () => {
  assert.deepEqual([...encodeRecord(String.fromCharCode(0xe9) + "a")], [0, 0, 0, 3, 0xc3, 0xa9, 0x61]);
  assert.deepEqual([...encodeRecord("x".repeat(258)).subarray(0, 4)], [0, 0, 1, 2]);
});

test("a record that is too long, is not UTF-8 or is cut off is refused", () => {
  const length = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value, 0);
    return bytes;
  };
  // The longest length is only a promise of more to come; one more than that is refused at once.
  assert.deepEqual(new RecordReader().push(length(MAX_RECORD_BYTES)), []);
  assert.throws(() => new RecordReader().push(length(MAX_RECORD_BYTES + 1)), problem("damaged"));
  // A stray continuation byte, a character cut short, a UTF-16 surrogate written as UTF-8, and a byte UTF-8 never uses.
  for (const bytes of [[0x80], [0xc3], [0xed, 0xa0, 0xbd], [0xff]]) {
    const record = Buffer.concat([length(bytes.length), Buffer.from(bytes)]);
    assert.throws(() => new RecordReader().push(record), problem("damaged"), String(bytes));
  }
  for (const end of [1, 3, 4, 6]) {
    const reader = new RecordReader();
    assert.deepEqual(reader.push(encodeRecord("cut off").subarray(0, end)), []);
    assert.throws(() => reader.end(), problem("damaged"), `${end} bytes`);
  }
});

test("a manifest reads back as a fresh object with only the fields it should have", () => {
  const base = sampleManifest();
  const withExtras = {
    ...base,
    extra: true,
    secrets: { ...base.secrets, nextauthSecret: "not kept" },
    config: { ...base.config, port: 3000, github: { ...base.config.github, token: "not kept" } },
    tables: base.tables.map((table) => ({ ...table, comment: "not kept" })),
    sequences: base.sequences.map((sequence) => ({ ...sequence, increment: 1 })),
  };
  assert.deepEqual(parseBackupManifest(JSON.stringify(withExtras), "2.0.0"), base);
});

test("a manifest from a newer version says so, whatever else it holds", () => {
  for (const appVersion of ["2.0.1", "2.1.0", "3.0.0-beta.1", "10.0.0"]) {
    assert.throws(() => parseBackupManifest(JSON.stringify({ appVersion }), "2.0.0"), problem("newer"), appVersion);
  }
  for (const appVersion of ["2.0.0", "2.0.0-rc.1", "1.99.99", "0.1.0"]) {
    assert.equal(parseBackupManifest(JSON.stringify({ ...sampleManifest(), appVersion }), "2.0.0").appVersion, appVersion);
  }
});

test("versions are compared by their three numbers, and anything else is not newer", () => {
  assert.equal(isNewerVersion("2.0.10", "2.0.9"), true);
  assert.equal(isNewerVersion("10.0.0", "9.99.99"), true);
  assert.equal(isNewerVersion("2.0.0+build.5", "2.0.0"), false);
  assert.equal(isNewerVersion("2.0.0", "2.0.0-beta"), false);
  // Up to 64 characters, so that a crafted manifest cannot make the check slow.
  assert.equal(isNewerVersion("3.0.0-" + "a".repeat(58), "2.0.0"), true);
  for (const version of [undefined, null, 3, "3", "v3.0.0", "3.0", "3.0.0.0", "3.0.0 ", "3.0.0-" + "a".repeat(59)]) {
    assert.equal(isNewerVersion(version, "2.0.0"), false, String(version));
  }
  assert.equal(isNewerVersion("3.0.0", "not a version"), false);
});

test("a manifest with any field this version would not write is damaged", () => {
  const base = sampleManifest();
  const accented = String.fromCharCode(0xe9);
  const table = (fields: Record<string, unknown>) => ({ tables: [{ name: "roles", columns: ["name"], rows: 0, ...fields }], sequences: [] });
  const sequence = (fields: Record<string, unknown>) => ({
    sequences: [{ table: "connections", column: "id", lastValue: "41", isCalled: true, ...fields }],
  });
  const cases: Record<string, unknown>[] = [
    { appVersion: undefined },
    { appVersion: 2 },
    { appVersion: "two" },
    { appVersion: "2.0" },
    { createdAt: undefined },
    { createdAt: "yesterday" },
    { createdAt: "2026-10-24" },
    { createdAt: "2026-13-45T00:00:00.000Z" },
    { createdAt: 1761282000000 },
    { secrets: undefined },
    { secrets: "secret" },
    { secrets: { ...base.secrets, appEncryptionKey: undefined } },
    { secrets: { ...base.secrets, appEncryptionKey: "A".repeat(64) } },
    { secrets: { ...base.secrets, appEncryptionKey: "a".repeat(63) } },
    { secrets: { ...base.secrets, githubToken: "" } },
    { secrets: { ...base.secrets, githubToken: "has a space" } },
    { secrets: { ...base.secrets, githubToken: 5 } },
    { config: undefined },
    { config: { ...base.config, theme: "blue" } },
    { config: { theme: "dark" } },
    { config: { ...base.config, github: { owner: "octocat" } } },
    { config: { ...base.config, github: { owner: "-bad", repo: "schema-registry" } } },
    { config: { ...base.config, github: { owner: "octocat", repo: "" } } },
    { tables: undefined },
    { tables: {} },
    { tables: [5] },
    table({ name: "" }),
    table({ name: 5 }),
    table({ name: "a".repeat(64) }),
    // 32 characters, but 64 bytes: PostgreSQL's limit is in bytes.
    table({ name: accented.repeat(32) }),
    table({ name: "ro" + String.fromCharCode(0) + "les" }),
    table({ columns: [] }),
    table({ columns: "name" }),
    table({ columns: [5] }),
    table({ columns: ["name", "name"] }),
    table({ columns: Array.from({ length: 1601 }, (_, i) => `c${i}`) }),
    table({ rows: -1 }),
    table({ rows: 1.5 }),
    table({ rows: "2" }),
    table({ rows: 2 ** 53 }),
    table({ rows: undefined }),
    { tables: [...base.tables, { name: "roles", columns: ["name"], rows: 0 }] },
    { sequences: undefined },
    { sequences: {} },
    sequence({ table: "missing" }),
    sequence({ column: "missing" }),
    sequence({ table: "roles" }),
    sequence({ lastValue: 41 }),
    sequence({ lastValue: "41.5" }),
    sequence({ lastValue: "1".repeat(20) }),
    sequence({ lastValue: "" }),
    sequence({ isCalled: "yes" }),
    sequence({ isCalled: undefined }),
    { sequences: [...base.sequences, ...base.sequences] },
  ];
  for (const [index, override] of cases.entries()) {
    assert.throws(() => parseBackupManifest(JSON.stringify({ ...base, ...override }), "2.0.0"), problem("damaged"), `case ${index}`);
  }
  for (const text of ["", "{", "[]", "null", '"manifest"', "5"]) {
    assert.throws(() => parseBackupManifest(text, "2.0.0"), problem("damaged"), JSON.stringify(text));
  }
});

test("a manifest may have no GitHub token, no registry, no tables, and names up to PostgreSQL's limit", () => {
  const base = sampleManifest();
  const accented = String.fromCharCode(0xe9);
  const cases: Record<string, unknown>[] = [
    { secrets: { ...base.secrets, githubToken: null } },
    { config: { theme: "system", github: { owner: "", repo: "" } } },
    { tables: [], sequences: [] },
    { tables: [{ name: "a".repeat(63), columns: [accented.repeat(31)], rows: 0 }], sequences: [] },
    { tables: [{ name: "wide", columns: Array.from({ length: 1600 }, (_, i) => `c${i}`), rows: 0 }], sequences: [] },
    { sequences: [{ table: "connections", column: "id", lastValue: "-9223372036854775808", isCalled: false }] },
  ];
  for (const [index, override] of cases.entries()) {
    assert.doesNotThrow(() => parseBackupManifest(JSON.stringify({ ...base, ...override }), "2.0.0"), `case ${index}`);
  }
  const noToken = { ...base, secrets: { appEncryptionKey: base.secrets.appEncryptionKey } };
  assert.equal(parseBackupManifest(JSON.stringify(noToken), "2.0.0").secrets.githubToken, null);
});

test("the contents are the manifest, then each table's rows in its order, and nothing more", () => {
  const manifest = sampleManifest();
  const reader = new ContentsReader("2.0.0");
  assert.equal(reader.read(JSON.stringify(manifest)).kind, "manifest");
  const tables = ['{"name":"admin"}', '{"name":"viewer"}', '{"id":1}'].map((row) => {
    const item = reader.read(row);
    if (item.kind !== "row") throw new Error(`Expected a row, but got the ${item.kind}.`);
    return item.table.name;
  });
  // drift_events has no rows, so its turn passes without any.
  assert.deepEqual(tables, ["roles", "roles", "connections"]);
  assert.deepEqual(reader.end(), manifest);
});

test("contents with rows missing, rows to spare, a row that is not an object, or no manifest are refused", () => {
  const manifest = JSON.stringify(sampleManifest());
  const readAll = (records: string[]) => {
    const reader = new ContentsReader("2.0.0");
    for (const record of records) reader.read(record);
    return reader.end();
  };
  assert.throws(() => readAll([]), problem("damaged"));
  assert.throws(() => readAll([manifest, "{}", "{}"]), problem("damaged"));
  assert.throws(() => readAll([manifest, "{}", "{}", "{}", "{}"]), problem("damaged"));
  for (const row of ["", "[1]", '"text"', "null", "{", " {}"]) {
    assert.throws(() => readAll([manifest, row, "{}", "{}"]), problem("damaged"), JSON.stringify(row));
  }
  // The manifest's own problems come through as they are.
  assert.throws(() => readAll([JSON.stringify({ appVersion: "9.0.0" })]), problem("newer"));
  // A backup of a database with no tables at all is only its manifest.
  assert.deepEqual(readAll([JSON.stringify({ ...sampleManifest(), tables: [], sequences: [] })]).tables, []);
});

test("a whole backup goes together and comes apart: header, then sealed records, the manifest first", async () => {
  const secret = passphrase();
  const { header, key } = await newBackupKey(secret, { cost: MIN_COST });
  const manifest = sampleManifest();
  const rows = ['{"name":"admin"}', '{"name":"viewer"}', '{"id":1}'];
  const sealer = new ChunkSealer(key, header);
  const file = [header];
  for (const text of [JSON.stringify(manifest), ...rows]) file.push(...sealer.write(encodeRecord(text)));
  file.push(sealer.end());
  const bytes = Buffer.concat(file);

  const read = readBackupHeader(bytes.subarray(0, HEADER_BYTES));
  const opener = new ChunkOpener(await openBackupKey(read, secret), read.bytes);
  const records = new RecordReader();
  const contents = new ContentsReader("2.0.0");
  const seen: string[] = [];
  const take = (plain: Buffer) => {
    for (const record of records.push(plain)) {
      const item = contents.read(record);
      if (item.kind === "row") seen.push(item.row);
    }
  };
  for (const plain of opener.write(bytes.subarray(HEADER_BYTES))) take(plain);
  take(opener.end());
  records.end();
  assert.deepEqual(contents.end(), manifest);
  assert.deepEqual(seen, rows);
});

test("restore-pending.json is only used when it is exactly what a restore writes", () => {
  const pending = {
    id: newRestoreId(),
    secrets: { appEncryptionKey: crypto.randomBytes(32).toString("hex"), githubToken: null },
    config: { theme: "system", github: { owner: "", repo: "" } },
  };
  assert.deepEqual(parsePendingRestore(JSON.parse(JSON.stringify({ ...pending, extra: 1 }))), pending);
  const cases: unknown[] = [
    null,
    [],
    "text",
    { ...pending, id: "A".repeat(32) },
    { ...pending, id: "a".repeat(31) },
    { ...pending, secrets: undefined },
    { ...pending, config: { ...pending.config, theme: "blue" } },
  ];
  for (const [index, value] of cases.entries()) assert.equal(parsePendingRestore(value), null, `case ${index}`);
});

test("a restore's comment on the database gives its ID back, and no other comment does", () => {
  const id = newRestoreId();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.notEqual(newRestoreId(), id);
  assert.equal(restoreComment(id), `Schema Studio restore ${id}`);
  assert.equal(restoreIdFromComment(restoreComment(id)), id);
  for (const comment of [null, 5, "", "Schema Studio restore", `Schema Studio restore ${id}0`, `schema studio restore ${id}`, ` Schema Studio restore ${id}`, id]) {
    assert.equal(restoreIdFromComment(comment), null, String(comment));
  }
  // Only hex digits ever reach the SQL that writes the comment.
  assert.throws(() => restoreComment("x'; DROP DATABASE schema_studio; --"), /32 hex digits/);
  assert.throws(() => restoreComment("A".repeat(32)), /32 hex digits/);
});

test("a backup is named after the local day it was made", () => {
  assert.equal(defaultBackupName(new Date(2026, 0, 5, 23, 59)), "schema-studio-backup-2026-01-05.ssbackup");
  assert.equal(defaultBackupName(new Date(2026, 9, 24, 0, 1)), "schema-studio-backup-2026-10-24.ssbackup");
});
