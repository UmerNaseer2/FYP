/**
 * Checks a phone's passkey for the computer: the passkey a phone makes when
 * it sets up approvals, and each signature it makes with it to approve or
 * reject a deploy or rollback request (src/main/phone-approvals.ts).
 *
 * The phone app runs in the phone's browser at the relay's address, so the
 * browser ties the passkey to the relay's host name and writes the address
 * the page ran at into what the passkey signs. Both are checked here, so a
 * passkey made for, or a signature made on, any other page is refused.
 *
 * Only what the phone app asks for is taken: an ES256 key (P-256 with
 * SHA-256), used only once the person has shown it is them with Face ID, a
 * fingerprint or the phone's code. The browser is asked for no attestation,
 * so nothing here checks which maker's phone holds the key: the phone link
 * already says which phone this is.
 *
 * Pure: no files and no clock. It reads only as much CBOR as passkeys write.
 *
 * Tested in src/test/webauthn.test.ts.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

import { concatBytes, readUtf8, sameBytes, toBase64Url, utf8, type Bytes } from "../shared/remote/bytes";
import { readJsonObject } from "../shared/remote/json";

/** The public half of a passkey: a P-256 point's x and y, base64url. */
export type PasskeyKey = { x: string; y: string };

/** What the computer expects a passkey to have signed. */
export type Expected = {
  /** The challenge the phone was given, or the one it had to sign (src/shared/remote/approval.ts). */
  challenge: Bytes;
  /** The relay's origin, where the phone app runs, such as "https://relay.example.com". */
  origin: string;
};

/** A passkey as a phone just made it. */
export type NewPasskey = { credentialId: Bytes; key: PasskeyKey; signCount: number };

/** A check's answer. A refusal's reason is a fixed sentence for the log, never anything the phone sent. */
export type Checked<T> = ({ ok: true } & T) | { ok: false; reason: string };

/** The longest credential ID a passkey may have, in bytes, as WebAuthn sets it. */
export const MAX_CREDENTIAL_ID_BYTES = 1023;

const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED_CREDENTIAL = 0x40;
const EXTENSIONS = 0x80;
const MAX_CBOR_DEPTH = 8;

type Cbor = number | string | boolean | null | Bytes | Cbor[] | Map<number | string, Cbor>;
type AuthData = { rpIdHash: Bytes; flags: number; signCount: number; credential: { id: Bytes; key: Cbor } | null };

/** Reads the passkey a phone made (navigator.credentials.create), or why it is refused. */
export function readNewPasskey(clientDataJSON: Bytes, attestationObject: Bytes, expected: Expected): Checked<{ passkey: NewPasskey }> {
  const clientProblem = clientDataProblem(clientDataJSON, "webauthn.create", expected);
  if (clientProblem !== null) return refuse(clientProblem);
  // Any attestation format is taken, and its statement is not read: the
  // phone app asks for none, and the phone link already vouches for the phone.
  const attestation = readWholeCbor(attestationObject);
  const authBytes = attestation instanceof Map ? attestation.get("authData") : undefined;
  if (!(attestation instanceof Map) || typeof attestation.get("fmt") !== "string" || !(attestation.get("attStmt") instanceof Map) || !(authBytes instanceof Uint8Array)) {
    return refuse("The attestation object is not one a browser writes.");
  }
  const authData = readAuthData(authBytes);
  if (authData === null) return refuse("The authenticator data could not be read.");
  const authProblem = authDataProblem(authData, expected);
  if (authProblem !== null) return refuse(authProblem);
  if (authData.credential === null) return refuse("The authenticator data holds no passkey.");
  const key = readCoseKey(authData.credential.key);
  if (key === null) return refuse("The passkey is not a P-256 key for ES256.");
  return { ok: true, passkey: { credentialId: authData.credential.id, key, signCount: authData.signCount } };
}

/** What a phone sends to prove its passkey signed a challenge (navigator.credentials.get). */
export type Assertion = { authenticatorData: Bytes; clientDataJSON: Bytes; signature: Bytes };

/**
 * Checks that the passkey with this key signed the expected challenge, and
 * gives the signature counter to keep for next time, or why it is refused.
 * `lastCount` is the counter kept from the passkey's last signature.
 */
export function checkAssertion(assertion: Assertion, key: PasskeyKey, lastCount: number, expected: Expected): Checked<{ signCount: number }> {
  const clientProblem = clientDataProblem(assertion.clientDataJSON, "webauthn.get", expected);
  if (clientProblem !== null) return refuse(clientProblem);
  const authData = readAuthData(assertion.authenticatorData);
  if (authData === null || authData.credential !== null) return refuse("The authenticator data could not be read.");
  const authProblem = authDataProblem(authData, expected);
  if (authProblem !== null) return refuse(authProblem);
  const publicKey = keyObject(key);
  if (publicKey === null) return refuse("The passkey kept for this phone is not a P-256 key.");
  const signed = concatBytes(assertion.authenticatorData, sha256(assertion.clientDataJSON));
  if (!signatureMatches(signed, publicKey, assertion.signature)) return refuse("The signature is not the passkey's.");
  const signCount = nextSignCount(lastCount, authData.signCount);
  if (signCount === null) return refuse("The passkey's signature counter went back, so the passkey may have been copied.");
  return { ok: true, signCount };
}

/**
 * The counter to keep after a signature, or null when it went back. A passkey
 * that keeps no counter (as synced passkeys do) always says 0; one that does
 * must say more each time, or something else may have signed with a copy.
 */
export function nextSignCount(lastCount: number, signCount: number): number | null {
  if (lastCount === 0 && signCount === 0) return 0;
  return signCount > lastCount ? signCount : null;
}

/** Whether a key is one checkAssertion can use. A phone's passkey is checked with this once, when it is first read. */
export function isUsableKey(key: PasskeyKey): boolean {
  return keyObject(key) !== null;
}

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** What is wrong with a clientDataJSON, or null when it is what was expected. */
function clientDataProblem(clientDataJSON: Bytes, type: "webauthn.create" | "webauthn.get", expected: Expected): string | null {
  const fields = readJsonObject(clientDataJSON);
  if (fields === null) return "The browser's clientDataJSON is not a JSON object.";
  if (fields.type !== type) return `The browser's clientDataJSON is not for ${type}.`;
  if (fields.challenge !== toBase64Url(expected.challenge)) return "The passkey signed some other challenge.";
  if (fields.origin !== expected.origin) return "The passkey was used on another page than the phone app.";
  // A page inside a frame on some other site may not stand in for the phone app.
  if (fields.crossOrigin !== undefined && fields.crossOrigin !== false) return "The passkey was used inside a frame.";
  return null;
}

/** What is wrong with authenticator data, or null when it is for the relay and the person was there and verified. */
function authDataProblem(authData: AuthData, expected: Expected): string | null {
  const rpId = new URL(expected.origin).hostname;
  if (!sameBytes(authData.rpIdHash, sha256(utf8(rpId)))) return "The passkey is not for the relay's address.";
  if ((authData.flags & USER_PRESENT) === 0) return "The passkey was used without the person there.";
  if ((authData.flags & USER_VERIFIED) === 0) return "The passkey was used without Face ID, a fingerprint or the phone's code.";
  return null;
}

/**
 * Reads authenticator data: the relying party's hash (32 bytes), the flags
 * (1), the signature counter (4, big-endian), then the new passkey when the
 * flags say there is one (its AAGUID, its ID's length and ID, then its key
 * in CBOR), then the extensions, in CBOR, when the flags say there are some.
 */
function readAuthData(bytes: Bytes): AuthData | null {
  if (bytes.length < 37) return null;
  const flags = bytes[32];
  const signCount = bytes[33] * 0x1000000 + bytes[34] * 0x10000 + bytes[35] * 0x100 + bytes[36];
  let at = 37;
  let credential: AuthData["credential"] = null;
  if ((flags & ATTESTED_CREDENTIAL) !== 0) {
    if (bytes.length < at + 18) return null;
    const idLength = bytes[at + 16] * 0x100 + bytes[at + 17];
    at += 18;
    if (idLength < 1 || idLength > MAX_CREDENTIAL_ID_BYTES || idLength > bytes.length - at) return null;
    const key = readCbor(bytes, at + idLength, 0);
    if (key === null) return null;
    credential = { id: bytes.slice(at, at + idLength), key: key.value };
    at = key.end;
  }
  if ((flags & EXTENSIONS) !== 0) {
    const extensions = readCbor(bytes, at, 0);
    if (extensions === null || !(extensions.value instanceof Map)) return null;
    at = extensions.end;
  }
  return at === bytes.length ? { rpIdHash: bytes.slice(0, 32), flags, signCount, credential } : null;
}

/** Reads a COSE key that is exactly an ES256 key on P-256: kty 2 (EC2), alg -7, crv 1, and x and y of 32 bytes each. */
function readCoseKey(value: Cbor): PasskeyKey | null {
  if (!(value instanceof Map) || value.size !== 5) return null;
  const x = value.get(-2);
  const y = value.get(-3);
  if (value.get(1) !== 2 || value.get(3) !== -7 || value.get(-1) !== 1) return null;
  if (!(x instanceof Uint8Array) || x.length !== 32 || !(y instanceof Uint8Array) || y.length !== 32) return null;
  const key = { x: toBase64Url(x), y: toBase64Url(y) };
  return isUsableKey(key) ? key : null;
}

/** The key as node:crypto uses it, or null when the point is not on P-256. */
function keyObject(key: PasskeyKey): KeyObject | null {
  try {
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x: key.x, y: key.y }, format: "jwk" });
  } catch {
    return null;
  }
}

/** A passkey's ES256 signature is DER-encoded, as WebAuthn writes it. */
function signatureMatches(signed: Bytes, key: KeyObject, signature: Bytes): boolean {
  try {
    return verify("sha256", signed, { key, dsaEncoding: "der" }, signature);
  } catch {
    return false;
  }
}

function sha256(bytes: Uint8Array): Bytes {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/** One CBOR item that fills `bytes` exactly, or null. */
function readWholeCbor(bytes: Bytes): Cbor | null {
  const item = readCbor(bytes, 0, 0);
  return item !== null && item.end === bytes.length ? item.value : null;
}

/**
 * Reads the CBOR item that starts at `start`, and where it ends, or gives
 * null when it is not one this file reads. Only definite lengths, integers,
 * byte and text strings, arrays, maps with integer or text keys (each once),
 * and false, true and null: all a passkey writes.
 */
function readCbor(bytes: Bytes, start: number, depth: number): { value: Cbor; end: number } | null {
  if (start >= bytes.length || depth > MAX_CBOR_DEPTH) return null;
  const major = bytes[start] >> 5;
  const info = bytes[start] & 0x1f;
  if (major === 7) {
    const simple = info === 20 ? false : info === 21 ? true : info === 22 ? null : undefined;
    return simple === undefined ? null : { value: simple, end: start + 1 };
  }
  const argument = readArgument(bytes, start + 1, info);
  if (argument === null) return null;
  const { value: size } = argument;
  let at = argument.end;
  switch (major) {
    case 0:
      return { value: size, end: at };
    case 1:
      return { value: -1 - size, end: at };
    case 2:
    case 3: {
      if (size > bytes.length - at) return null;
      const content = bytes.slice(at, at + size);
      if (major === 2) return { value: content, end: at + size };
      const text = readUtf8(content);
      return text === null ? null : { value: text, end: at + size };
    }
    case 4: {
      // Every item takes at least a byte, so a size past the end is a lie.
      if (size > bytes.length - at) return null;
      const items: Cbor[] = [];
      for (let index = 0; index < size; index++) {
        const item = readCbor(bytes, at, depth + 1);
        if (item === null) return null;
        items.push(item.value);
        at = item.end;
      }
      return { value: items, end: at };
    }
    case 5: {
      if (size > bytes.length - at) return null;
      const map = new Map<number | string, Cbor>();
      for (let index = 0; index < size; index++) {
        const key = readCbor(bytes, at, depth + 1);
        if (key === null || (typeof key.value !== "number" && typeof key.value !== "string") || map.has(key.value)) return null;
        const item = readCbor(bytes, key.end, depth + 1);
        if (item === null) return null;
        map.set(key.value, item.value);
        at = item.end;
      }
      return { value: map, end: at };
    }
    default:
      return null;
  }
}

/** A CBOR head's number: in the head itself below 24, else in the 1, 2, 4 or 8 bytes after it. */
function readArgument(bytes: Bytes, at: number, info: number): { value: number; end: number } | null {
  if (info < 24) return { value: info, end: at };
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (size === 0 || size > bytes.length - at) return null;
  let value = 0;
  for (let index = 0; index < size; index++) value = value * 256 + bytes[at + index];
  return Number.isSafeInteger(value) ? { value, end: at + size } : null;
}
