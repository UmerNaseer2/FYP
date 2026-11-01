/**
 * Lets a paired phone with Allow control on start a deploy or a rollback, or
 * cancel a running query, on the connections shared with phones.
 *
 * Each of those is signed on the phone with its passkey (kept and checked in
 * src/main/phone-approvals.ts), over exactly what the person saw
 * (src/shared/remote/control.ts), and acts as the person who set that passkey
 * up. So the link's keys alone start nothing.
 *
 * A phone never supplies SQL. It names a script family and a version, and the
 * app's /api/deploy/phone works out the run from the registry and the ledger.
 * What to POST to take the next step stays on this computer. The plan is read
 * again right before that step, and anything other than what was signed is
 * refused, with nothing run. The routes that run it then check it all again.
 *
 * A run keeps going whatever happens to the phone. The apply and revert routes
 * do not read their request's signal, so stopping the wait would not stop the
 * run, only the knowing how it ended. So a run has a signal of its own, a phone
 * is told to check back if it takes a while, and how it ended goes in the action
 * log and in what deploy.family answers. If the app quits during a run, the log
 * stays at "started" while the server's run carries on.
 *
 * Nothing here logs a signature, the SQL or who is signed in, and the server's
 * words never reach a phone.
 *
 * Tested in src/test/phone-control.test.ts.
 */
import type { PhoneActionOutcome } from "../core/phone-link-file";
import type { ApprovalAction } from "../shared/remote/approval";
import { cancelChallenge, deployChallenge, ticksFor, type ControlTick } from "../shared/remote/control";
import { objectFields } from "../shared/remote/json";
import {
  isSchemaName,
  isScriptText,
  readResult,
  type CancelParams,
  type CancelResult,
  type DeployFamilyParams,
  type DeployFamilyStatus,
  type DeployList,
  type DeployPlan,
  type DeployPlanParams,
  type DeployRun,
  type DeployStartParams,
  type DeployStartResult,
} from "../shared/remote/rpc";
import { SYSTEM_CLOCK, type Clock } from "./clock";
import { logWarn } from "./log";
import { readScript, type PhoneApprovals } from "./phone-approvals";
import { ACTION_OUTCOMES, ask, checkShared, Refused, type AppAnswer, type AppCaller, type PhoneControl, type PhoneControlRequests, type Refusal } from "./phone-requests";

/**
 * How long a phone waits to hear how a run ended before it is told to check
 * back, counted from when its request began. Well inside the time the computer
 * has to answer at all (ANSWER_TIMEOUT_MS in src/main/phone-host.ts), so a slow
 * read before the run cannot turn this into "took too long".
 */
export const START_WAIT_MS = 60_000;
/** How long the computer listens for how a run ended. */
const RUN_LIMIT_MS = 30 * 60_000;

const PLAN_REFUSALS = { 424: "no-registry" } as const;

export type PhoneControlActionsOptions = {
  /** Asks the app's server, as whoever is signed in on the computer. */
  call: AppCaller;
  /** The connections shared with phones in Settings. */
  sharedConnectionIds: () => readonly number[];
  /** Keeps the passkeys and checks their signatures. */
  approvals: Pick<PhoneApprovals, "beginControl" | "checkControl" | "controlPasskey" | "whoAmI">;
  clock?: Clock;
};

/** A plan as the app's route gives it: what a phone is shown, and what only this computer uses. */
type ReadPlan = {
  plan: DeployPlan;
  run: { path: string; body: Record<string, unknown> } | null;
  approvalRequest: Record<string, unknown> | null;
};

type Recorder = (outcome: PhoneActionOutcome) => void;

export class PhoneControlActions {
  private readonly options: PhoneControlActionsOptions;
  private readonly clock: Clock;
  /** How each family's latest run from a phone went. One map for the computer, so two phones cannot both start one family. */
  private readonly runs = new Map<string, DeployRun>();

  constructor(options: PhoneControlActionsOptions) {
    this.options = options;
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  /** The requests of one paired phone, for src/main/phone-requests.ts to answer with. */
  forPhone(phoneKey: string, control: PhoneControl): PhoneControlRequests {
    return {
      deployList: (connectionId, signal) => this.deployList(phoneKey, control, connectionId, signal),
      deployFamily: (params, signal) => this.deployFamily(control, params, signal),
      deployPlan: (params, signal) => this.deployPlan(phoneKey, control, params, signal),
      begin: () => {
        if (!control.allowed()) throw new Refused("control-off");
        return this.options.approvals.beginControl(phoneKey);
      },
      deployStart: (params, signal) => this.deployStart(phoneKey, control, params, signal),
      cancelSession: (params, signal) => this.cancelSession(phoneKey, control, params, signal),
      passkey: (signal) => this.options.approvals.controlPasskey(phoneKey, signal),
    };
  }

  /** deploy.list: the script families a connection could run. A family a request could not name is left out. */
  private async deployList(phoneKey: string, control: PhoneControl, connectionId: number, signal: AbortSignal): Promise<DeployList> {
    this.checkAllowed(control, connectionId);
    const fields = objectFields(await ask(this.options, "GET", `/api/deploy/phone?connectionId=${connectionId}`, undefined, signal));
    const families = Array.isArray(fields?.families) ? fields.families.filter(canBeNamed) : fields?.families;
    const list = readResult("deploy.list", {
      registry: fields?.registry,
      partial: fields?.partial,
      families,
      passkey: await this.options.approvals.controlPasskey(phoneKey, signal),
    });
    if (list === null) throw unreadable("list of script families");
    return list;
  }

  /** deploy.family: where one family stands, and how the latest run from a phone went. */
  private async deployFamily(control: PhoneControl, params: DeployFamilyParams, signal: AbortSignal): Promise<DeployFamilyStatus> {
    this.checkAllowed(control, params.connectionId);
    const { connectionId, schemaName, scriptName } = params;
    const fields = objectFields(await ask(this.options, "POST", "/api/deploy/phone", { connectionId, schemaName, scriptName }, signal, PLAN_REFUSALS));
    const status = readResult("deploy.family", {
      currentVersion: fields?.currentVersion,
      waiting: fields?.waiting,
      undo: fields?.undo,
      partial: fields?.partial,
      run: this.runs.get(runKey(params)) ?? null,
    });
    if (status === null) throw unreadable("script family");
    return status;
  }

  /** deploy.plan: what one run would do, for the person to read and sign. */
  private async deployPlan(phoneKey: string, control: PhoneControl, params: DeployPlanParams, signal: AbortSignal): Promise<DeployPlan> {
    this.checkAllowed(control, params.connectionId);
    const { plan } = await this.readPlan(params, signal);
    return { ...plan, passkey: await this.options.approvals.controlPasskey(phoneKey, signal) };
  }

  /** deploy.start: checks the signature and that nothing has changed, then takes the step it was signed for. */
  private async deployStart(phoneKey: string, control: PhoneControl, params: DeployStartParams, signal: AbortSignal): Promise<DeployStartResult> {
    const deadline = this.clock.now() + START_WAIT_MS;
    const { connectionId, schemaName, scriptName, action, targetVersion, fingerprint, step, ticks, assertion } = params;
    const record: Recorder = (outcome) =>
      control.record({ action: action === "deploy" ? "deploy" : "rollback", connectionId, schema: schemaName, outcome, detail: describeRun(scriptName, action, targetVersion) });
    let run: { path: string; body: Record<string, unknown> };
    try {
      const approver = await this.options.approvals.checkControl(phoneKey, assertion, (nonce) =>
        deployChallenge(nonce, { connectionId, schemaName, scriptName, action, targetVersion, fingerprint, step, ticks }),
      );
      this.checkAllowed(control, connectionId);
      await this.checkSamePerson(approver, signal);
      const read = await this.readPlan(params, signal);
      if (read.plan.fingerprint !== fingerprint) throw new Refused("control-changed");
      if (step === "ask") {
        // A request changes nothing but a row in the queue, so it takes no ticks.
        if (read.plan.next !== "ask-approval" || read.approvalRequest === null) throw new Refused("control-changed");
        await ask(this.options, "POST", "/api/deploy/approvals", read.approvalRequest, signal);
        record("sent-for-approval");
        return { status: "sent-for-approval" };
      }
      if ((read.plan.next !== "run" && read.plan.next !== "run-approved") || read.run === null) throw new Refused("control-changed");
      // A risk that has appeared since nobody accepted. A signed tick for one that has gone sets a field that does nothing.
      if (ticksFor(read.plan.risks).some((tick) => !ticks.includes(tick))) throw new Refused("control-changed");
      // In the same tick as the check, so two phones cannot both start one family. A run started in the app's window is not here: the apply route's own lock handles that.
      const key = runKey(params);
      if (this.runs.get(key)?.state === "running") throw new Refused("already-running");
      this.runs.set(key, { state: "running", at: this.clock.now() });
      run = read.run;
    } catch (error) {
      record(outcomeOf(error));
      throw error;
    }
    record("started");
    const ended = this.finishRun(run.path, { ...run.body, ...acknowledgements(action, ticks) }, runKey(params), record);
    return this.answerInTime(ended, deadline, signal);
  }

  /** Runs it on a signal of its own, and writes how it ended whatever has happened to the phone by then. */
  private async finishRun(path: string, body: Record<string, unknown>, key: string, record: Recorder): Promise<DeployStartResult> {
    let answer: AppAnswer | null = null;
    try {
      answer = await this.options.call("POST", path, body, AbortSignal.timeout(RUN_LIMIT_MS));
    } catch (error) {
      logWarn("The phone link could not tell how a phone's run ended.", error);
    }
    const end = readRunEnd(answer);
    this.runs.set(key, { state: end.state, at: this.clock.now() });
    record(end.outcome);
    if (end.refusal !== null) throw new Refused(end.refusal);
    return { status: end.state };
  }

  /** How the run ended, if it does by the deadline and the phone is still there. Otherwise that it is still running. */
  private async answerInTime(ended: Promise<DeployStartResult>, deadline: number, signal: AbortSignal): Promise<DeployStartResult> {
    let timer: unknown;
    let stopListening = (): void => {};
    const waited = new Promise<DeployStartResult>((resolve) => {
      const stillRunning = (): void => resolve({ status: "running" });
      timer = this.clock.setTimeout(stillRunning, Math.max(0, deadline - this.clock.now()));
      signal.addEventListener("abort", stillRunning, { once: true });
      stopListening = () => signal.removeEventListener("abort", stillRunning);
    });
    // Whoever is no longer waiting for it must not leave a refusal unhandled.
    ended.catch(() => {});
    try {
      return await Promise.race([ended, waited]);
    } finally {
      this.clock.clearTimeout(timer);
      stopListening();
    }
  }

  /** session.cancel: checks the signature, then has the app cancel exactly that query. */
  private async cancelSession(phoneKey: string, control: PhoneControl, params: CancelParams, signal: AbortSignal): Promise<CancelResult> {
    const { connectionId, pid, queryStart, assertion } = params;
    const record: Recorder = (outcome) => control.record({ action: "cancel-query", connectionId, schema: null, outcome, detail: `session ${pid}` });
    try {
      const approver = await this.options.approvals.checkControl(phoneKey, assertion, (nonce) => cancelChallenge(nonce, { connectionId, pid, queryStart }));
      this.checkAllowed(control, connectionId);
      await this.checkSamePerson(approver, signal);
      const answer = await ask(this.options, "POST", "/api/performance/cancel", { connectionId, pid, queryStart }, signal, { 409: "database-refused", 423: "read-only" });
      const result = readResult("session.cancel", answer);
      if (result === null) throw unreadable("answer to a cancel");
      record(result.status === "cancelled" ? "done" : "gone");
      return result;
    } catch (error) {
      record(outcomeOf(error));
      throw error;
    }
  }

  /** Allow control first, so that a phone without it learns nothing, then whether the connection is shared. */
  private checkAllowed(control: PhoneControl, connectionId: number): void {
    if (!control.allowed()) throw new Refused("control-off");
    checkShared([connectionId], this.options);
  }

  /** A passkey acts only as the person who set it up. */
  private async checkSamePerson(approver: string, signal: AbortSignal): Promise<void> {
    if ((await this.options.approvals.whoAmI(signal)).approver !== approver) throw new Refused("control-other-person");
  }

  /** One run's plan from the app. Its fields are named one by one, so what to POST can never reach a phone. */
  private async readPlan({ connectionId, schemaName, scriptName, action, targetVersion }: DeployPlanParams, signal: AbortSignal): Promise<ReadPlan> {
    const fields = objectFields(await ask(this.options, "POST", "/api/deploy/phone", { connectionId, schemaName, scriptName, action, targetVersion }, signal, PLAN_REFUSALS));
    const plan = readResult("deploy.plan", {
      action: fields?.action,
      connectionId: fields?.connectionId,
      schemaName: fields?.schemaName,
      scriptName: fields?.scriptName,
      targetVersion: fields?.targetVersion,
      environment: fields?.environment,
      partial: fields?.partial,
      fingerprint: fields?.fingerprint,
      scripts: Array.isArray(fields?.scripts) ? fields.scripts.map(readScript) : null,
      risks: fields?.risks,
      next: fields?.next,
      blockedReason: fields?.blockedReason,
      passkey: "none",
    });
    if (plan === null) throw unreadable("plan");
    const run = objectFields(fields?.run);
    const body = objectFields(run?.body);
    const path = run?.path;
    return {
      plan,
      run: typeof path === "string" && body !== null ? { path, body } : null,
      approvalRequest: objectFields(fields?.approvalRequest),
    };
  }
}

function runKey({ connectionId, schemaName, scriptName }: DeployFamilyParams): string {
  return JSON.stringify([connectionId, schemaName, scriptName]);
}

function canBeNamed(family: unknown): boolean {
  const fields = objectFields(family);
  return isSchemaName(fields?.schemaName) && isScriptText(fields?.scriptName) && isScriptText(fields?.newestVersion);
}

function describeRun(scriptName: string, action: ApprovalAction, targetVersion: string | null): string {
  if (targetVersion !== null) return `${scriptName} to ${targetVersion}`;
  return `${scriptName} to ${action === "deploy" ? "its newest version" : "before its first version"}`;
}

/** Only what was signed gets set, under the names each route reads. */
function acknowledgements(action: ApprovalAction, ticks: readonly ControlTick[]): Record<string, boolean> {
  const has = (tick: ControlTick): boolean => ticks.includes(tick);
  return action === "deploy"
    ? { acknowledgeProduction: has("production"), acknowledgeBreaking: has("breaking"), acknowledgeDataLoss: has("data-loss"), acknowledgeDrift: has("drift") }
    : { acknowledgeProduction: has("production"), acknowledgeOtherScripts: has("other-scripts"), acknowledgeDataLoss: has("data-loss") };
}

function outcomeOf(error: unknown): PhoneActionOutcome {
  return error instanceof Refused ? (ACTION_OUTCOMES[error.refusal] ?? "failed") : "failed";
}

function unreadable(what: string): Refused {
  logWarn(`The app's ${what} for phones was not in the shape the phone link reads.`);
  return new Refused("failed");
}

type RunEnd = { state: "done" | "not-applied" | "unknown"; outcome: PhoneActionOutcome; refusal: Refusal | null };

/**
 * How a run ended, from what the apply or revert route answered, read as
 * my-app/lib/apply-failure.ts reads it. Not being sure reads as not knowing,
 * never as done or as nothing having happened. refusalFor is not used here,
 * because 503 from these routes means the database, not the role.
 */
function readRunEnd(answer: AppAnswer | null): RunEnd {
  const fields = answer === null ? null : objectFields(answer.json);
  if (answer === null || fields === null || fields.outcomeUnknown === true) return { state: "unknown", outcome: "outcome-unknown", refusal: null };
  if (answer.status === 200 && fields.success === true) return { state: "done", outcome: "done", refusal: null };
  if (answer.status < 400) return { state: "unknown", outcome: "outcome-unknown", refusal: null };
  const refusal = refusalBeforeRun(answer.status, fields);
  if (refusal !== null) return { state: "not-applied", outcome: ACTION_OUTCOMES[refusal] ?? "failed", refusal };
  return { state: "not-applied", outcome: "not-applied", refusal: null };
}

function refusalBeforeRun(status: number, fields: Record<string, unknown>): Refusal | null {
  if (status === 409 || (status === 403 && fields.needsApproval === true)) return "control-changed";
  if (status === 401) return "signed-out";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  return null;
}
