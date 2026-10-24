/**
 * The backup file that Settings > Backup saves and restores, and checking
 * everything read back from one.
 *
 * A backup holds what it takes to bring Schema Studio back after a reinstall
 * or on another computer: every row of the app's database, the key that locks
 * the database passwords saved in it, the GitHub access token, and the theme
 * and GitHub registry choices. It is locked with a passphrase the person
 * chooses, so the file can be kept anywhere: without the passphrase it is
 * noise.
 *
 * The file starts with a header of 73 bytes:
 *
 *   "SCHEMA STUDIO BACKUP\n"  21 bytes, so the file says what it is
 *   format version            1 byte, 1 for now
 *   cost                      3 bytes: scrypt's log2 N, r and p
 *   salt                      16 random bytes, new for every backup
 *   check                     32 bytes that tell whether a passphrase is the right one
 *
 * scrypt turns the passphrase and the salt into 64 bytes. The first 32 are the
 * AES-256-GCM key, and the other 32 are the check, so that a wrong passphrase
 * can be told apart from a damaged file. (scrypt makes its output in
 * independent blocks, so the check gives nothing away about the key.) The
 * cost is high on purpose: every guess at a passphrase takes a noticeable
 * moment and 128 MiB of memory, which makes trying one after another slow.
 *
 * After the header come the contents, in sealed chunks of 64 KiB, each ending
 * with its own 16 byte tag. A chunk's nonce holds its number and whether it is
 * the last one, and every chunk is tied to the header (the "STREAM"
 * construction). So a chunk that was changed, moved, dropped or added, a file
 * cut short, anything stuck on the end and a changed header all fail to open.
 *
 * Inside, the contents are records: the length (4 bytes, big-endian), then
 * that many bytes of UTF-8 text. The first record is the manifest, in JSON:
 * the secrets and choices, and each table's columns and number of rows. Then
 * come the rows, one record each, table by table in the manifest's order. A
 * row is a JSON object with each column's value as PostgreSQL writes it as
 * text (or null), so that every type comes back exactly as it was saved.
 *
 * Pure: saving and restoring are src/main/backup.ts. Tested in
 * src/test/backup-file.test.ts.
 */
import crypto from "node:crypto";
import { TextDecoder } from "node:util";

import type { ThemeChoice } from "../shared/ipc";
import { isThemeChoice } from "./config";
import { isSavedRegistryValid, isSavedTokenValid } from "./github-settings";

/** The extension backups are saved with, as in "schema-studio-backup-2026-10-24.ssbackup". */
export const BACKUP_EXTENSION = "ssbackup";

/** Passphrases are counted in characters as people see them: code points, after NFC. */
export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 1024;

const MAGIC = Buffer.from("SCHEMA STUDIO BACKUP\n", "ascii");
const FORMAT_VERSION = 1;
const VERSION_AT = MAGIC.length;
const COST_AT = VERSION_AT + 1;
const SALT_AT = COST_AT + 3;
const SALT_BYTES = 16;
const CHECK_AT = SALT_AT + SALT_BYTES;
const CHECK_BYTES = 32;
const KEY_BYTES = 32;
export const HEADER_BYTES = CHECK_AT + CHECK_BYTES;

/**
 * scrypt's cost, as log2 of N, with r = 8 and p = 1. 17 needs 128 MiB and
 * a few tenths of a second; the tests use the lowest, 15, to stay quick. A backup
 * that asks for anything else is refused before any work is done, so a
 * damaged or crafted file cannot make the app spend minutes or gigabytes on
 * it. A later version that needs other limits has to write a new format
 * version, so that this one says "newer" instead of "damaged".
 */
export const DEFAULT_COST = 17;
export const MIN_COST = 15;
export const MAX_COST = 18;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** The contents are sealed in chunks of this many bytes. The last chunk may hold fewer, or none. */
export const CHUNK_BYTES = 64 * 1024;
/** Each sealed chunk ends with AES-GCM's tag. */
export const TAG_BYTES = 16;
const SEALED_CHUNK_BYTES = CHUNK_BYTES + TAG_BYTES;
const NONCE_BYTES = 12;
/** The nonce has 4 bytes for the chunk's number, so no key ever seals more chunks than this. */
const MAX_CHUNKS = 2 ** 32;

const LENGTH_BYTES = 4;
/** No record (the manifest, or one row) may be longer than this. */
export const MAX_RECORD_BYTES = 256 * 1024 * 1024;
/** PostgreSQL's own limit on the columns of one table. */
const MAX_COLUMNS = 1600;

export type BackupProblem = "not-a-backup" | "newer" | "wrong-passphrase" | "damaged" | "does-not-fit";

const PROBLEM_MESSAGES: Record<BackupProblem, string> = {
  "not-a-backup": "This file is not a Schema Studio backup.",
  newer: "This backup was made by a newer version of Schema Studio. Update Schema Studio, then try again.",
  "wrong-passphrase": "The passphrase does not open this backup. Check it, then try again.",
  damaged: "This backup is damaged or incomplete, so it cannot be restored.",
  "does-not-fit": "This backup does not fit this version of Schema Studio, so it cannot be restored.",
};

/** A backup that cannot be opened or restored, and why, in words for the person restoring it. */
export class BackupFileError extends Error {
  readonly problem: BackupProblem;

  constructor(problem: BackupProblem) {
    super(PROBLEM_MESSAGES[problem]);
    this.name = "BackupFileError";
    this.problem = problem;
  }
}

/**
 * What is wrong with a new backup's passphrase, in words for the person, or
 * null when it will do. Only the length is checked: length is what keeps
 * guessing hopeless, and the person knows best which words they will
 * remember. (Every guess also costs scrypt's time and memory, see DEFAULT_COST.)
 */
export function passphraseProblem(passphrase: string): string | null {
  const tooLong = `Use a passphrase of at most ${MAX_PASSPHRASE_LENGTH} characters.`;
  // Checked first, so that an absurd amount of text is never normalized.
  if (passphrase.length > MAX_PASSPHRASE_LENGTH * 4) return tooLong;
  const length = [...passphrase.normalize("NFC")].length;
  if (length < MIN_PASSPHRASE_LENGTH) return `Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  if (length > MAX_PASSPHRASE_LENGTH) return tooLong;
  return null;
}

/** "schema-studio-backup-2026-10-24.ssbackup", from the local date. */
export function defaultBackupName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `schema-studio-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.${BACKUP_EXTENSION}`;
}

/**
 * scrypt, without blocking the main process while it works. The passphrase
 * is normalized first, so that "e" with an accent typed as one character or
 * as two (as different keyboards do) gives the same key.
 */
function derive(passphrase: string, salt: Buffer, cost: number): Promise<Buffer> {
  const n = 2 ** cost;
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      passphrase.normalize("NFC"),
      salt,
      KEY_BYTES + CHECK_BYTES,
      // scrypt needs 128 * N * r bytes; maxmem is a ceiling, so twice that is room enough.
      { N: n, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * n * SCRYPT_R },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
}

/** A new backup's header (with a fresh salt) and its key. */
export async function newBackupKey(passphrase: string, options: { cost?: number } = {}): Promise<{ header: Buffer; key: Buffer }> {
  const cost = options.cost ?? DEFAULT_COST;
  if (!Number.isInteger(cost) || cost < MIN_COST || cost > MAX_COST) {
    throw new Error(`Expected a cost from ${MIN_COST} to ${MAX_COST}, but got ${String(cost)}.`);
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await derive(passphrase, salt, cost);
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header[VERSION_AT] = FORMAT_VERSION;
  header[COST_AT] = cost;
  header[COST_AT + 1] = SCRYPT_R;
  header[COST_AT + 2] = SCRYPT_P;
  salt.copy(header, SALT_AT);
  derived.copy(header, CHECK_AT, KEY_BYTES);
  return { header, key: derived.subarray(0, KEY_BYTES) };
}

/** What a backup's header says. */
export type BackupHeader = {
  /** All 73 bytes, which every chunk is tied to. */
  bytes: Buffer;
  /** scrypt's cost, as log2 of N. */
  cost: number;
  salt: Buffer;
  check: Buffer;
};

/**
 * Reads the header from the start of a file (its first HEADER_BYTES, or all
 * of it when it is shorter). Throws a BackupFileError when the file is not a
 * backup, is from a newer format, or has a header no backup would have.
 */
export function readBackupHeader(start: Buffer): BackupHeader {
  if (start.length < MAGIC.length || !start.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupFileError("not-a-backup");
  }
  if (start.length < HEADER_BYTES) throw new BackupFileError("damaged");
  const version = start[VERSION_AT];
  if (version > FORMAT_VERSION) throw new BackupFileError("newer");
  if (version !== FORMAT_VERSION) throw new BackupFileError("damaged");
  const cost = start[COST_AT];
  if (cost < MIN_COST || cost > MAX_COST || start[COST_AT + 1] !== SCRYPT_R || start[COST_AT + 2] !== SCRYPT_P) {
    throw new BackupFileError("damaged");
  }
  const bytes = Buffer.from(start.subarray(0, HEADER_BYTES));
  return { bytes, cost, salt: bytes.subarray(SALT_AT, CHECK_AT), check: bytes.subarray(CHECK_AT, HEADER_BYTES) };
}

/**
 * The key that opens a backup, from its passphrase. Throws a BackupFileError
 * ("wrong-passphrase") when the passphrase is not the one it was saved with.
 * A header damaged in its salt or check reads the same way, which is fair:
 * no passphrase could open that file either.
 */
export async function openBackupKey(header: BackupHeader, passphrase: string): Promise<Buffer> {
  const derived = await derive(passphrase, header.salt, header.cost);
  if (!crypto.timingSafeEqual(derived.subarray(KEY_BYTES), header.check)) throw new BackupFileError("wrong-passphrase");
  return derived.subarray(0, KEY_BYTES);
}

function checkKeyAndHeader(key: Buffer, header: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error(`Expected a key of ${KEY_BYTES} bytes, but got ${key.length}.`);
  if (header.length !== HEADER_BYTES) throw new Error(`Expected a header of ${HEADER_BYTES} bytes, but got ${header.length}.`);
}

/** Chunk number `index`'s nonce: 7 zero bytes, the number (4 bytes, big-endian), then 1 for the last chunk or 0. */
function chunkNonce(index: number, last: boolean): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeUInt32BE(index, 7);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

/** The pieces as one buffer, copying only when there is more than one. */
function joinPieces(pieces: Buffer[], size: number): Buffer {
  return pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, size);
}

/**
 * Seals a backup's contents as they are written. Give it the contents in
 * pieces of any size with write, then call end once, which seals what is left
 * as the last chunk. Every chunk before the last holds exactly CHUNK_BYTES, so
 * a reader knows where each one ends.
 */
export class ChunkSealer {
  private readonly key: Buffer;
  private readonly header: Buffer;
  private pieces: Buffer[] = [];
  private size = 0;
  private count = 0;
  private ended = false;

  constructor(key: Buffer, header: Buffer) {
    checkKeyAndHeader(key, header);
    this.key = key;
    this.header = header;
  }

  /** The chunks that the contents so far fill. The rest is kept for later. */
  write(plain: Buffer): Buffer[] {
    if (this.ended) throw new Error("Expected nothing more after the last chunk, but more contents were written.");
    this.pieces.push(plain);
    this.size += plain.length;
    // At least one byte is kept back while more may come: the last chunk has
    // to be sealed as the last one, and only end knows which one that is.
    if (this.size <= CHUNK_BYTES) return [];
    const buffered = joinPieces(this.pieces, this.size);
    const sealed: Buffer[] = [];
    let offset = 0;
    while (buffered.length - offset > CHUNK_BYTES) {
      sealed.push(this.seal(buffered.subarray(offset, offset + CHUNK_BYTES), false));
      offset += CHUNK_BYTES;
    }
    // A copy, so that the big buffer the rest was cut from can be freed.
    this.pieces = [Buffer.from(buffered.subarray(offset))];
    this.size = buffered.length - offset;
    return sealed;
  }

  /**
   * The last chunk. A backup with no contents still gets one, holding only its
   * tag, so that a file cut off right after its header does not open.
   */
  end(): Buffer {
    if (this.ended) throw new Error("Expected the last chunk to be sealed once, but end was called again.");
    this.ended = true;
    const rest = joinPieces(this.pieces, this.size);
    this.pieces = [];
    this.size = 0;
    return this.seal(rest, true);
  }

  private seal(plain: Buffer, last: boolean): Buffer {
    if (this.count >= MAX_CHUNKS) throw new Error("The backup is too big to seal.");
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, chunkNonce(this.count, last), { authTagLength: TAG_BYTES });
    cipher.setAAD(this.header);
    const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    this.count += 1;
    return sealed;
  }
}

/**
 * Opens a backup's chunks as the file is read. Give it everything after the
 * header in pieces of any size with write, which returns the contents of each
 * chunk that opened, then call end once for the last chunk. A chunk that does
 * not open, a file cut short and anything after the last chunk all throw a
 * BackupFileError ("damaged").
 *
 * A chunk's contents are only given out once its tag has been checked, but a
 * file cut short is only found by end. So nothing read may be acted on for
 * good until end has returned.
 */
export class ChunkOpener {
  private readonly key: Buffer;
  private readonly header: Buffer;
  private pieces: Buffer[] = [];
  private size = 0;
  private count = 0;
  private ended = false;

  constructor(key: Buffer, header: Buffer) {
    checkKeyAndHeader(key, header);
    this.key = key;
    this.header = header;
  }

  /** The contents of the chunks that the bytes so far complete. */
  write(sealed: Buffer): Buffer[] {
    if (this.ended) throw new Error("Expected nothing more after the last chunk, but more was written.");
    this.pieces.push(sealed);
    this.size += sealed.length;
    // A full chunk is only opened once a byte after it has arrived: until
    // then it may be the last one, which opens with a different nonce.
    if (this.size <= SEALED_CHUNK_BYTES) return [];
    const buffered = joinPieces(this.pieces, this.size);
    const opened: Buffer[] = [];
    let offset = 0;
    while (buffered.length - offset > SEALED_CHUNK_BYTES) {
      opened.push(this.open(buffered.subarray(offset, offset + SEALED_CHUNK_BYTES), false));
      offset += SEALED_CHUNK_BYTES;
    }
    this.pieces = [Buffer.from(buffered.subarray(offset))];
    this.size = buffered.length - offset;
    return opened;
  }

  /** The last chunk's contents, once it has opened as the last one. */
  end(): Buffer {
    if (this.ended) throw new Error("Expected the last chunk to be opened once, but end was called again.");
    this.ended = true;
    const rest = joinPieces(this.pieces, this.size);
    this.pieces = [];
    this.size = 0;
    // Even an empty last chunk has its tag.
    if (rest.length < TAG_BYTES) throw new BackupFileError("damaged");
    return this.open(rest, true);
  }

  private open(sealed: Buffer, last: boolean): Buffer {
    if (this.count >= MAX_CHUNKS) throw new BackupFileError("damaged");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, chunkNonce(this.count, last), { authTagLength: TAG_BYTES });
    decipher.setAAD(this.header);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    let plain: Buffer;
    try {
      // final throws when the tag does not match, so nothing unchecked gets out.
      plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
    } catch {
      throw new BackupFileError("damaged");
    }
    this.count += 1;
    return plain;
  }
}

/** One record: the text's length in UTF-8 (4 bytes, big-endian), then the text as UTF-8. */
export function encodeRecord(text: string): Buffer {
  const length = Buffer.byteLength(text, "utf8");
  if (length > MAX_RECORD_BYTES) throw new Error(`Expected a record of at most ${MAX_RECORD_BYTES} bytes, but one has ${length}.`);
  const record = Buffer.allocUnsafe(LENGTH_BYTES + length);
  record.writeUInt32BE(length, 0);
  record.write(text, LENGTH_BYTES, "utf8");
  return record;
}

/**
 * Splits a backup's contents back into records as the chunks open. A length
 * over MAX_RECORD_BYTES, text that is not UTF-8 and a record cut off at the
 * end are all "damaged".
 */
export class RecordReader {
  private pieces: Buffer[] = [];
  private size = 0;
  /** The length of the record being read, once its 4 bytes have arrived. */
  private length: number | null = null;
  // fatal: broken UTF-8 throws, instead of quietly becoming replacement
  // characters. ignoreBOM: a byte order mark at the start of a record is kept,
  // since it was part of the text that was saved.
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  /** The records that the contents so far complete. */
  push(plain: Buffer): string[] {
    if (plain.length > 0) {
      this.pieces.push(plain);
      this.size += plain.length;
    }
    const records: string[] = [];
    while (true) {
      if (this.length === null) {
        if (this.size < LENGTH_BYTES) break;
        const length = this.take(LENGTH_BYTES).readUInt32BE(0);
        if (length > MAX_RECORD_BYTES) throw new BackupFileError("damaged");
        this.length = length;
      }
      if (this.size < this.length) break;
      records.push(this.decode(this.take(this.length)));
      this.length = null;
    }
    return records;
  }

  /** Checks that the contents ended where a record did. */
  end(): void {
    if (this.length !== null || this.size > 0) throw new BackupFileError("damaged");
  }

  /** The next `count` bytes, which have all arrived. Only the pieces they span are joined. */
  private take(count: number): Buffer {
    if (count === 0) return Buffer.alloc(0);
    if (this.pieces[0].length < count) {
      let spanned = 0;
      let joinedSize = 0;
      while (joinedSize < count) {
        joinedSize += this.pieces[spanned].length;
        spanned += 1;
      }
      this.pieces.unshift(Buffer.concat(this.pieces.splice(0, spanned), joinedSize));
    }
    const first = this.pieces[0];
    if (first.length === count) this.pieces.shift();
    else this.pieces[0] = first.subarray(count);
    this.size -= count;
    return first.subarray(0, count);
  }

  private decode(bytes: Buffer): string {
    try {
      return this.decoder.decode(bytes);
    } catch {
      throw new BackupFileError("damaged");
    }
  }
}

/** One table in a backup. */
export type BackupTable = {
  /** Its name, in the public schema. */
  name: string;
  /** The columns each row has, in order. Generated columns are left out, since PostgreSQL works them out again. */
  columns: string[];
  /** How many rows of it the backup holds. */
  rows: number;
};

/** How far the counter (sequence) behind a serial or identity column had got. */
export type BackupSequence = {
  table: string;
  column: string;
  /** As text, since it can be bigger than a JavaScript number holds exactly. */
  lastValue: string;
  /** False when the counter had not been used yet, so its next value is lastValue itself. */
  isCalled: boolean;
};

/** The secrets a backup carries. The sign-in secret is not one of them: a restore makes a new one. */
export type BackupSecrets = {
  /** The key that locks the database passwords saved in the app (64 hex digits). */
  appEncryptionKey: string;
  githubToken: string | null;
};

/** The choices from config.json a backup carries. */
export type BackupChoices = { theme: ThemeChoice; github: { owner: string; repo: string } };

/** The first record of every backup. */
export type BackupManifest = {
  /** The version of Schema Studio that made it. */
  appVersion: string;
  /** When it was made, as an ISO date. */
  createdAt: string;
  secrets: BackupSecrets;
  config: BackupChoices;
  tables: BackupTable[];
  sequences: BackupSequence[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "2.0.0" and "2.1.0-beta.1" give their three numbers. Anything else gives null. */
function versionNumbers(version: unknown): number[] | null {
  if (typeof version !== "string" || version.length > 64) return null;
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.+-]+)?$/.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `version` is a version number above `running`. What comes after the three numbers is not compared. */
export function isNewerVersion(version: unknown, running: string): boolean {
  const candidate = versionNumbers(version);
  const current = versionNumbers(running);
  if (candidate === null || current === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if (candidate[i] !== current[i]) return candidate[i] > current[i];
  }
  return false;
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** A table or column name as PostgreSQL keeps one: 1 to 63 bytes of UTF-8, with no NUL in it. */
function isPostgresName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 63 && !value.includes("\0");
}

function readSecrets(value: unknown): BackupSecrets | null {
  if (!isRecord(value)) return null;
  const { appEncryptionKey, githubToken } = value;
  // Checked as exactly as secrets.json is (src/core/secrets-file.ts): a key
  // that is wrong but still used would leave every saved password unreadable.
  if (typeof appEncryptionKey !== "string" || !/^[0-9a-f]{64}$/.test(appEncryptionKey)) return null;
  if (githubToken === undefined || githubToken === null) return { appEncryptionKey, githubToken: null };
  if (!isSavedTokenValid(githubToken)) return null;
  return { appEncryptionKey, githubToken };
}

function readChoices(value: unknown): BackupChoices | null {
  if (!isRecord(value)) return null;
  const { theme, github } = value;
  if (!isThemeChoice(theme) || !isRecord(github)) return null;
  const { owner, repo } = github;
  if (typeof owner !== "string" || typeof repo !== "string" || !isSavedRegistryValid(owner, repo)) return null;
  return { theme, github: { owner, repo } };
}

function readTables(value: unknown): BackupTable[] | null {
  if (!Array.isArray(value)) return null;
  const tables: BackupTable[] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { name, columns, rows } = item;
    if (!isPostgresName(name) || names.has(name)) return null;
    if (!Array.isArray(columns) || columns.length === 0 || columns.length > MAX_COLUMNS) return null;
    const columnNames = new Set<string>();
    for (const column of columns) {
      if (!isPostgresName(column) || columnNames.has(column)) return null;
      columnNames.add(column);
    }
    if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 0) return null;
    names.add(name);
    tables.push({ name, columns: [...columnNames], rows });
  }
  return tables;
}

function readSequences(value: unknown, tables: BackupTable[]): BackupSequence[] | null {
  if (!Array.isArray(value)) return null;
  const columnsOf = new Map(tables.map((table) => [table.name, new Set(table.columns)]));
  const sequences: BackupSequence[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { table, column, lastValue, isCalled } = item;
    if (typeof table !== "string" || typeof column !== "string") return null;
    // Only a column the backup holds can have its counter put back.
    if (columnsOf.get(table)?.has(column) !== true) return null;
    const key = JSON.stringify([table, column]);
    if (seen.has(key)) return null;
    // A bigint, the type every PostgreSQL counter has.
    if (typeof lastValue !== "string" || !/^-?\d{1,19}$/.test(lastValue)) return null;
    if (typeof isCalled !== "boolean") return null;
    seen.add(key);
    sequences.push({ table, column, lastValue, isCalled });
  }
  return sequences;
}

/**
 * Reads a backup's manifest. Throws a BackupFileError: "newer" when a newer
 * version of Schema Studio made it, and "damaged" when it is not a manifest
 * this version would write. The answer is a fresh object holding only the
 * fields described above.
 */
export function parseBackupManifest(text: string, runningVersion: string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BackupFileError("damaged");
  }
  if (!isRecord(value)) throw new BackupFileError("damaged");
  // Before anything else is checked, so that a newer version's manifest says
  // so, whatever else that version changed in it.
  if (isNewerVersion(value.appVersion, runningVersion)) throw new BackupFileError("newer");

  const { appVersion, createdAt } = value;
  if (typeof appVersion !== "string" || versionNumbers(appVersion) === null || !isIsoDate(createdAt)) {
    throw new BackupFileError("damaged");
  }
  const secrets = readSecrets(value.secrets);
  const config = readChoices(value.config);
  const tables = readTables(value.tables);
  const sequences = tables === null ? null : readSequences(value.sequences, tables);
  if (secrets === null || config === null || tables === null || sequences === null) throw new BackupFileError("damaged");
  return { appVersion, createdAt, secrets, config, tables, sequences };
}

/** What one record of a backup's contents turned out to be. */
export type BackupItem = { kind: "manifest"; manifest: BackupManifest } | { kind: "row"; table: BackupTable; row: string };

/**
 * Follows a backup's records in order, and checks that they are what a backup
 * holds: the manifest first, then exactly as many rows of each table as the
 * manifest says, in its order, and nothing after them. A row only has to look
 * like a JSON object here; PostgreSQL reads it properly when it is restored.
 */
export class ContentsReader {
  private readonly runningVersion: string;
  private manifest: BackupManifest | null = null;
  /** The table whose rows come next, as an index into the manifest's tables. */
  private tableIndex = 0;
  /** How many of that table's rows have been read. */
  private rowsRead = 0;

  constructor(runningVersion: string) {
    this.runningVersion = runningVersion;
  }

  read(record: string): BackupItem {
    if (this.manifest === null) {
      this.manifest = parseBackupManifest(record, this.runningVersion);
      return { kind: "manifest", manifest: this.manifest };
    }
    const table = this.currentTable(this.manifest);
    // A row with no table left to belong to: more rows than the manifest said.
    if (table === null) throw new BackupFileError("damaged");
    if (!record.startsWith("{") || !record.endsWith("}")) throw new BackupFileError("damaged");
    this.rowsRead += 1;
    return { kind: "row", table, row: record };
  }

  /** The manifest, once the contents have ended with every row it promised. */
  end(): BackupManifest {
    if (this.manifest === null || this.currentTable(this.manifest) !== null) throw new BackupFileError("damaged");
    return this.manifest;
  }

  /** The table the next row belongs to, or null when every table has all its rows. */
  private currentTable(manifest: BackupManifest): BackupTable | null {
    while (this.tableIndex < manifest.tables.length) {
      const table = manifest.tables[this.tableIndex];
      if (this.rowsRead < table.rows) return table;
      this.tableIndex += 1;
      this.rowsRead = 0;
    }
    return null;
  }
}

const RESTORE_ID = /^[0-9a-f]{32}$/;
const RESTORE_COMMENT_START = "Schema Studio restore ";

/** A new restore's ID: 16 random bytes, as hex. */
export function newRestoreId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * The comment a restore puts on the app's database, in the same transaction
 * as the rows. When the app next starts, finding it there is how it knows the
 * rows went in, even if it stopped before it heard back. Only hex digits are
 * ever in it, so it is safe to write into SQL as it is.
 */
export function restoreComment(id: string): string {
  if (!RESTORE_ID.test(id)) throw new Error(`Expected a restore ID of 32 hex digits, but got ${JSON.stringify(id)}.`);
  return `${RESTORE_COMMENT_START}${id}`;
}

/** The restore ID in the database's comment, or null when the comment is not one a restore wrote. */
export function restoreIdFromComment(comment: unknown): string | null {
  if (typeof comment !== "string" || !comment.startsWith(RESTORE_COMMENT_START)) return null;
  const id = comment.slice(RESTORE_COMMENT_START.length);
  return RESTORE_ID.test(id) ? id : null;
}

/**
 * What restore-pending.json holds while a restore is being finished: the
 * restore's ID, and the secrets and choices from the backup. The file is
 * written before the rows are committed, and the app puts its secrets and
 * choices in place when it next starts and finds the same ID in the database.
 * So the database and the key that opens its saved passwords always end up
 * from the same backup, even after a crash in between.
 */
export type PendingRestore = { id: string; secrets: BackupSecrets; config: BackupChoices };

/** The restore read back from restore-pending.json, or null when it is not what the app wrote. */
export function parsePendingRestore(value: unknown): PendingRestore | null {
  if (!isRecord(value)) return null;
  const { id } = value;
  if (typeof id !== "string" || !RESTORE_ID.test(id)) return null;
  const secrets = readSecrets(value.secrets);
  const config = readChoices(value.config);
  if (secrets === null || config === null) return null;
  return { id, secrets, config };
}
