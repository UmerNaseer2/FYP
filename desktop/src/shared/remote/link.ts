/**
 * Messages of any size over an open link.
 *
 * One Noise message can carry at most 64 KiB, but an answer from the computer,
 * such as a whole database schema, can be several megabytes. So a message is
 * cut into pieces, each piece is sealed and sent on its own, and the other
 * side opens the pieces and joins them back together.
 *
 * Each piece starts with one byte: 1 when more pieces follow, 0 for the last.
 * Every piece but the last is full, so a message can be cut only one way. The
 * pieces need no numbers: the session's counters (noise.ts) already make a
 * piece that was lost, repeated or moved fail to open.
 */
import { concatBytes, type Bytes } from "./bytes.js";
import type { Session } from "./noise.js";

/**
 * The size of a full piece, its first byte included: a round size well under
 * what one Noise message can carry (src/test/remote-link.test.ts checks it).
 */
export const PIECE_BYTES = 32 * 1024;

/** The biggest message a link takes, so a phone is never sent more than it can hold. */
export const MAX_LINK_MESSAGE_BYTES = 8 * 1024 * 1024;

const MORE = 1;
const LAST = 0;

const CLOSED = "This link was closed after a message failed.";

/** A message could not be sent, or did not arrive whole. */
export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

/** Cuts a message into pieces, in the order they must be sent. */
export function cutIntoPieces(message: Bytes): Bytes[] {
  if (message.length > MAX_LINK_MESSAGE_BYTES) throw new LinkError("A message is too big to send.");
  const room = PIECE_BYTES - 1;
  const pieces: Bytes[] = [];
  let offset = 0;
  // Even an empty message is one piece, so the loop runs at least once.
  do {
    const end = Math.min(offset + room, message.length);
    const piece = new Uint8Array(1 + end - offset);
    piece[0] = end < message.length ? MORE : LAST;
    piece.set(message.subarray(offset, end), 1);
    pieces.push(piece);
    offset = end;
  } while (offset < message.length);
  return pieces;
}

/** Joins pieces back into messages, and refuses any piece cutIntoPieces would never make. */
export class PieceJoiner {
  private parts: Bytes[] = [];
  private length = 0;

  /** Takes the next piece. Gives the whole message once its last piece is in, and null until then. */
  add(piece: Bytes): Bytes | null {
    if (piece.length === 0 || piece.length > PIECE_BYTES) throw new LinkError("A piece of a message is the wrong size.");
    const flag = piece[0];
    if (flag !== MORE && flag !== LAST) throw new LinkError("A piece of a message does not say whether more follow.");
    if (flag === MORE && piece.length !== PIECE_BYTES) throw new LinkError("A piece of a message is the wrong size.");
    if (flag === LAST && piece.length === 1 && this.parts.length > 0) throw new LinkError("A message ended with an empty piece.");
    this.length += piece.length - 1;
    if (this.length > MAX_LINK_MESSAGE_BYTES) throw new LinkError("A message is too big.");
    this.parts.push(piece.subarray(1));
    if (flag === MORE) return null;
    const message = concatBytes(...this.parts);
    this.parts = [];
    this.length = 0;
    return message;
  }
}

/**
 * Whole messages over a session: send cuts and seals them, receive opens and
 * joins them. After anything fails, the link refuses everything, and the
 * connection it runs over should be closed.
 */
export class Link {
  private readonly joiner = new PieceJoiner();
  private broken = false;

  /** `transmit` sends one sealed piece over the connection, as it is. */
  constructor(
    private readonly session: Session,
    private readonly transmit: (sealed: Bytes) => void,
  ) {}

  /**
   * Sends a message. Calls may overlap: every piece is handed to the session
   * before send returns, so the messages go out whole, one after another, in
   * the order send was called.
   */
  async send(message: Bytes): Promise<void> {
    if (this.broken) throw new LinkError(CLOSED);
    // A message too big to send is refused before anything goes out, so the
    // link can still be used, for example to say that it was too big.
    const pieces = cutIntoPieces(message);
    try {
      await Promise.all(pieces.map((piece) => this.session.seal(piece).then((sealed) => this.transmit(sealed))));
    } catch (error) {
      this.broken = true;
      throw error;
    }
  }

  /**
   * Takes the next sealed piece, as it arrived. Gives the whole message once
   * its last piece is in, and null until then. Calls may overlap; the pieces
   * are opened in the order receive was called.
   */
  async receive(sealed: Bytes): Promise<Bytes | null> {
    if (this.broken) throw new LinkError(CLOSED);
    try {
      const piece = await this.session.open(sealed);
      if (this.broken) throw new LinkError(CLOSED);
      return this.joiner.add(piece);
    } catch (error) {
      this.broken = true;
      throw error;
    }
  }
}
