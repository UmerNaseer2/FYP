/**
 * Reading a backup file from start to end. The app restores from it, and the
 * data migration tool (my-app/scripts/move-data.cjs) reads one without Electron,
 * because the file and its passphrase are the only way a desktop's data and key
 * can leave it.
 */
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";

import {
  BackupFileError,
  ChunkOpener,
  ContentsReader,
  HEADER_BYTES,
  openBackupKey,
  readBackupHeader,
  RecordReader,
  type BackupItem,
  type BackupManifest,
} from "./backup-file";

/** How much of a backup file is read at a time. */
const READ_BYTES = 1024 * 1024;

/** Reads the start of the file, as much of it as a backup's header takes. */
export async function readStart(handle: FileHandle): Promise<Buffer> {
  const start = Buffer.alloc(HEADER_BYTES);
  let filled = 0;
  while (filled < HEADER_BYTES) {
    const { bytesRead } = await handle.read(start, filled, HEADER_BYTES - filled, null);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return start.subarray(0, filled);
}

/**
 * Reads the rest of the file after its header: opens each chunk, splits the
 * records apart and hands each item to `take`, in order. Gives back the
 * manifest once the whole file is read and every row it promised was there.
 */
export async function readContents(
  handle: FileHandle,
  header: Buffer,
  key: Buffer,
  appVersion: string,
  take: (item: BackupItem) => Promise<void>,
): Promise<BackupManifest> {
  const opener = new ChunkOpener(key, header);
  const records = new RecordReader();
  const contents = new ContentsReader(appVersion);
  const hand = async (opened: Buffer[]): Promise<void> => {
    for (const plain of opened) {
      for (const record of records.push(plain)) await take(contents.read(record));
    }
  };
  for (;;) {
    // A new buffer for each read: after a short read, which a network drive can give mid-file, the
    // opener holds on to this buffer until it has a whole chunk, so the next read must not write over it.
    const buffer = Buffer.allocUnsafe(READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, READ_BYTES, null);
    if (bytesRead === 0) break;
    await hand(opener.write(buffer.subarray(0, bytesRead)));
  }
  await hand([opener.end()]);
  records.end();
  return contents.end();
}

/**
 * A whole backup in memory: its manifest and each table's rows, every row still
 * the JSON text the file holds. Throws BackupFileError when the file is not a
 * backup, the passphrase is wrong, or the file is damaged.
 */
export async function readBackupFile(
  file: string,
  passphrase: string,
  appVersion: string,
): Promise<{ manifest: BackupManifest; rows: Map<string, string[]> }> {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new BackupFileError("not-a-backup");
    const header = readBackupHeader(await readStart(handle));
    const key = await openBackupKey(header, passphrase);
    const rows = new Map<string, string[]>();
    const manifest = await readContents(handle, header.bytes, key, appVersion, async (item) => {
      if (item.kind !== "row") return;
      const list = rows.get(item.table.name);
      if (list === undefined) rows.set(item.table.name, [item.row]);
      else list.push(item.row);
    });
    return { manifest, rows };
  } finally {
    await handle.close().catch(() => {});
  }
}
