// The id a deploy or rollback run goes by, so the Stop button can name the
// run it means. The page makes one per run and sends it with the request; a
// caller that sends none gets one made by the server instead.
//
// No imports, so the page and the server can both use it.

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fresh random run id (a version 4 UUID). */
export function newRunId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  // randomUUID exists only on secure pages; a plain-http LAN page still has
  // getRandomValues.
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** True for a well-formed run id. */
export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID.test(value);
}
