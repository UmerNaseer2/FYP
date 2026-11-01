/**
 * What a passkey signs when a paired phone changes something on the computer's
 * databases: starting a deploy or a rollback, or cancelling a running query.
 *
 * The phone works the signed text out from what it showed, and the computer
 * works it out again from the request. The computer then checks it against what
 * the app says now, so a signature is good for this one action only.
 *
 * These have their own label, so a signature made for an approval
 * (approval.ts) can never serve as one of these, or the other way round. The
 * word after the one-time number keeps a run's signature from serving as a
 * cancel's. The fields go through JSON rather than being joined with line
 * breaks, as a schema or script name may hold any character.
 *
 * Only the language and Web Crypto here, as this is copied to the relay.
 * Tested in src/test/remote-control.test.ts.
 */
import { sha256, type ApprovalAction } from "./approval.js";
import { toBase64Url, utf8, type Bytes } from "./bytes.js";

/** A risk the person holding the phone said they accept, by ticking its box. */
export type ControlTick = "production" | "breaking" | "data-loss" | "other-scripts" | "drift";
export const CONTROL_TICKS: readonly ControlTick[] = ["production", "breaking", "data-loss", "other-scripts", "drift"];

/** What a run could do that somebody should accept first. */
export type RunRisks = {
  production: boolean;
  /** Labels such as "users_migration v2.0.0", of the scripts that could break something. */
  breaking: string[];
  /** Likewise, of the scripts that could lose data. */
  dataLoss: string[];
  /** A rollback only: other scripts that ran after what it would undo. */
  otherScripts: string[];
  /** A deploy only: what the last drift check said, when it should give someone pause. */
  drift: "drifted" | "unreachable" | null;
};

/** The ticks a run needs, in one fixed order, so the phone and the computer work out the same list. */
export function ticksFor(risks: RunRisks): ControlTick[] {
  const ticks: ControlTick[] = [];
  if (risks.production) ticks.push("production");
  if (risks.breaking.length > 0) ticks.push("breaking");
  if (risks.dataLoss.length > 0) ticks.push("data-loss");
  if (risks.otherScripts.length > 0) ticks.push("other-scripts");
  if (risks.drift !== null) ticks.push("drift");
  return ticks;
}

/** What the signature is for: running it, or asking someone to approve it. */
export type DeployStep = "run" | "ask";

export type DeployTarget = {
  connectionId: number;
  schemaName: string;
  scriptName: string;
  action: ApprovalAction;
  /** The version it goes to. For a rollback, null is before the first version. */
  targetVersion: string | null;
  /** The fingerprint (approval.ts) of the SQL the person read. */
  fingerprint: string;
  step: DeployStep;
  ticks: readonly ControlTick[];
};

export type CancelTarget = {
  connectionId: number;
  pid: number;
  /** When the query began. A session's number can be used again, but not with the same start. */
  queryStart: string;
};

/** What the passkey signs to take the next step of one deploy or rollback. */
export function deployChallenge(nonce: Bytes, target: DeployTarget): Promise<Bytes> {
  const { action, connectionId, schemaName, scriptName, targetVersion, fingerprint, step, ticks } = target;
  return challenge(nonce, ["run", action, connectionId, schemaName, scriptName, targetVersion, fingerprint, step, ticks]);
}

/** What the passkey signs to cancel one running query. */
export function cancelChallenge(nonce: Bytes, { connectionId, pid, queryStart }: CancelTarget): Promise<Bytes> {
  return challenge(nonce, ["cancel", connectionId, pid, queryStart]);
}

function challenge(nonce: Bytes, fields: readonly unknown[]): Promise<Bytes> {
  return sha256(utf8(JSON.stringify(["schema-studio control v1", toBase64Url(nonce), ...fields])));
}
