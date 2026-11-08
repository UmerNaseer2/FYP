/**
 * The rules for a computer linked to someone's account, and the shapes both ends
 * of the site agree on.
 *
 * A database on someone's laptop cannot be reached from this site, and its
 * password never comes here. So the laptop's desktop app signs in with a token
 * and asks this site, every few seconds, whether there is a question for it. It
 * answers from its own copy of the app and sends back what the phone needs.
 *
 * No database in here, and nothing a browser could not run, so the link page and
 * the phone app can use it.
 */
import type { Environment } from "./environments";

/** Marks a computer's token, so one pasted in the wrong place can be recognized. */
export const TOKEN_PREFIX = "ssa_";

export const LINK_MINUTES = 10;

/** How often a waiting computer asks whether it has been approved. */
export const LINK_POLL_SECONDS = 3;

/** A computer asks every 15 seconds when idle, so this forgives a couple of lost calls. */
export const ONLINE_WITHIN_SECONDS = 90;

/** A question nobody picked up by then is given up on, and never runs later. */
export const QUEUED_FOR_SECONDS = 120;

/** A question a computer picked up and never answered is given up on after this. */
export const RUNNING_FOR_SECONDS = 180;

/** The most connections one computer may share. More than any person could pick from. */
export const MOST_CONNECTIONS = 100;

/**
 * The largest answer a computer may send. Well inside the 4.5 MB a Vercel function
 * accepts, and one target's summary fits (MAX_PHONE_LINES in lib/phone-compare.ts).
 */
export const MAX_ANSWER_BYTES = 1024 * 1024;

export type ComputerConnection = {
  /** The computer's own number for it. It means nothing anywhere else. */
  id: number;
  name: string;
  environment: Environment;
  /**
   * Picked for the phone. Only a shared one can be asked about from elsewhere;
   * the rest are listed on the website's Connections page for their owner.
   * An older desktop sent only shared ones and no flag, so missing means true.
   */
  shared?: boolean;
};

/** What GET /api/computers says about each of a person's computers. */
export type Computer = {
  id: number;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  connections: ComputerConnection[];
};

/** What GET /api/computers/jobs/[id] answers. */
export type JobAnswer =
  | { status: "waiting" }
  | { status: "done"; result: unknown }
  | { status: "failed"; error: string };

/** Left out: vowels, so a code can never spell a word, and 0 and 1, which read like O and I. */
export const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ23456789";
export const CODE_LENGTH = 8;

/**
 * A code as a person typed it, in the form the database holds, or null if it
 * could not be one. Forgiving about case, spaces and the hyphen, because this may
 * have been read off one screen and typed into another.
 */
export function readUserCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  return Array.from(code).every((letter) => CODE_LETTERS.includes(letter)) ? code : null;
}

/** A code as it is shown: "BCDF-GHJK". */
export function showUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Text a computer sent that a person will read: invisible characters out, one
 * line, and no longer than max characters. The computer sent it, so it cannot be
 * taken to be tidy.
 */
export function cleanLabel(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const tidy = value
    .replace(/\p{Cf}+/gu, "")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  const characters = Array.from(tidy);
  return characters.length <= max ? tidy : characters.slice(0, max).join("").trimEnd();
}

/**
 * What the person is told when a computer could not answer. The computer sends
 * one of these words and never a sentence of its own, so nothing a database
 * server said can reach this site, whatever a computer does.
 */
const AGENT_REFUSALS: Readonly<Record<string, string>> = {
  "signed-out": "Nobody is signed in to Schema Studio on that computer. Sign in there and try again.",
  forbidden: "The role signed in on that computer may not do this.",
  "not-member": "The person signed in on that computer no longer has access there.",
  "not-shared": "That connection is not shared any more. Share it in Schema Studio's Settings on the computer.",
  "not-found": "That is not on the computer any more.",
  unreachable: "The computer could not reach that database.",
  "too-big": "That answer is too big to send here. Open Compare on the computer.",
  "too-slow": "The computer took too long to answer.",
  "no-answer": "Schema Studio on the computer did not answer. Try again in a moment.",
};

const SOMETHING_WENT_WRONG = "The computer could not do that. Its log has the details.";

export const TIMED_OUT = "The computer did not answer in time. It may be asleep or off.";

/** The sentence for a word a computer sent. An unknown word gets the plain one. */
export function refusalSentence(refusal: string | null): string {
  return (refusal !== null && Object.hasOwn(AGENT_REFUSALS, refusal) && AGENT_REFUSALS[refusal]) || SOMETHING_WENT_WRONG;
}

/** A word safe to keep, so a computer cannot fill this column with its own text. */
export function keptRefusal(value: unknown): string {
  return typeof value === "string" && Object.hasOwn(AGENT_REFUSALS, value) ? value : "failed";
}
