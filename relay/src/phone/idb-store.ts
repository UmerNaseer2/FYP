/**
 * Where the phone keeps its pairing: the browser's IndexedDB, which can hold
 * the phone's private key as a key the page can use but never read out.
 * The pairing is read with readPairedComputer (store.ts), so a damaged or
 * older record reads as none, and the phone asks to pair again. Beside it is
 * when the computer was last seen, which only words a message, so losing it
 * costs nothing.
 */
import { readPairedComputer, type PairedComputer } from "./store.js";

const DATABASE = "schema-studio-phone";
const DATABASE_VERSION = 1;
const STORE = "pairing";
const KEY = "computer";
const LAST_SEEN = "last-seen";
/** How long the storage has to answer before the app says so, since a stuck browser never answers at all. */
const WITHIN_MS = 10_000;
const TOO_SLOW = "The phone's storage did not answer in time. Reload the page to try again.";

let opening: Promise<IDBDatabase> | null = null;

/** A storage failure as a sentence a person can act on. */
function storageError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return new Error("The phone is out of space for the app's data. Free some space, then try again.");
  }
  return new Error("The phone could not use the app's storage. Check that the browser is not in private browsing, then try again.");
}

/** `promise`, or a failure once WITHIN_MS have gone by. */
function withinTime<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(TOO_SLOW)), WITHIN_MS);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** The open database, opened once and again only after it fails or another tab upgrades it. */
function database(): Promise<IDBDatabase> {
  if (opening !== null) return opening;
  const attempt = withinTime(
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, DATABASE_VERSION);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(storageError(request.error));
    }),
  );
  opening = attempt;
  attempt.catch(() => {
    if (opening === attempt) opening = null;
  });
  return attempt;
}

/** Runs `use` in a transaction, with what its request gave once the transaction is done. */
async function inStore(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  const db = await database();
  return withinTime(
    new Promise<unknown>((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE, mode);
        // put() throws at once for a value the browser cannot store, so it is inside the try too.
        const request = use(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(storageError(transaction.error ?? request.error));
        transaction.onabort = () => reject(storageError(transaction.error ?? request.error));
      } catch (error) {
        reject(storageError(error));
      }
    }),
  );
}

/** The computer this phone is paired with, or null when there is none. */
export async function loadPairedComputer(): Promise<PairedComputer | null> {
  return readPairedComputer(await inStore("readonly", (store) => store.get(KEY)));
}

/** Saves the pairing, and asks the browser to keep it when space runs low. */
export async function savePairedComputer(record: PairedComputer): Promise<void> {
  await inStore("readwrite", (store) => store.put(record, KEY));
  navigator.storage?.persist?.().catch(() => {});
}

/** Forgets the pairing, and when that computer was last seen. */
export async function forgetPairedComputer(): Promise<void> {
  await inStore("readwrite", (store) => {
    store.delete(LAST_SEEN);
    return store.delete(KEY);
  });
}

/** When this computer was last seen, or null when that is not known. */
export async function loadLastSeen(desktopId: string): Promise<number | null> {
  const saved = await inStore("readonly", (store) => store.get(LAST_SEEN));
  if (typeof saved !== "object" || saved === null) return null;
  const { desktopId: savedId, at } = saved as { desktopId?: unknown; at?: unknown };
  return savedId === desktopId && typeof at === "number" && Number.isFinite(at) ? at : null;
}

/** Saves when this computer was last seen. */
export async function saveLastSeen(desktopId: string, at: number): Promise<void> {
  await inStore("readwrite", (store) => store.put({ desktopId, at }, LAST_SEEN));
}
