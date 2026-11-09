/**
 * What the phone app decides and says about starting a deploy or a rollback
 * and about cancelling a running query. Kept apart from the screens so the
 * tests (src/test/phone-deploy.test.ts) can check every rule and sentence in
 * Node.
 *
 * The computer decides everything again on every request, so these rules only
 * keep away buttons that would be refused, and work out what to sign.
 */
import { versionText } from "./approvals.js";
import { countText, hasHiddenCharacters } from "./format.js";
import { agoText } from "./live.js";
import type { ApprovalAction } from "../shared/remote/approval.js";
import { ticksFor, type ControlTick, type DeployStep, type RunRisks } from "../shared/remote/control.js";
import type {
  CancelResult,
  DeployBlockedReason,
  DeployFamilyStatus,
  DeployNext,
  DeployPlan,
  DeployRegistry,
  DeployRun,
  DeployStartStatus,
  LiveControl,
  LiveSession,
  PasskeyState,
  RollbackChoice,
} from "../shared/remote/rpc.js";

/**
 * Whether this session's query could be cancelled from here. A session idle in
 * a transaction has no query running, and cancelling asks for when the query
 * began, because a session's number can be used again.
 */
export function mayCancel(session: LiveSession, control: LiveControl | null): boolean {
  return control?.canCancel === true && session.queryStart !== null && session.kind !== "idle-in-transaction";
}

/** What Cancel query asks before the passkey, saying what a cancel does to the work the query had done. */
export const CANCEL_QUESTION = "Cancel this query? The database stops it and undoes what it had changed so far.";

export function cancelResultText(status: CancelResult["status"]): string {
  return status === "cancelled"
    ? "The database was told to cancel the query. It stops at its next chance, and it leaves this list when it has."
    : "That query had already finished.";
}

/** Whether a person could do something here, once a passkey is on this device. */
export function mayControl(control: LiveControl | null): boolean {
  return control !== null && control.allowed && (control.canDeploy || control.canCancel);
}

/** One box to tick, with what it is about. */
export type RiskRow = { tick: ControlTick; text: string; labels: readonly string[] };

/** The risks of a run, one for each tick it needs, in the order of the ticks. */
export function riskRows(risks: RunRisks): RiskRow[] {
  return ticksFor(risks).map((tick) => {
    switch (tick) {
      case "production":
        return { tick, text: "This runs on production.", labels: [] };
      case "breaking":
        return { tick, text: "These scripts could break something:", labels: risks.breaking };
      case "data-loss":
        return { tick, text: "These scripts could lose data:", labels: risks.dataLoss };
      case "other-scripts":
        return { tick, text: "Other scripts ran after what this undoes:", labels: risks.otherScripts };
      case "drift":
        return {
          tick,
          text: risks.drift === "unreachable"
            ? "The last drift check could not reach this database."
            : "The last drift check found this schema changed outside Schema Studio.",
          labels: [],
        };
    }
  });
}

export const BLOCKED_TEXT: Record<DeployBlockedReason, string> = {
  "nothing-to-do": "There is nothing to run: this version is no longer waiting.",
  "transaction-control": "A script in this run starts or ends its own transaction, so it cannot run here.",
  application: "A script in this run is not meant for this database's application.",
  "no-rollback": "A version in this run has no rollback script, so it cannot be undone from here.",
  "read-only": "This connection is read-only, so nothing can run on it.",
  role: "The role signed in on the computer may not do this.",
};

/** What a signature would be for, or null when there is nothing to sign. */
export function stepOf(next: DeployNext): DeployStep | null {
  if (next === "run" || next === "run-approved") return "run";
  return next === "ask-approval" ? "ask" : null;
}

/**
 * The risks a signature accepts. Asking changes nothing but a row in the queue,
 * so it accepts none: whoever approves it reads them, and whoever runs it after
 * that ticks them.
 */
export function signedTicks(plan: Pick<DeployPlan, "next" | "risks">): ControlTick[] {
  return stepOf(plan.next) === "run" ? ticksFor(plan.risks) : [];
}

/** Whether every box the signature accepts has been ticked. */
export function allTicked(plan: Pick<DeployPlan, "next" | "risks">, ticked: ReadonlySet<ControlTick>): boolean {
  return signedTicks(plan).every((tick) => ticked.has(tick));
}

/** The words on the passkey button, or null when this run has no next step here. */
export function stepButton(next: DeployNext, action: ApprovalAction): string | null {
  if (next === "run" || next === "run-approved") return action === "revert" ? "Roll back with passkey" : "Deploy with passkey";
  return next === "ask-approval" ? "Ask for approval with passkey" : null;
}

/** What the next step will do, or why there is none. */
export function stepText(plan: Pick<DeployPlan, "next" | "blockedReason">): string {
  switch (plan.next) {
    case "run":
      return "Signing with the passkey starts it on the computer straight away.";
    case "run-approved":
      return "This exact run has been approved. Signing with the passkey starts it.";
    case "ask-approval":
      return "This is production, so someone else has to approve it. Signing with the passkey sends them the request, and nothing changes yet.";
    case "waiting":
      return "A request for exactly this run is waiting for someone to decide it.";
    case "blocked":
      return plan.blockedReason === null ? "This cannot run from here." : BLOCKED_TEXT[plan.blockedReason];
  }
}

/** How a start ended, as far as the computer could say while the phone waited. */
export function startStatusText(status: DeployStartStatus, action: ApprovalAction): string {
  switch (status) {
    case "done":
      return action === "revert" ? "Rolled back." : "Deployed.";
    case "sent-for-approval":
      return "Sent for approval. Someone else has to approve it before it can run.";
    case "running":
      return "Still running on the computer. Come back to this script to see how it ended.";
    case "not-applied":
      return "It did not run, so nothing changed.";
    case "unknown":
      return "The computer could not tell how it ended. Check the database before trying again.";
  }
}

/** What a start's sentence is shown as. */
export function startStatusTone(status: DeployStartStatus): "info" | "bad" {
  return status === "not-applied" || status === "unknown" ? "bad" : "info";
}

/** The last run from a paired device on this script, as the family's screen shows it. */
export function runText(run: DeployRun, now: number): string {
  const when = agoText(run.at, now);
  switch (run.state) {
    case "running":
      return `A run started from a paired device ${when} is still going.`;
    case "done":
      return `The last run from a paired device finished ${when}.`;
    case "not-applied":
      return `The last run from a paired device, ${when}, did not run, so nothing changed.`;
    case "unknown":
      return `The computer could not tell how the last run from a paired device ended, ${when}. Check the database before trying again.`;
  }
}

/** Why the list of scripts is empty, or may be missing some. */
export function registryText(registry: DeployRegistry): string | null {
  switch (registry) {
    case "ok":
      return null;
    case "unconfigured":
      return "The script registry is not set up in Schema Studio on the computer.";
    case "unreachable":
      return "The computer could not read the script registry just now.";
  }
}

export const PARTIAL_TEXT = "Some scripts could not be read, so this list may be missing some.";

/** Says where a passkey comes from, for the two states where this device cannot use one yet. */
export function passkeyText(state: PasskeyState): string | null {
  switch (state) {
    case "none":
      return "To start a run or cancel a query from this device, choose Set up passkey for it in Schema Studio's Settings on the computer, under Paired phones. Then set it up here within 5 minutes.";
    case "other-person":
      return "The person signed in on the computer is not the one who set up the passkey on this device. To act as whoever is signed in now, choose Remove passkey and then Set up passkey for this device under Paired phones in Schema Studio's Settings on the computer.";
    default:
      return null;
  }
}

/** What an older computer's refusal means, for a method it has never heard of. */
export const UPDATE_TEXT = "Update Schema Studio on the computer to do this from here.";

/** The link dropped after the request went, so nobody here knows whether the computer got it. */
export const RUN_LOST_TEXT = "The link to the computer dropped before it answered, so this may have started. Look at this script again before trying again.";

export const CANCEL_LOST_TEXT = "The link to the computer dropped before it answered, so the query may have been cancelled. Look at this list before trying again.";

/** The phone worked out the fingerprint of the SQL itself, and the computer's differs, so what would be signed is not what shows. */
export const MISMATCH_TEXT = "The SQL the computer sent does not match its own fingerprint, so this cannot be signed here. Check it on the computer.";

/**
 * Whether a run's SQL holds characters that do not show on screen. The
 * fingerprint covers them, so signing would accept SQL that runs something
 * other than what the person read, and no passkey button is offered for it.
 */
export function hidesCharacters(plan: Pick<DeployPlan, "scripts">): boolean {
  return plan.scripts.some((script) => hasHiddenCharacters(script.sql));
}

export const HIDDEN_TEXT =
  "This SQL contains characters that do not show on screen, marked above as \u{240D} or as a code in \u{27E6} \u{27E7}. They can make it run something other than what it seems to, so this cannot be signed here. Check it on the computer.";

export const NO_FAMILIES_TEXT = "The script registry has no scripts for this connection's database.";

/** Where a family stands, as in "On v1.2.0, 3 waiting". */
export function whereText(status: Pick<DeployFamilyStatus, "currentVersion" | "waiting">): string {
  const waiting = status.waiting.length === 0 ? "nothing waiting" : `${status.waiting.length} waiting`;
  return status.currentVersion === null ? `Not applied yet, ${waiting}` : `On ${versionText(status.currentVersion)}, ${waiting}`;
}

export function deployButtonText(version: string): string {
  return `Deploy up to ${versionText(version)}`;
}

export function rollbackButtonText(choice: RollbackChoice): string {
  const where = choice.target === null ? "before the first version" : versionText(choice.target);
  return `Roll back to ${where} (undoes ${countText(choice.undoCount, "version", "versions")})`;
}

/** A plan's title, as in "Deploy up to v3". */
export function planTitle(action: ApprovalAction, version: string | null): string {
  if (action === "deploy") return version === null ? "Deploy" : deployButtonText(version);
  return version === null ? "Roll back to before the first version" : `Roll back to ${versionText(version)}`;
}
