/**
 * A passkey made in software for the approval tests: it answers as a phone's
 * browser and passkey would, so the computer's checks can be tested without
 * a phone. Its keys are made when a test runs and are never written anywhere.
 * Not a test file itself, so `npm test` runs only the tests that use it.
 */
import crypto from "node:crypto";

export const RELAY_ORIGIN = "https://relay.example.test";

export type SoftwarePasskey = { credentialId: Buffer; privateKey: crypto.KeyObject; x: Buffer; y: Buffer; signCount: number };

/** A new ES256 passkey. `signCount` is what its next signature says, and 0 keeps it at 0 as a synced passkey does. */
export function newSoftwarePasskey(signCount = 0): SoftwarePasskey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return { credentialId: crypto.randomBytes(16), privateKey, x: Buffer.from(String(jwk.x), "base64url"), y: Buffer.from(String(jwk.y), "base64url"), signCount };
}

type CborValue = number | string | Uint8Array | CborValue[] | Map<number | string, CborValue>;

/** CBOR as a passkey writes it: integers, byte and text strings, arrays and maps, all of definite length. */
export function cbor(value: CborValue): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value, "utf8")]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
}

function head(major: number, size: number): Buffer {
  if (size < 24) return Buffer.from([major * 32 + size]);
  if (size < 256) return Buffer.from([major * 32 + 24, size]);
  const bytes = Buffer.alloc(size < 65536 ? 3 : 5);
  bytes[0] = major * 32 + (size < 65536 ? 25 : 26);
  if (size < 65536) bytes.writeUInt16BE(size, 1);
  else bytes.writeUInt32BE(size, 1);
  return bytes;
}

/** The passkey's public key as a COSE key: EC2, ES256, P-256. */
export function coseKey(passkey: SoftwarePasskey): Map<number, CborValue> {
  return new Map<number, CborValue>([[1, 2], [3, -7], [-1, 1], [-2, passkey.x], [-3, passkey.y]]);
}

export type Options = {
  origin?: string;
  rpId?: string;
  flags?: number;
  type?: string;
  /** More fields for the clientDataJSON, such as crossOrigin. */
  clientData?: Record<string, unknown>;
};

/** What the browser writes for the passkey to sign. */
export function clientDataJSON(type: string, challenge: Uint8Array, options: Options = {}): Buffer {
  const fields = { type: options.type ?? type, challenge: Buffer.from(challenge).toString("base64url"), origin: options.origin ?? RELAY_ORIGIN, crossOrigin: false, ...options.clientData };
  return Buffer.from(JSON.stringify(fields), "utf8");
}

/** Authenticator data: the relay's hash, the flags (present and verified unless told otherwise), the counter, then anything after. */
export function authenticatorData(signCount: number, options: Options = {}, after: Buffer = Buffer.alloc(0)): Buffer {
  const rpIdHash = crypto.createHash("sha256").update(options.rpId ?? new URL(RELAY_ORIGIN).hostname).digest();
  const count = Buffer.alloc(4);
  count.writeUInt32BE(signCount);
  const flags = options.flags ?? (after.length > 0 ? 0x45 : 0x05);
  return Buffer.concat([rpIdHash, Buffer.from([flags]), count, after]);
}

/** The passkey's ID and key, as authenticator data carries a new passkey. */
export function attestedCredential(passkey: SoftwarePasskey, key: CborValue = coseKey(passkey)): Buffer {
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(passkey.credentialId.length);
  return Buffer.concat([Buffer.alloc(16), idLength, passkey.credentialId, cbor(key)]);
}

/** What navigator.credentials.create gives the phone app, with attestation "none". */
export function registration(passkey: SoftwarePasskey, challenge: Uint8Array, options: Options = {}): { clientDataJSON: Buffer; attestationObject: Buffer } {
  const authData = authenticatorData(passkey.signCount, options, attestedCredential(passkey));
  const attestationObject = cbor(new Map<string, CborValue>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
  return { clientDataJSON: clientDataJSON("webauthn.create", challenge, options), attestationObject };
}

/** What navigator.credentials.get gives the phone app: the passkey's signature over the challenge. Counts up when the passkey keeps a counter. */
export function assertion(passkey: SoftwarePasskey, challenge: Uint8Array, options: Options = {}): { authenticatorData: Buffer; clientDataJSON: Buffer; signature: Buffer } {
  if (passkey.signCount > 0) passkey.signCount += 1;
  const authData = authenticatorData(passkey.signCount, options);
  const clientData = clientDataJSON("webauthn.get", challenge, options);
  const signed = Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]);
  const signature = crypto.sign("sha256", signed, { key: passkey.privateKey, dsaEncoding: "der" });
  return { authenticatorData: authData, clientDataJSON: clientData, signature };
}
