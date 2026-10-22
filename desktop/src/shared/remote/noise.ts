/**
 * The encryption between a phone and the computer.
 *
 * Every message between them goes through the relay, a small service on the
 * internet, so it is encrypted end to end: the relay, and anyone watching the
 * network, sees only how big each message is and when it was sent. Before
 * anything else is said, the phone checks that it is talking to its own
 * computer, and the computer checks that it is talking to a phone it paired.
 *
 * Nothing here is invented. It is the Noise Protocol Framework
 * (https://noiseprotocol.org/noise.html, revision 34) with its IK handshake,
 * written out step by step as the specification gives it:
 *
 *   Noise_IK_25519_AESGCM_SHA256
 *     <- s                  the phone already knows the computer's key
 *     ...
 *     -> e, es, s, ss       the phone's first message
 *     <- e, ee, se          the computer's answer
 *
 * The phone (the "initiator") has the computer's public key from the pairing
 * code, so the handshake is one message each way. The phone's own key travels
 * inside the first message, encrypted. After the answer both sides hold two
 * keys, one for each direction, and every later message is sealed with
 * AES-256-GCM under its own counter. A message that was changed, replayed,
 * dropped or reordered therefore fails to open, and the link is closed.
 *
 * src/test/remote-noise.test.ts checks this byte for byte against the
 * published test vectors for exactly this protocol name.
 *
 * What may be sent where:
 *  - The first message's payload can be read only by the computer, and only
 *    the holder of the phone's key could have written it. But it is not
 *    forward secret, and anyone can replay it. So it carries only things that
 *    are worthless later: the one-time pairing secret and the phone's name.
 *  - The answer's payload and everything after it are forward secret: even
 *    someone who later steals both keys cannot read them.
 */
import { concatBytes, sameBytes, utf8, type Bytes } from "./bytes.js";
import { generateKeyPair, KEY_BYTES, type Key, type KeyPair } from "./keys.js";

export const PROTOCOL_NAME = "Noise_IK_25519_AESGCM_SHA256";

/** What AES-GCM adds to each message to prove it was not changed. */
export const TAG_BYTES = 16;
/** The longest message Noise allows. */
export const MAX_MESSAGE_BYTES = 65535;
/** The most one sealed message can carry. */
export const MAX_PLAINTEXT_BYTES = MAX_MESSAGE_BYTES - TAG_BYTES;

/** The length of a SHA-256 hash. */
const HASH_BYTES = 32;

/** A handshake or a message failed. The link must then be closed. */
export class NoiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoiseError";
  }
}

const X25519 = { name: "X25519" };
const EMPTY: Bytes = new Uint8Array(0);
const NO_SECRET: Bytes = new Uint8Array(KEY_BYTES);

/** X25519: the secret one side's private key and the other side's public key agree on. */
async function dh(privateKey: Key, publicKey: Bytes): Promise<Bytes> {
  let secret: Bytes | null = null;
  try {
    const theirs = await crypto.subtle.importKey("raw", publicKey, X25519, true, []);
    secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: theirs }, privateKey, 256));
  } catch {
    // Web Crypto refused the public key, so there is no secret.
  }
  // A few public keys give a secret of all zeros whatever the private key is,
  // which would be no secret at all. Web Crypto is meant to refuse those
  // itself; checking here as well means no platform has to be trusted on it.
  // sameBytes takes as long whatever it finds, so the check gives nothing away.
  if (secret === null || sameBytes(secret, NO_SECRET)) throw new NoiseError("The other side sent a key that cannot be used.");
  return secret;
}

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const hmacKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, data));
}

/**
 * The specification's HKDF with two outputs (section 4.3), written with HMAC
 * exactly as the specification gives it, so each line can be checked against
 * it.
 */
async function hkdf(chainingKey: Bytes, inputKeyMaterial: Bytes): Promise<[Bytes, Bytes]> {
  const tempKey = await hmac(chainingKey, inputKeyMaterial);
  const output1 = await hmac(tempKey, Uint8Array.of(0x01));
  const output2 = await hmac(tempKey, concatBytes(output1, Uint8Array.of(0x02)));
  return [output1, output2];
}

/** The specification's CipherState: one key, and the counter that numbers its messages. */
class CipherState {
  private key: Key | null = null;
  private nonce = 0;

  async initializeKey(raw: Bytes): Promise<void> {
    this.key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    this.nonce = 0;
  }

  async encryptWithAd(ad: Bytes, plaintext: Bytes): Promise<Bytes> {
    if (this.key === null) return plaintext;
    const iv = this.takeNonce();
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad, tagLength: 128 }, this.key, plaintext);
    return new Uint8Array(sealed);
  }

  /**
   * The specification keeps the counter where it was when a message fails to
   * open, so the next one can still be tried. Here a failure is final (the
   * link is closed), so it does not matter that the counter was already taken.
   */
  async decryptWithAd(ad: Bytes, ciphertext: Bytes): Promise<Bytes> {
    if (this.key === null) return ciphertext;
    const iv = this.takeNonce();
    try {
      const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: ad, tagLength: 128 }, this.key, ciphertext);
      return new Uint8Array(opened);
    } catch {
      throw new NoiseError("A message did not open: it was changed, replayed, sent out of order or meant for another key.");
    }
  }

  /**
   * AES-GCM's 12-byte nonce, as the specification sets it: four zero bytes,
   * then the counter as a big-endian 64-bit number. A counter must never be
   * used twice with one key, so it is taken as soon as it is read.
   */
  private takeNonce(): Bytes {
    // Far more messages than any link will ever send, but a counter that ran
    // out would repeat, so the link stops instead.
    if (this.nonce >= Number.MAX_SAFE_INTEGER) throw new NoiseError("This link has sent too many messages and must start again.");
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, BigInt(this.nonce), false);
    this.nonce += 1;
    return iv;
  }
}

/** The specification's SymmetricState: everything the handshake has seen, mixed into a hash and a key. */
class SymmetricState {
  readonly cipher = new CipherState();
  private chainingKey: Bytes;
  private hash: Bytes;

  /** InitializeSymmetric, MixHash(prologue), then the pre-message `<- s`. */
  static async start(prologue: Bytes, responderStaticKey: Bytes): Promise<SymmetricState> {
    // The protocol's name is shorter than a hash, so the specification uses it
    // as it is, padded with zeros, rather than hashing it.
    const h = new Uint8Array(HASH_BYTES);
    h.set(utf8(PROTOCOL_NAME));
    const state = new SymmetricState(h);
    await state.mixHash(prologue);
    await state.mixHash(responderStaticKey);
    return state;
  }

  private constructor(h: Bytes) {
    this.hash = h;
    this.chainingKey = h;
  }

  get handshakeHash(): Bytes {
    return this.hash;
  }

  async mixKey(inputKeyMaterial: Bytes): Promise<void> {
    const [chainingKey, tempKey] = await hkdf(this.chainingKey, inputKeyMaterial);
    this.chainingKey = chainingKey;
    await this.cipher.initializeKey(tempKey);
  }

  async mixHash(data: Bytes): Promise<void> {
    this.hash = await sha256(concatBytes(this.hash, data));
  }

  async encryptAndHash(plaintext: Bytes): Promise<Bytes> {
    const ciphertext = await this.cipher.encryptWithAd(this.hash, plaintext);
    await this.mixHash(ciphertext);
    return ciphertext;
  }

  async decryptAndHash(ciphertext: Bytes): Promise<Bytes> {
    const plaintext = await this.cipher.decryptWithAd(this.hash, ciphertext);
    await this.mixHash(ciphertext);
    return plaintext;
  }

  /** Split: the two keys for after the handshake, the initiator's sending key first. */
  async split(): Promise<[CipherState, CipherState]> {
    const [key1, key2] = await hkdf(this.chainingKey, EMPTY);
    const first = new CipherState();
    await first.initializeKey(key1);
    const second = new CipherState();
    await second.initializeKey(key2);
    return [first, second];
  }
}

export type HandshakeOptions = {
  /** Words both sides must agree on, which tie the handshake to this app and its version. */
  prologue: Bytes;
  /** This side's long-lived key pair. */
  staticKey: KeyPair;
  /**
   * Only for the published test vectors, which fix it. Leave it out: a fresh
   * key for every handshake is what makes the link forward secret.
   */
  ephemeralKeyForTests?: KeyPair;
};

/** The size of the phone's first message before its payload: e, then s with its tag, then the payload's tag. */
const FIRST_MESSAGE_OVERHEAD = KEY_BYTES + KEY_BYTES + TAG_BYTES + TAG_BYTES;
/** The size of the computer's answer before its payload: e, then the payload's tag. */
const ANSWER_OVERHEAD = KEY_BYTES + TAG_BYTES;

const OUT_OF_ORDER = "The handshake's steps were taken out of order.";

type Stage = "first" | "second" | "busy" | "done" | "failed";

/**
 * What both sides of a handshake share: its two steps must be taken once
 * each, in order, one at a time, and any failure is final.
 */
abstract class Handshake {
  private stage: Stage = "first";

  protected async step<T>(expected: "first" | "second", next: "second" | "done", work: () => Promise<T>): Promise<T> {
    // Checked before anything is awaited, so a step called while another is
    // still running is refused instead of mixing into it.
    if (this.stage === "failed") throw new NoiseError("This handshake already failed.");
    if (this.stage !== expected) throw new NoiseError(OUT_OF_ORDER);
    this.stage = "busy";
    try {
      const result = await work();
      this.stage = next;
      return result;
    } catch (error) {
      this.stage = "failed";
      throw error instanceof NoiseError ? error : new NoiseError("The handshake failed.");
    }
  }
}

/** The phone's side of the handshake. */
export class Initiator extends Handshake {
  private state: SymmetricState | null = null;
  private ephemeral: KeyPair | null = null;

  constructor(private readonly options: HandshakeOptions & { remoteStaticKey: Bytes }) {
    super();
  }

  /** `-> e, es, s, ss`, then the payload. */
  writeFirstMessage(payload: Bytes): Promise<Bytes> {
    return this.step("first", "second", async () => {
      const { prologue, staticKey, remoteStaticKey } = this.options;
      if (remoteStaticKey.length !== KEY_BYTES) throw new NoiseError("The computer's key must be 32 bytes.");
      if (payload.length > MAX_MESSAGE_BYTES - FIRST_MESSAGE_OVERHEAD) throw new NoiseError("The first message's payload is too big.");
      const state = await SymmetricState.start(prologue, remoteStaticKey);
      const e = this.options.ephemeralKeyForTests ?? (await generateKeyPair("X25519", false));
      await state.mixHash(e.publicKey);
      await state.mixKey(await dh(e.privateKey, remoteStaticKey));
      const encryptedStatic = await state.encryptAndHash(staticKey.publicKey);
      await state.mixKey(await dh(staticKey.privateKey, remoteStaticKey));
      const encryptedPayload = await state.encryptAndHash(payload);
      this.state = state;
      this.ephemeral = e;
      return concatBytes(e.publicKey, encryptedStatic, encryptedPayload);
    });
  }

  /** `<- e, ee, se`: reads the computer's answer and gives the open link. */
  readAnswer(message: Bytes): Promise<{ payload: Bytes; session: Session }> {
    return this.step("second", "done", async () => {
      const state = this.state;
      const e = this.ephemeral;
      if (state === null || e === null) throw new NoiseError(OUT_OF_ORDER);
      // Forward secrecy depends on the throwaway key being forgotten, so the
      // handshake lets go of it, and of everything else, as it finishes.
      this.state = null;
      this.ephemeral = null;
      if (message.length < ANSWER_OVERHEAD || message.length > MAX_MESSAGE_BYTES) throw new NoiseError("The answer is the wrong size.");
      const remoteEphemeral = message.slice(0, KEY_BYTES);
      await state.mixHash(remoteEphemeral);
      await state.mixKey(await dh(e.privateKey, remoteEphemeral));
      await state.mixKey(await dh(this.options.staticKey.privateKey, remoteEphemeral));
      const payload = await state.decryptAndHash(message.slice(KEY_BYTES));
      const [sending, receiving] = await state.split();
      return { payload, session: new Session(sending, receiving, state.handshakeHash) };
    });
  }
}

/** The computer's side of the handshake. */
export class Responder extends Handshake {
  private state: SymmetricState | null = null;
  private remoteEphemeral: Bytes | null = null;
  private remoteStatic: Bytes | null = null;

  constructor(private readonly options: HandshakeOptions) {
    super();
  }

  /**
   * `<- e, es, s, ss`: reads the phone's first message. It gives the phone's
   * public key with the payload; whether that phone may go on is for the
   * caller to decide before it answers.
   */
  readFirstMessage(message: Bytes): Promise<{ payload: Bytes; remoteStaticKey: Bytes }> {
    return this.step("first", "second", async () => {
      if (message.length < FIRST_MESSAGE_OVERHEAD || message.length > MAX_MESSAGE_BYTES) throw new NoiseError("The first message is the wrong size.");
      const { prologue, staticKey } = this.options;
      const state = await SymmetricState.start(prologue, staticKey.publicKey);
      const remoteEphemeral = message.slice(0, KEY_BYTES);
      await state.mixHash(remoteEphemeral);
      await state.mixKey(await dh(staticKey.privateKey, remoteEphemeral));
      const remoteStatic = await state.decryptAndHash(message.slice(KEY_BYTES, KEY_BYTES * 2 + TAG_BYTES));
      await state.mixKey(await dh(staticKey.privateKey, remoteStatic));
      const payload = await state.decryptAndHash(message.slice(KEY_BYTES * 2 + TAG_BYTES));
      this.state = state;
      this.remoteEphemeral = remoteEphemeral;
      this.remoteStatic = remoteStatic;
      return { payload, remoteStaticKey: remoteStatic };
    });
  }

  /** `-> e, ee, se`, then the payload: answers the phone and gives the open link. */
  writeAnswer(payload: Bytes): Promise<{ message: Bytes; session: Session }> {
    return this.step("second", "done", async () => {
      const state = this.state;
      const remoteEphemeral = this.remoteEphemeral;
      const remoteStatic = this.remoteStatic;
      if (state === null || remoteEphemeral === null || remoteStatic === null) throw new NoiseError(OUT_OF_ORDER);
      // As on the phone's side, nothing of the handshake is kept once it finishes.
      this.state = null;
      this.remoteEphemeral = null;
      this.remoteStatic = null;
      if (payload.length > MAX_MESSAGE_BYTES - ANSWER_OVERHEAD) throw new NoiseError("The answer's payload is too big.");
      const e = this.options.ephemeralKeyForTests ?? (await generateKeyPair("X25519", false));
      await state.mixHash(e.publicKey);
      await state.mixKey(await dh(e.privateKey, remoteEphemeral));
      await state.mixKey(await dh(e.privateKey, remoteStatic));
      const encryptedPayload = await state.encryptAndHash(payload);
      const [receiving, sending] = await state.split();
      return { message: concatBytes(e.publicKey, encryptedPayload), session: new Session(sending, receiving, state.handshakeHash) };
    });
  }
}

/**
 * An open link, after the handshake: seals what this side sends and opens
 * what the other side sent.
 *
 * Calls may overlap, but each direction works through its messages one at a
 * time, in the order of the calls, because each message's counter is the
 * next one. So the sealed messages must be sent in the order seal was called,
 * and what arrives must be opened in the order it came. After any message
 * fails to open, the session refuses everything.
 */
export class Session {
  private sending: Promise<unknown> = Promise.resolve();
  private receiving: Promise<unknown> = Promise.resolve();
  private broken = false;

  constructor(
    private readonly sendCipher: CipherState,
    private readonly receiveCipher: CipherState,
    /** The same on both sides, and different for every handshake. */
    readonly handshakeHash: Bytes,
  ) {}

  seal(plaintext: Bytes): Promise<Bytes> {
    if (plaintext.length > MAX_PLAINTEXT_BYTES) return Promise.reject(new NoiseError("A message is too big to seal."));
    const sealed = this.sending.then(() => {
      if (this.broken) throw new NoiseError("This link was closed after a message failed.");
      return this.sendCipher.encryptWithAd(EMPTY, plaintext);
    });
    this.sending = sealed.catch(() => undefined);
    return sealed;
  }

  open(ciphertext: Bytes): Promise<Bytes> {
    const opened = this.receiving.then(async () => {
      if (this.broken) throw new NoiseError("This link was closed after a message failed.");
      try {
        if (ciphertext.length < TAG_BYTES || ciphertext.length > MAX_MESSAGE_BYTES) throw new NoiseError("A message is the wrong size.");
        return await this.receiveCipher.decryptWithAd(EMPTY, ciphertext);
      } catch (error) {
        this.broken = true;
        throw error;
      }
    });
    this.receiving = opened.catch(() => undefined);
    return opened;
  }
}
