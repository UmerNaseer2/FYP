/**
 * Lets a paired phone approve or reject the deploy and rollback requests
 * waiting in the app's approval queue (the Deploy screen's approval panel),
 * on the connections shared with phones.
 *
 * A phone decides only with a passkey set up on it (src/core/webauthn.ts):
 * Face ID, a fingerprint or the phone's code, kept inside the phone itself.
 * So the link's keys alone decide nothing, and whoever copies them off the
 * phone or off this computer still cannot approve a deploy. A passkey can be
 * set up only within 5 minutes of choosing Allow approvals for that phone in
 * Settings on the computer, and only once each time it is chosen.
 *
 * The passkey is kept with the paired phone, together with the app's hash of
 * the email of whoever was signed in on the computer when it was set up
 * (never the email itself), and it decides as that person only. Once someone
 * else signs in on the computer, the phone decides nothing until approvals
 * are set up on it again.
 *
 * Each decision signs a one-time number from the computer, the request, the
 * decision and the fingerprint of the SQL the person read (approvalChallenge
 * in src/shared/remote/approval.ts). Before the app's server is asked, the
 * computer checks the signature, that the fingerprint is still the
 * request's, and, to approve, that the SQL kept with the request still
 * hashes to it. The server then checks the fingerprint and the person again
 * as it records the decision, so a signature over one SQL never decides a
 * request that would run another.
 *
 * The one-time numbers and the 5-minute windows live in memory only, so a
 * restart forgets them. Nothing here logs a challenge, a signature, the SQL
 * or who is signed in.
 *
 * Tested in src/test/phone-approvals.test.ts.
 */
import { createHash } from "node:crypto";

import type { PhonePasskey } from "../core/phone-link-file";
import { checkAssertion, readNewPasskey } from "../core/webauthn";
import { approvalChallenge, approvalFingerprint, type ApprovalScript } from "../shared/remote/approval";
import { fromBase64Url, randomBytes, toBase64Url, type Bytes } from "../shared/remote/bytes";
import { objectFields } from "../shared/remote/json";
import {
  readResult,
  type ApprovalList,
  type ApprovalRead,
  type ApprovalSummary,
  type DecideParams,
  type DecisionChallenge,
  type NewPasskeyParams,
  type PasskeyChallenge,
  type PasskeyState,
} from "../shared/remote/rpc";
import { SYSTEM_CLOCK, type Clock } from "./clock";
import { logInfo, logWarn } from "./log";
import { ask, Refused, type AppCaller, type PhoneApprovalRequests, type Refusal } from "./phone-requests";

/** How long after Allow approvals in Settings a phone may set up its passkey. */
export const ALLOW_MS = 5 * 60_000;
/** How long the one-time number for a decision may be signed for. */
export const DECISION_MS = 5 * 60_000;

/** approverKey in my-app/lib/approvals-db.ts: a SHA-256 of the signed-in email, in lowercase hex. */
const APPROVER = /^[0-9a-f]{64}$/;

export type PhoneApprovalsOptions = {
  /** Asks the app's server, as whoever is signed in on the computer. */
  call: AppCaller;
  /** The connections shared with phones in Settings. */
  sharedConnectionIds: () => readonly number[];
  /** The relay's address, which the phone app is served from and its passkeys are made for, or null before there is one. */
  relayOrigin: () => string | null;
  /** The paired phone with this key, or undefined once it is forgotten. */
  phone: (phoneKey: string) => { name: string; passkey?: PhonePasskey } | undefined;
  /** Keeps a phone's passkey, or takes it away when it is null. */
  savePasskey: (phoneKey: string, passkey: PhonePasskey | null) => void;
  /** Called when a phone's time to set up approvals starts or ends, for Settings to show. */
  onChange?: () => void;
  clock?: Clock;
};

/** The time a phone may set up its passkey in, and the challenge it was given for that, until it is used. */
type AllowWindow = { until: number; challenge: Bytes | null; timer: unknown };

/** The approval queue as the app gives it, before it is kept to the shared connections. */
type Queue = { approver: string; canApprove: boolean; approvals: ApprovalSummary[] };

export class PhoneApprovals {
  private readonly options: PhoneApprovalsOptions;
  private readonly clock: Clock;
  private readonly windows = new Map<string, AllowWindow>();
  private readonly nonces = new Map<string, { nonce: Bytes; until: number }>();

  constructor(options: PhoneApprovalsOptions) {
    this.options = options;
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  /** Lets this phone set up its passkey for the next 5 minutes. Choosing it again starts the 5 minutes over. */
  allow(phoneKey: string): void {
    const open = this.windows.get(phoneKey);
    if (open !== undefined) this.clock.clearTimeout(open.timer);
    // The same window is kept, with any challenge it gave out, so a setup the phone is in the middle of still finishes.
    const window = open ?? { until: 0, challenge: null, timer: undefined };
    window.until = this.clock.now() + ALLOW_MS;
    window.timer = this.clock.setTimeout(() => this.close(phoneKey, window), ALLOW_MS);
    this.windows.set(phoneKey, window);
    this.options.onChange?.();
  }

  /** When this phone stops being allowed to set up its passkey, in milliseconds since 1970, or null when it is not. */
  allowedUntil(phoneKey: string): number | null {
    const window = this.windows.get(phoneKey);
    return window !== undefined && this.clock.now() < window.until ? window.until : null;
  }

  /** Forgets everything kept in memory for a phone, as it is forgotten or Settings turns its approvals off. The phone link tells Settings itself. */
  forget(phoneKey: string): void {
    const window = this.windows.get(phoneKey);
    if (window !== undefined) this.clock.clearTimeout(window.timer);
    this.windows.delete(phoneKey);
    this.nonces.delete(phoneKey);
  }

  /**
   * Forgets every phone's time to set up its passkey and every one-time
   * number, for when the link is turned off, stopped or moved to another
   * relay.
   */
  forgetAll(): void {
    const open = this.windows.size > 0;
    for (const window of this.windows.values()) this.clock.clearTimeout(window.timer);
    this.windows.clear();
    this.nonces.clear();
    if (open) this.options.onChange?.();
  }

  /** The approval requests of one paired phone, for src/main/phone-requests.ts to answer with. */
  forPhone(phoneKey: string): PhoneApprovalRequests {
    return {
      list: (signal) => this.list(phoneKey, signal),
      read: (approvalId, signal) => this.read(approvalId, signal),
      beginPasskey: () => this.beginPasskey(phoneKey),
      finishPasskey: (params, signal) => this.finishPasskey(phoneKey, params, signal),
      beginDecision: () => this.beginDecision(phoneKey),
      decide: (params, signal) => this.decide(phoneKey, params, signal),
    };
  }

  /** approvals.list: the requests waiting on shared connections, and what this phone can do about them. */
  private async list(phoneKey: string, signal: AbortSignal): Promise<ApprovalList> {
    const queue = await this.queue(signal);
    const shared = this.options.sharedConnectionIds();
    return {
      approvals: queue.approvals.filter((approval) => shared.includes(approval.connectionId)),
      passkey: this.passkeyState(phoneKey, queue.approver),
      canApprove: queue.canApprove,
    };
  }

  /** approvals.read: one request's SQL, or null in its place when the computer cannot show exactly the SQL it would run. */
  private async read(approvalId: number, signal: AbortSignal): Promise<ApprovalRead> {
    const summary = this.waiting(await this.queue(signal), approvalId);
    return { id: summary.id, action: summary.action, fingerprint: summary.fingerprint, scripts: await this.scriptsOf(summary, signal) };
  }

  /** passkey.begin: the challenge for the phone's new passkey to sign, while Settings allows one. */
  private beginPasskey(phoneKey: string): PasskeyChallenge {
    const window = this.openWindow(phoneKey);
    if (window === undefined) throw new Refused("not-allowed");
    const challenge = randomBytes(32);
    window.challenge = challenge;
    return { challenge: toBase64Url(challenge), userId: userIdOf(phoneKey) };
  }

  /** passkey.finish: checks the phone's new passkey and keeps it, as the passkey of whoever is signed in on the computer. */
  private async finishPasskey(phoneKey: string, params: NewPasskeyParams, signal: AbortSignal): Promise<{ passkey: PasskeyState }> {
    const window = this.openWindow(phoneKey);
    const challenge = window?.challenge ?? null;
    if (window === undefined || challenge === null) throw new Refused("not-allowed");
    // A challenge is good for one try, so whatever was made for it cannot be offered twice.
    window.challenge = null;
    const clientDataJSON = fromBase64Url(params.clientDataJSON);
    const attestationObject = fromBase64Url(params.attestationObject);
    if (clientDataJSON === null || attestationObject === null) throw new Refused("bad-request");
    const made = readNewPasskey(clientDataJSON, attestationObject, { challenge, origin: this.origin() });
    if (!made.ok) {
      logWarn(`The phone link did not take a phone's new passkey: ${made.reason}`);
      throw new Refused("passkey-refused");
    }
    const queue = await this.queue(signal);
    if (!queue.canApprove) throw new Refused("forbidden");
    // Settings may have stopped allowing it, or the phone been forgotten, while the app was asked.
    const phone = this.options.phone(phoneKey);
    if (this.windows.get(phoneKey) !== window || phone === undefined) throw new Refused("not-allowed");
    this.options.savePasskey(phoneKey, {
      credentialId: toBase64Url(made.passkey.credentialId),
      publicKey: made.passkey.key,
      signCount: made.passkey.signCount,
      approver: queue.approver,
      addedAt: this.clock.now(),
    });
    this.close(phoneKey, window);
    logInfo(`The phone "${phone.name}" set up approvals.`);
    return { passkey: "ready" };
  }

  /** approvals.begin: the one-time number the phone's next decision signs. A newer one replaces it. */
  private beginDecision(phoneKey: string): DecisionChallenge {
    const passkey = this.options.phone(phoneKey)?.passkey;
    if (passkey === undefined) throw new Refused("no-passkey");
    const nonce = randomBytes(32);
    this.nonces.set(phoneKey, { nonce, until: this.clock.now() + DECISION_MS });
    return { nonce: toBase64Url(nonce), credentialId: passkey.credentialId };
  }

  /** approvals.decide: checks the phone's signed decision, then has the app's server record it. */
  private async decide(phoneKey: string, params: DecideParams, signal: AbortSignal): Promise<{ status: "approved" | "rejected" }> {
    // Taken out before anything else, whatever happens next, so each number decides once at most.
    const issued = this.nonces.get(phoneKey);
    this.nonces.delete(phoneKey);
    if (issued === undefined || this.clock.now() >= issued.until) throw new Refused("expired");
    const challenge = await approvalChallenge(issued.nonce, params.approvalId, params.decision, params.fingerprint);

    // Read only after the wait above, so a passkey taken away meanwhile is not used.
    const passkey = this.options.phone(phoneKey)?.passkey;
    if (passkey === undefined) throw new Refused("no-passkey");
    this.checkSignature(phoneKey, passkey, params, challenge);

    const queue = await this.queue(signal);
    const summary = this.waiting(queue, params.approvalId);
    if (queue.approver !== passkey.approver) throw new Refused("other-person");
    if (!queue.canApprove) throw new Refused("forbidden");
    if (summary.ownRequest) throw new Refused("own-request");
    if (summary.fingerprint !== params.fingerprint) throw new Refused("changed");
    // Rejecting runs nothing, so it needs no SQL. Approving needs the SQL the person read, still the request's own.
    if (params.decision === "approve" && (await this.scriptsOf(summary, signal)) === null) throw new Refused("sql-missing");
    // Approvals may have been turned off for this phone while the app was asked.
    const current = this.options.phone(phoneKey);
    if (current?.passkey?.credentialId !== passkey.credentialId) throw new Refused("no-passkey");

    let json: unknown;
    try {
      // No note: a note is the person's own words, and nobody typed any.
      json = await ask(
        this.options,
        "POST",
        `/api/deploy/approvals/${summary.id}`,
        { decision: params.decision, expectedFingerprint: params.fingerprint, expectedApprover: passkey.approver },
        signal,
        { 404: "already-decided", 409: "already-decided", 412: "changed" },
      );
    } catch (error) {
      if (error instanceof Refused && error.refusal === "forbidden") throw new Refused(await this.refusalAfterForbidden(summary.id, signal));
      throw error;
    }
    const status = objectFields(objectFields(json)?.approval)?.status;
    const wanted = params.decision === "approve" ? "approved" : "rejected";
    if (status !== wanted) {
      logWarn(`The app's answer to a phone's decision on approval request ${summary.id} was not the one the phone link expects.`);
      throw new Refused("failed");
    }
    logInfo(`The phone "${current.name}" ${wanted} approval request ${summary.id}.`);
    return { status: wanted };
  }

  /** Refuses unless the decision was signed by this phone's passkey, over this decision's challenge, and keeps its new counter. */
  private checkSignature(phoneKey: string, passkey: PhonePasskey, params: DecideParams, challenge: Bytes): void {
    const credentialId = fromBase64Url(params.assertion.credentialId);
    const authenticatorData = fromBase64Url(params.assertion.authenticatorData);
    const clientDataJSON = fromBase64Url(params.assertion.clientDataJSON);
    const signature = fromBase64Url(params.assertion.signature);
    if (credentialId === null || authenticatorData === null || clientDataJSON === null || signature === null) throw new Refused("bad-request");
    if (toBase64Url(credentialId) !== passkey.credentialId) {
      logWarn("The phone link did not take a phone's decision: it was signed by a passkey other than the one set up on the phone.");
      throw new Refused("passkey-refused");
    }
    const checked = checkAssertion({ authenticatorData, clientDataJSON, signature }, passkey.publicKey, passkey.signCount, { challenge, origin: this.origin() });
    if (!checked.ok) {
      logWarn(`The phone link did not take a phone's decision: ${checked.reason}`);
      throw new Refused("passkey-refused");
    }
    // Kept even if the decision goes no further: the passkey counted this signature, so the next one has to count past it.
    if (checked.signCount !== passkey.signCount) this.options.savePasskey(phoneKey, { ...passkey, signCount: checked.signCount });
  }

  /** The approval queue from the app's server, with the hash of who is signed in, which only this computer sees. */
  private async queue(signal: AbortSignal): Promise<Queue> {
    const fields = objectFields(await ask(this.options, "GET", "/api/deploy/approvals/phone", undefined, signal));
    const approver = fields?.approver;
    // Copied field by field into the shape a phone is sent, so a field the app adds one day stays on the computer.
    const list = readResult("approvals.list", { approvals: fields?.approvals, passkey: "none", canApprove: fields?.canApprove });
    if (typeof approver !== "string" || !APPROVER.test(approver) || list === null) {
      logWarn("The app's approval queue for phones was not in the shape the phone link reads.");
      throw new Refused("failed");
    }
    return { approver, canApprove: list.canApprove, approvals: list.approvals };
  }

  /** The request in the queue with this ID, refused when it is not waiting or not on a shared connection. */
  private waiting(queue: Queue, approvalId: number): ApprovalSummary {
    const summary = queue.approvals.find((approval) => approval.id === approvalId);
    if (summary === undefined) throw new Refused("already-decided");
    if (!this.options.sharedConnectionIds().includes(summary.connectionId)) throw new Refused("not-shared");
    return summary;
  }

  /**
   * The SQL a request runs, read again from the app, or null when a phone
   * cannot be shown exactly that SQL: no copy was kept with the request, or
   * the copy no longer hashes to the request's fingerprint.
   */
  private async scriptsOf(summary: ApprovalSummary, signal: AbortSignal): Promise<ApprovalScript[] | null> {
    if (summary.sql === "missing") return null;
    const fields = objectFields(await ask(this.options, "GET", `/api/deploy/approvals/${summary.id}/phone`, undefined, signal, { 404: "already-decided" }));
    const scripts = fields?.scripts;
    if (scripts === null) return null;
    const read = Array.isArray(scripts) ? scripts.map(readScript).filter((script): script is ApprovalScript => script !== null) : [];
    if (!Array.isArray(scripts) || read.length !== scripts.length) {
      logWarn(`The app's SQL for approval request ${summary.id} was not in the shape the phone link reads.`);
      throw new Refused("failed");
    }
    if ((await approvalFingerprint(read, summary.action)) !== summary.fingerprint) {
      logWarn(`The SQL the app gave for approval request ${summary.id} does not hash to its fingerprint, so a phone is not shown it.`);
      return null;
    }
    return read;
  }

  /** What this phone can do about requests, now that the hash of who is signed in is known. */
  private passkeyState(phoneKey: string, approver: string): PasskeyState {
    if (this.openWindow(phoneKey) !== undefined) return "allowed";
    const passkey = this.options.phone(phoneKey)?.passkey;
    if (passkey === undefined) return "none";
    return passkey.approver === approver ? "ready" : "other-person";
  }

  /**
   * Which refusal a 403 from the decision route stands for. The route also
   * answers 403 for a request decided since the queue was read, so the queue
   * is read again to tell the two apart.
   */
  private async refusalAfterForbidden(approvalId: number, signal: AbortSignal): Promise<Refusal> {
    try {
      const queue = await this.queue(signal);
      return queue.approvals.some((approval) => approval.id === approvalId) ? "forbidden" : "already-decided";
    } catch {
      return "forbidden";
    }
  }

  /** This phone's window to set up its passkey, while it is still open. */
  private openWindow(phoneKey: string): AllowWindow | undefined {
    const window = this.windows.get(phoneKey);
    return window !== undefined && this.clock.now() < window.until ? window : undefined;
  }

  private close(phoneKey: string, window: AllowWindow): void {
    if (this.windows.get(phoneKey) !== window) return;
    this.clock.clearTimeout(window.timer);
    this.windows.delete(phoneKey);
    this.options.onChange?.();
  }

  /** The page a passkey is used on: the relay's address, which the phone app comes from. */
  private origin(): string {
    const origin = this.options.relayOrigin();
    if (origin === null) {
      logWarn("The phone link has no relay address to check a passkey against.");
      throw new Refused("failed");
    }
    return origin;
  }
}

/**
 * The user ID a phone's passkey is made with. It is the same each time on
 * one paired phone, so the phone replaces its old passkey when approvals are
 * set up on it again instead of keeping both, and it is made from the
 * phone's own key, so it says nothing about the computer or the person.
 */
function userIdOf(phoneKey: string): string {
  const hash = createHash("sha256").update(`schema-studio passkey user\n${phoneKey}`, "utf8").digest();
  return toBase64Url(new Uint8Array(hash.subarray(0, 16)));
}

/** One script as the app's route gives it, in the shape a phone is shown. */
function readScript(value: unknown): ApprovalScript | null {
  const fields = objectFields(value);
  const name = fields?.scriptName;
  const version = fields?.version;
  const sql = fields?.sqlContent;
  return typeof name === "string" && typeof version === "string" && typeof sql === "string" ? { name, version, sql } : null;
}
