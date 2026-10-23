/**
 * Reading the phone link's JSON messages: the pairing messages (pairing.ts),
 * and the requests and answers that follow (rpc.ts).
 *
 * JSON.parse accepts any JSON at all, so these helpers first check that a
 * message is an object, and which fields it has, before anything is read
 * from it.
 */
import { readUtf8, type Bytes } from "./bytes.js";

/**
 * The fields of a JSON object, or null for anything else: an array, null, a
 * string, a number, true or false, or a field that is not there at all.
 */
export function objectFields(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // Just checked to be a plain object, so its fields can be looked at.
  return value as Record<string, unknown>;
}

/** True when the object has exactly these fields, and no others. */
export function hasExactly(fields: Record<string, unknown>, ...names: string[]): boolean {
  // Every field must be named, and there must be as many as there are names,
  // so a name given twice can never stand in for a field it does not name.
  const keys = Object.keys(fields);
  return keys.length === names.length && keys.every((key) => names.includes(key));
}

/** Reads a JSON object sent as UTF-8, or gives null when the bytes are anything else. */
export function readJsonObject(bytes: Bytes): Record<string, unknown> | null {
  const text = readUtf8(bytes);
  if (text === null) return null;
  try {
    return objectFields(JSON.parse(text));
  } catch {
    return null;
  }
}
