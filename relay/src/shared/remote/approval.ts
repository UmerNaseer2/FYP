/**
 * The two hashes a phone's decision on a deploy or rollback request rests on.
 *
 * A request's fingerprint is a SHA-256 of the SQL it would run, written out
 * the one way my-app/lib/approval-fingerprint.ts writes it (runFingerprint),
 * so the computer and the phone can each work it out from the SQL they were
 * shown and check that it is the request's own. Each script's name, version
 * and SQL is written with its length in front, so no text inside one can
 * pass for the start of the next. A length counts what JavaScript's .length
 * counts, UTF-16 code units, which is what the app's server counts too.
 *
 * The challenge is what the phone's passkey signs to approve or reject one
 * request. It covers the computer's one-time number for that decision, the
 * request, the decision itself and the fingerprint of the SQL the person
 * read, so a signature for one decision is no use for any other, or twice.
 *
 * Tested in src/test/remote-approval.test.ts.
 */
import { toBase64Url, utf8, type Bytes } from "./bytes.js";

/** What a request runs once it is approved: its migrations, or their rollbacks. */
export type ApprovalAction = "deploy" | "revert";
/** What the person holding the phone decided. */
export type ApprovalDecision = "approve" | "reject";
/** One script a request runs, as a phone is shown it. */
export type ApprovalScript = { name: string; version: string; sql: string };

/** The text a fingerprint is the SHA-256 of: runFingerprint's in my-app/lib/approval-fingerprint.ts, character for character. */
export function approvalRunText(scripts: readonly ApprovalScript[], action: ApprovalAction): string {
  const noun = action === "revert" ? "rollbacks" : "migrations";
  return [`${scripts.length} ${noun}`, ...scripts.map((script) => field(script.name) + field(script.version) + field(script.sql))].join("\n");
}

/** A run's fingerprint, written as the app writes one: 64 lowercase hex characters. */
export async function approvalFingerprint(scripts: readonly ApprovalScript[], action: ApprovalAction): Promise<string> {
  return toHex(await sha256(utf8(approvalRunText(scripts, action))));
}

/**
 * What the phone's passkey signs to decide one request. The phone passes it
 * to the browser as the challenge, and the browser writes it, in base64url,
 * into the clientDataJSON the passkey signs.
 */
export async function approvalChallenge(nonce: Bytes, approvalId: number, decision: ApprovalDecision, fingerprint: string): Promise<Bytes> {
  return sha256(utf8(["schema-studio approval v1", toBase64Url(nonce), String(approvalId), decision, fingerprint].join("\n")));
}

/** Whether a value is a fingerprint as the app writes one: 64 lowercase hex characters. */
export function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function field(value: string): string {
  return `${value.length}:${value}`;
}

async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function toHex(bytes: Bytes): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
