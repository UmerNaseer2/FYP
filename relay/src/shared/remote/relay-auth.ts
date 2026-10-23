/**
 * How the computer proves to the relay that its room there is its own.
 *
 * The relay keeps a room for each computer, and phones find the room by the
 * computer's ID. Anyone can connect to a room's address, so before the relay
 * lets a computer in as the room's owner, the computer signs a fresh
 * challenge from the relay with its private key. The ID is worked out from
 * the matching public key, so no computer can claim another's room, and the
 * relay needs no accounts and stores nothing.
 *
 * This is not what keeps messages private: they are encrypted end to end
 * (noise.ts), and the relay never holds a key that could open them. Signing
 * in only keeps strangers out of a computer's room. Even one who got in could
 * only keep the real computer out for a while; they could not read what a
 * phone sends or answer as the computer.
 *
 * The signing key is an Ed25519 key kept for this alone. The computer's
 * Noise key is used only in the handshake, because a key used in two
 * protocols could let something said in one be passed off in the other.
 */
import { concatBytes, fromBase64UrlOfLength, toBase64Url, utf8, type Bytes } from "./bytes.js";
import { KEY_BYTES, type KeyPair } from "./keys.js";

/**
 * A computer's ID is the start of its signing key's SHA-256 hash: 16 bytes,
 * short enough for a link and far too many to guess.
 */
export const DESKTOP_ID_BYTES = 16;
/** The relay's challenge: fresh random bytes for every sign-in. */
export const CHALLENGE_BYTES = 32;
/** An Ed25519 signature. */
export const SIGNATURE_BYTES = 64;

/**
 * Written in front of everything signed, so a signature made here can never
 * be passed off as one made for anything else, even with the same key.
 */
const SIGN_IN_CONTEXT = "Schema Studio relay sign-in 1\n";

const ED25519 = { name: "Ed25519" };

/** The ID of the computer whose signing key this is, as 22 base64url characters. */
export async function desktopIdFor(publicKey: Bytes): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey));
  return toBase64Url(hash.slice(0, DESKTOP_ID_BYTES));
}

/** True for text written exactly as desktopIdFor writes an ID. */
export function isDesktopId(text: unknown): text is string {
  return fromBase64UrlOfLength(text, DESKTOP_ID_BYTES) !== null;
}

/** What is signed: the context, the room's ID, then the challenge, so a signature is good for one room and one sign-in. */
function signedMessage(desktopId: string, challenge: Bytes): Bytes {
  return concatBytes(utf8(SIGN_IN_CONTEXT + desktopId + "\n"), challenge);
}

/** The computer's side: signs the relay's challenge. */
export async function signChallenge(signingKey: KeyPair, challenge: Bytes): Promise<Bytes> {
  if (challenge.length !== CHALLENGE_BYTES) throw new Error(`The relay's challenge must be ${CHALLENGE_BYTES} bytes.`);
  const desktopId = await desktopIdFor(signingKey.publicKey);
  const signature = await crypto.subtle.sign(ED25519, signingKey.privateKey, signedMessage(desktopId, challenge));
  return new Uint8Array(signature);
}

/**
 * The relay's side: true only when the signature over this challenge was
 * made with the key whose ID is this room's.
 */
export async function checkChallenge(desktopId: string, challenge: Bytes, publicKey: Bytes, signature: Bytes): Promise<boolean> {
  if (challenge.length !== CHALLENGE_BYTES || publicKey.length !== KEY_BYTES || signature.length !== SIGNATURE_BYTES) return false;
  try {
    if ((await desktopIdFor(publicKey)) !== desktopId) return false;
    const key = await crypto.subtle.importKey("raw", publicKey, ED25519, false, ["verify"]);
    return await crypto.subtle.verify(ED25519, key, signature, signedMessage(desktopId, challenge));
  } catch {
    // Web Crypto refused the key or the signature, so it was not a good one.
    return false;
  }
}
