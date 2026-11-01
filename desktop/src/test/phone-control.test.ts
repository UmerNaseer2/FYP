/**
 * A paired phone starting a deploy or a rollback, or cancelling a running query
 * (src/main/phone-control.ts). A fake plays the app's server and a fake stands
 * in for the passkey check, which src/test/phone-approvals.test.ts tests on its
 * own. So these tests check the order of the refusals, what reaches the routes
 * that run things, that a run goes on whatever happens to the phone, and that
 * each try leaves its entry in the action log.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import type { PhoneAction, PhoneActionOutcome } from "../core/phone-link-file";
import type { Clock } from "../main/clock";
import { initLog, logFilePaths } from "../main/log";
import { PhoneControlActions, START_WAIT_MS } from "../main/phone-control";
import { Refused, type AppAnswer, type PhoneControl, type PhoneControlRequests, type Refusal } from "../main/phone-requests";
import { cancelChallenge, deployChallenge, type ControlTick, type DeployStep } from "../shared/remote/control";
import type { Bytes } from "../shared/remote/bytes";
import type { DeployNext, DeployPlanParams, DeployStartParams, PasskeySignature, PasskeyState } from "../shared/remote/rpc";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-phone-control-"));
initLog(path.join(root, "logs"), { echo: false });
after(() => fs.rmSync(root, { recursive: true, force: true }));

function logText(): string {
  const file = logFilePaths()?.main;
  assert.ok(file, "the log has a folder");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

const PHONE = "phone-key";
const APPROVER = "a1".repeat(32);
const OTHER_APPROVER = "b2".repeat(32);
const NONCE = new Uint8Array(32).fill(7);
const SIGNATURE: PasskeySignature = { credentialId: "Y3JlZA", authenticatorData: "YXV0aA", clientDataJSON: "Y2xpZW50", signature: "c2ln" };
const FINGERPRINT = "ab".repeat(32);
const SQL = "ALTER TABLE orders ADD COLUMN note text";

const FAMILY = { connectionId: 5, schemaName: "sales", scriptName: "users_migration" };
const DEPLOY: DeployPlanParams = { ...FAMILY, action: "deploy", targetVersion: "2.0.0" };
const REVERT: DeployPlanParams = { ...FAMILY, action: "revert", targetVersion: "1.0.0" };

const SIGNAL = new AbortController().signal;
const PHONE_ROUTE = "POST /api/deploy/phone";
const LIST_ROUTE = "GET /api/deploy/phone?connectionId=5";
const APPLY = "POST /api/scripts/apply";
const REVERT_ROUTE = "POST /api/scripts/revert";
const ASK = "POST /api/deploy/approvals";
const CANCEL = "POST /api/performance/cancel";

class FakeClock implements Clock {
  time = 1_700_000_000_000;
  private timers: { at: number; run: () => void; id: number }[] = [];
  private lastId = 0;

  now = (): number => this.time;

  setTimeout = (run: () => void, ms: number): unknown => {
    this.lastId += 1;
    this.timers.push({ at: this.time + ms, run, id: this.lastId });
    return this.lastId;
  };

  clearTimeout = (timer: unknown): void => {
    this.timers = this.timers.filter((entry) => entry.id !== timer);
  };

  advance(ms: number): void {
    this.time += ms;
    const due = this.timers.filter((entry) => entry.at <= this.time);
    this.timers = this.timers.filter((entry) => entry.at > this.time);
    for (const entry of due) entry.run();
  }

  /** How many timers are still waiting, so a test can see one was cleaned up. */
  waiting(): number {
    return this.timers.length;
  }
}

type Answerable = AppAnswer | Error | ((body: unknown) => AppAnswer | Promise<AppAnswer>);

/** Everything a run's plan holds, as the app's route answers it. */
function planAnswer(changes: Record<string, unknown> = {}, action: "deploy" | "revert" = "deploy"): AppAnswer {
  const path = action === "deploy" ? "/api/scripts/apply" : "/api/scripts/revert";
  return {
    status: 200,
    json: {
      action,
      ...FAMILY,
      targetVersion: action === "deploy" ? "2.0.0" : "1.0.0",
      environment: "staging",
      partial: false,
      fingerprint: FINGERPRINT,
      scripts: [{ scriptName: FAMILY.scriptName, version: "2.0.0", sqlContent: SQL }],
      risks: { production: false, breaking: [], dataLoss: [], otherScripts: [], drift: null },
      next: "run",
      blockedReason: null,
      run: { path, body: { connectionId: 5, schemaName: "sales", dryRun: false, scripts: "what to run" } },
      approvalRequest: null,
      ...changes,
    },
  };
}

function askAnswer(changes: Record<string, unknown> = {}, action: "deploy" | "revert" = "deploy"): AppAnswer {
  return planAnswer({ next: "ask-approval", run: null, approvalRequest: { action, connectionId: 5, scripts: "what to ask for" }, ...changes }, action);
}

const RISKS = { production: false, breaking: [], dataLoss: [], otherScripts: [], drift: null };

/** One signed-in computer, with a fake app, a fake passkey check and one paired phone with Allow control on. */
class Fixture {
  readonly clock = new FakeClock();
  readonly answers = new Map<string, Answerable>([
    [PHONE_ROUTE, planAnswer()],
    [APPLY, { status: 200, json: { success: true } }],
    [REVERT_ROUTE, { status: 200, json: { success: true } }],
    [ASK, { status: 200, json: { approval: { id: 9 } } }],
    ["GET /api/me/approver", { status: 200, json: { approver: APPROVER } }],
  ]);
  readonly calls: { route: string; body: unknown; signal: AbortSignal }[] = [];
  readonly entries: Omit<PhoneAction, "at" | "phone">[] = [];
  allowed = true;
  shared: number[] = [5];
  signedIn = APPROVER;
  passkey: PasskeyState = "ready";
  /** Why the passkey's check refuses, when it should. */
  checkRefuses: Refusal | null = null;
  /** The text the passkey check last worked out. */
  challenge: Bytes | null = null;
  readonly actions: PhoneControlActions;
  readonly control: PhoneControl = {
    allowed: () => this.allowed,
    record: (entry) => {
      this.entries.push(entry);
    },
  };

  constructor() {
    this.actions = new PhoneControlActions({
      call: async (method, target, body, signal) => {
        const route = `${method} ${target}`;
        this.calls.push({ route, body, signal });
        const answer = this.answers.get(route);
        assert.ok(answer !== undefined, `${route} has an answer`);
        if (answer instanceof Error) throw answer;
        return typeof answer === "function" ? answer(body) : answer;
      },
      sharedConnectionIds: () => this.shared,
      approvals: {
        beginControl: () => ({ nonce: "bm9uY2U", credentialId: "Y3JlZA" }),
        checkControl: async (phoneKey, assertion, challengeFor) => {
          assert.equal(phoneKey, PHONE);
          assert.equal(assertion, SIGNATURE);
          this.challenge = await challengeFor(NONCE);
          if (this.checkRefuses !== null) throw new Refused(this.checkRefuses);
          return APPROVER;
        },
        controlPasskey: async () => this.passkey,
        whoAmI: async () => ({ approver: this.signedIn, canApprove: true, canControl: true }),
      },
      clock: this.clock,
    });
  }

  requests(): PhoneControlRequests {
    return this.actions.forPhone(PHONE, this.control);
  }

  routes(): string[] {
    return this.calls.map((call) => call.route);
  }

  /** Only what the entries came to, in order. */
  outcomes(): PhoneActionOutcome[] {
    return this.entries.map((entry) => entry.outcome);
  }
}

function start(params: DeployPlanParams = DEPLOY, step: DeployStep = "run", ticks: ControlTick[] = []): DeployStartParams {
  return { ...params, fingerprint: FINGERPRINT, step, ticks, assertion: SIGNATURE };
}

const CANCEL_PARAMS = { connectionId: 5, pid: 4242, queryStart: "2026-10-30T09:59:47.500Z", assertion: SIGNATURE };

async function refusalOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof Refused, `refused, not ${String(error)}`);
    return error.refusal;
  }
  assert.fail("it should have been refused");
}

/** Lets everything already finished run on. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Waits until `ready` says yes, for 2 seconds at the most. A start hashes its challenge
 * on a worker thread, so no fixed number of turns is sure to be enough on a busy computer.
 */
async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("Expected it within 2 seconds, but it did not happen.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** How many runs this fixture has started. */
function runsStarted(fixture: Fixture): number {
  return fixture.routes().filter((route) => route === APPLY).length;
}

test("refuses everything while Allow control is off, and asks the app nothing", async () => {
  const fixture = new Fixture();
  fixture.allowed = false;
  const requests = fixture.requests();
  assert.equal(await refusalOf(() => requests.deployList(5, SIGNAL)), "control-off");
  assert.equal(await refusalOf(() => requests.deployFamily(FAMILY, SIGNAL)), "control-off");
  assert.equal(await refusalOf(() => requests.deployPlan(DEPLOY, SIGNAL)), "control-off");
  assert.equal(await refusalOf(() => requests.begin()), "control-off");
  assert.equal(await refusalOf(() => requests.deployStart(start(), SIGNAL)), "control-off");
  assert.equal(await refusalOf(() => requests.cancelSession(CANCEL_PARAMS, SIGNAL)), "control-off");
  assert.deepEqual(fixture.calls, []);
  // Only what would have changed something leaves an entry.
  assert.deepEqual(fixture.outcomes(), ["control-off", "control-off"]);
});

test("refuses a connection not shared with phones, whatever is asked", async () => {
  const fixture = new Fixture();
  fixture.shared = [];
  const requests = fixture.requests();
  assert.equal(await refusalOf(() => requests.deployList(5, SIGNAL)), "not-shared");
  assert.equal(await refusalOf(() => requests.deployFamily(FAMILY, SIGNAL)), "not-shared");
  assert.equal(await refusalOf(() => requests.deployPlan(DEPLOY, SIGNAL)), "not-shared");
  assert.equal(await refusalOf(() => requests.deployStart(start(), SIGNAL)), "not-shared");
  assert.equal(await refusalOf(() => requests.cancelSession(CANCEL_PARAMS, SIGNAL)), "not-shared");
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.outcomes(), ["not-shared", "not-shared"]);
});

test("gives a phone the families it could name, and where its passkey stands", async () => {
  const fixture = new Fixture();
  fixture.passkey = "allowed";
  const family = { schemaName: "sales", scriptName: "users_migration", newestVersion: "2.0.0", versionCount: 2 };
  fixture.answers.set(LIST_ROUTE, {
    status: 200,
    json: {
      registry: "ok",
      partial: true,
      families: [
        family,
        { ...family, schemaName: "s".repeat(129) },
        { ...family, scriptName: "s".repeat(256) },
        { ...family, newestVersion: "v".repeat(256) },
        { ...family, schemaName: "" },
        "not a family",
      ],
    },
  });
  assert.deepEqual(await fixture.requests().deployList(5, SIGNAL), { registry: "ok", partial: true, families: [family], passkey: "allowed" });
  assert.deepEqual(fixture.routes(), [LIST_ROUTE]);

  fixture.answers.set(LIST_ROUTE, { status: 200, json: { registry: "unconfigured", partial: false, families: [] } });
  assert.deepEqual(await fixture.requests().deployList(5, SIGNAL), { registry: "unconfigured", partial: false, families: [], passkey: "allowed" });

  fixture.answers.set(LIST_ROUTE, { status: 200, json: { registry: "well", partial: false } });
  assert.equal(await refusalOf(() => fixture.requests().deployList(5, SIGNAL)), "failed");
  assert.ok(logText().includes("The app's list of script families for phones was not in the shape the phone link reads."));
});

test("says where a family stands, asking for only that family", async () => {
  const fixture = new Fixture();
  const undo = [{ target: "1.0.0", undoCount: 1 }, { target: null, undoCount: 2 }];
  fixture.answers.set(PHONE_ROUTE, { status: 200, json: { currentVersion: "2.0.0", waiting: ["3.0.0"], undo, partial: false, secret: "kept" } });
  assert.deepEqual(await fixture.requests().deployFamily(FAMILY, SIGNAL), { currentVersion: "2.0.0", waiting: ["3.0.0"], undo, partial: false, run: null });
  assert.deepEqual(fixture.calls[0]?.body, FAMILY);

  fixture.answers.set(PHONE_ROUTE, { status: 424, json: {} });
  assert.equal(await refusalOf(() => fixture.requests().deployFamily(FAMILY, SIGNAL)), "no-registry");
  fixture.answers.set(PHONE_ROUTE, { status: 200, json: { currentVersion: 7 } });
  assert.equal(await refusalOf(() => fixture.requests().deployFamily(FAMILY, SIGNAL)), "failed");
});

test("shows a phone a plan with its SQL and risks, and never what to send to run it", async () => {
  const fixture = new Fixture();
  const plan = await fixture.requests().deployPlan(DEPLOY, SIGNAL);
  assert.deepEqual(plan, {
    action: "deploy",
    ...FAMILY,
    targetVersion: "2.0.0",
    environment: "staging",
    partial: false,
    fingerprint: FINGERPRINT,
    scripts: [{ name: FAMILY.scriptName, version: "2.0.0", sql: SQL }],
    risks: RISKS,
    next: "run",
    blockedReason: null,
    passkey: "ready",
  });
  assert.deepEqual(fixture.calls[0]?.body, DEPLOY);

  fixture.answers.set(PHONE_ROUTE, askAnswer());
  const asking = await fixture.requests().deployPlan(DEPLOY, SIGNAL);
  assert.equal(asking.next, "ask-approval");
  assert.ok(!JSON.stringify(asking).includes("what to ask for"));
  assert.ok(!JSON.stringify(plan).includes("what to run"));

  fixture.answers.set(PHONE_ROUTE, planAnswer({ next: "go" }));
  assert.equal(await refusalOf(() => fixture.requests().deployPlan(DEPLOY, SIGNAL)), "failed");
  assert.ok(logText().includes("The app's plan for phones was not in the shape the phone link reads."));
  fixture.answers.set(PHONE_ROUTE, { status: 502, json: {} });
  assert.equal(await refusalOf(() => fixture.requests().deployPlan(DEPLOY, SIGNAL)), "unreachable");
});

test("signs what the phone showed: the action, the family, the version, the SQL's fingerprint, the step and the ticks", async () => {
  const fixture = new Fixture();
  const ticks: ControlTick[] = ["production", "drift"];
  fixture.answers.set(PHONE_ROUTE, planAnswer({ risks: { ...RISKS, production: true, drift: "drifted" }, next: "run-approved" }));
  await fixture.requests().deployStart(start(DEPLOY, "run", ticks), SIGNAL);
  assert.deepEqual(fixture.challenge, await deployChallenge(NONCE, { ...DEPLOY, fingerprint: FINGERPRINT, step: "run", ticks }));

  await fixture.requests().cancelSession(CANCEL_PARAMS, SIGNAL).catch(() => {});
  assert.deepEqual(fixture.challenge, await cancelChallenge(NONCE, CANCEL_PARAMS));
});

test("refuses a start in order, leaves its entry, and runs nothing", async () => {
  const cases: [string, (fixture: Fixture) => void, Refusal, PhoneActionOutcome][] = [
    ["no number", (f) => { f.checkRefuses = "control-expired"; }, "control-expired", "expired"],
    ["a passkey taken away", (f) => { f.checkRefuses = "control-no-passkey"; }, "control-no-passkey", "no-passkey"],
    ["a bad signature", (f) => { f.checkRefuses = "passkey-refused"; }, "passkey-refused", "passkey-refused"],
    ["control turned off", (f) => { f.allowed = false; }, "control-off", "control-off"],
    ["no longer shared", (f) => { f.shared = []; }, "not-shared", "not-shared"],
    ["someone else signed in", (f) => { f.signedIn = OTHER_APPROVER; }, "control-other-person", "other-person"],
    ["other SQL", (f) => { f.answers.set(PHONE_ROUTE, planAnswer({ fingerprint: "cd".repeat(32) })); }, "control-changed", "changed"],
    ["a new risk", (f) => { f.answers.set(PHONE_ROUTE, planAnswer({ risks: { ...RISKS, dataLoss: ["users_migration v2.0.0"] } })); }, "control-changed", "changed"],
    ["now waiting on someone", (f) => { f.answers.set(PHONE_ROUTE, planAnswer({ next: "waiting", run: null })); }, "control-changed", "changed"],
    ["now blocked", (f) => { f.answers.set(PHONE_ROUTE, planAnswer({ next: "blocked", blockedReason: "role", run: null })); }, "control-changed", "changed"],
    ["now a question for someone else", (f) => { f.answers.set(PHONE_ROUTE, askAnswer()); }, "control-changed", "changed"],
    ["a plan saying to run with nothing to run", (f) => { f.answers.set(PHONE_ROUTE, planAnswer({ run: null })); }, "control-changed", "changed"],
    ["the registry gone", (f) => { f.answers.set(PHONE_ROUTE, { status: 424, json: {} }); }, "no-registry", "no-registry"],
    ["the database gone", (f) => { f.answers.set(PHONE_ROUTE, { status: 502, json: {} }); }, "unreachable", "unreachable"],
    ["the app gone", (f) => { f.answers.set(PHONE_ROUTE, new Error("down")); }, "no-answer", "failed"],
  ];
  for (const [name, change, refusal, outcome] of cases) {
    const fixture = new Fixture();
    change(fixture);
    assert.equal(await refusalOf(() => fixture.requests().deployStart(start(), SIGNAL)), refusal, name);
    assert.deepEqual(fixture.outcomes(), [outcome], name);
    assert.ok(!fixture.routes().includes(APPLY), name);
    assert.ok(!fixture.routes().includes(ASK), name);
  }
});

test("checks the signature before it asks the app anything", async () => {
  const fixture = new Fixture();
  fixture.checkRefuses = "passkey-refused";
  await refusalOf(() => fixture.requests().deployStart(start(), SIGNAL));
  await refusalOf(() => fixture.requests().cancelSession(CANCEL_PARAMS, SIGNAL));
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.outcomes(), ["passkey-refused", "passkey-refused"]);
});

test("asks for an approval with what the app worked out, needing no ticks, on the request's signal", async () => {
  const fixture = new Fixture();
  const { signal } = new AbortController();
  fixture.answers.set(PHONE_ROUTE, askAnswer({ risks: { ...RISKS, production: true, dataLoss: ["users_migration v2.0.0"] } }));
  assert.deepEqual(await fixture.requests().deployStart(start(DEPLOY, "ask"), signal), { status: "sent-for-approval" });
  const asked = fixture.calls.at(-1);
  assert.equal(asked?.route, ASK);
  assert.deepEqual(asked?.body, { action: "deploy", connectionId: 5, scripts: "what to ask for" });
  assert.equal(asked?.signal, signal);
  assert.deepEqual(fixture.entries, [{ action: "deploy", connectionId: 5, schema: "sales", outcome: "sent-for-approval", detail: "users_migration to 2.0.0" }]);
  assert.ok(!fixture.routes().includes(APPLY));
});

test("refuses an ask when the plan no longer needs one, or when the app will not take it", async () => {
  const fixture = new Fixture();
  // The plan says to run: somebody approved this meanwhile. That needs a new signature.
  assert.equal(await refusalOf(() => fixture.requests().deployStart(start(DEPLOY, "ask"), SIGNAL)), "control-changed");
  assert.ok(!fixture.routes().includes(ASK));
  fixture.answers.set(PHONE_ROUTE, askAnswer({ approvalRequest: null }));
  assert.equal(await refusalOf(() => fixture.requests().deployStart(start(DEPLOY, "ask"), SIGNAL)), "control-changed");

  fixture.answers.set(PHONE_ROUTE, askAnswer());
  fixture.answers.set(ASK, { status: 403, json: {} });
  assert.equal(await refusalOf(() => fixture.requests().deployStart(start(DEPLOY, "ask"), SIGNAL)), "forbidden");
  assert.deepEqual(fixture.outcomes(), ["changed", "changed", "forbidden"]);
});

test("runs a deploy on a signal of its own, with what the app worked out and only the signed acknowledgements", async () => {
  const fixture = new Fixture();
  const controller = new AbortController();
  const ticks: ControlTick[] = ["production", "drift"];
  fixture.answers.set(PHONE_ROUTE, planAnswer({ risks: { ...RISKS, production: true, drift: "drifted" }, next: "run-approved" }));
  assert.deepEqual(await fixture.requests().deployStart(start(DEPLOY, "run", ticks), controller.signal), { status: "done" });

  const run = fixture.calls.at(-1);
  assert.equal(run?.route, APPLY);
  assert.deepEqual(run?.body, {
    connectionId: 5,
    schemaName: "sales",
    dryRun: false,
    scripts: "what to run",
    acknowledgeProduction: true,
    acknowledgeBreaking: false,
    acknowledgeDataLoss: false,
    acknowledgeDrift: true,
  });
  assert.notEqual(run?.signal, controller.signal);
  assert.deepEqual(fixture.routes(), [PHONE_ROUTE, APPLY]);
  const entry = { action: "deploy", connectionId: 5, schema: "sales", detail: "users_migration to 2.0.0" };
  assert.deepEqual(fixture.entries, [{ ...entry, outcome: "started" }, { ...entry, outcome: "done" }]);
  assert.equal(fixture.clock.waiting(), 0);
});

test("runs a rollback under the names the revert route reads", async () => {
  const fixture = new Fixture();
  const ticks: ControlTick[] = ["production", "other-scripts", "data-loss"];
  const risks = { ...RISKS, production: true, otherScripts: ["other v1"], dataLoss: ["users_migration v1.0.0"] };
  fixture.answers.set(PHONE_ROUTE, planAnswer({ risks }, "revert"));
  assert.deepEqual(await fixture.requests().deployStart(start(REVERT, "run", ticks), SIGNAL), { status: "done" });
  const run = fixture.calls.at(-1);
  assert.equal(run?.route, REVERT_ROUTE);
  assert.deepEqual(run?.body, {
    connectionId: 5,
    schemaName: "sales",
    dryRun: false,
    scripts: "what to run",
    acknowledgeProduction: true,
    acknowledgeOtherScripts: true,
    acknowledgeDataLoss: true,
  });
  assert.equal(fixture.entries[0]?.action, "rollback");
  assert.equal(fixture.entries[0]?.detail, "users_migration to 1.0.0");
});

test("says what a run with no version named goes to", async () => {
  const fixture = new Fixture();
  fixture.answers.set(PHONE_ROUTE, planAnswer({ targetVersion: null }));
  await fixture.requests().deployStart(start({ ...DEPLOY, targetVersion: null }), SIGNAL);
  assert.equal(fixture.entries[0]?.detail, "users_migration to its newest version");

  const back = new Fixture();
  back.answers.set(PHONE_ROUTE, planAnswer({ targetVersion: null }, "revert"));
  await back.requests().deployStart(start({ ...REVERT, targetVersion: null }), SIGNAL);
  assert.equal(back.entries[0]?.detail, "users_migration to before its first version");
});

test("takes a signed tick for a risk that has gone away, as it changes nothing", async () => {
  const fixture = new Fixture();
  assert.deepEqual(await fixture.requests().deployStart(start(DEPLOY, "run", ["data-loss"]), SIGNAL), { status: "done" });
  assert.equal(objectBody(fixture.calls.at(-1)?.body).acknowledgeDataLoss, true);
});

function objectBody(body: unknown): Record<string, unknown> {
  assert.ok(typeof body === "object" && body !== null);
  return body as Record<string, unknown>;
}

test("reads each way a run can end, and never says done or not applied without knowing", async () => {
  const cases: [string, Answerable, "done" | "not-applied" | "unknown" | Refusal, PhoneActionOutcome, string][] = [
    ["success", { status: 200, json: { success: true } }, "done", "done", "done"],
    ["200 without success", { status: 200, json: { success: false } }, "unknown", "outcome-unknown", "unknown"],
    ["some other good status", { status: 202, json: {} }, "unknown", "outcome-unknown", "unknown"],
    ["no words at all", { status: 200, json: null }, "unknown", "outcome-unknown", "unknown"],
    ["the route could not tell", { status: 500, json: { outcomeUnknown: true } }, "unknown", "outcome-unknown", "unknown"],
    ["no answer", new Error("the connection dropped"), "unknown", "outcome-unknown", "unknown"],
    ["a run that failed and rolled back", { status: 422, json: { error: "no such table" } }, "not-applied", "not-applied", "not-applied"],
    ["a server failure", { status: 500, json: { error: "boom" } }, "not-applied", "not-applied", "not-applied"],
    ["the database out of reach", { status: 503, json: { error: "down" } }, "not-applied", "not-applied", "not-applied"],
    ["a risk the route saw", { status: 409, json: {} }, "control-changed", "changed", "not-applied"],
    ["needs an approval after all", { status: 403, json: { needsApproval: true } }, "control-changed", "changed", "not-applied"],
    ["no right to run", { status: 403, json: {} }, "forbidden", "forbidden", "not-applied"],
    ["signed out", { status: 401, json: {} }, "signed-out", "signed-out", "not-applied"],
    ["gone", { status: 404, json: {} }, "not-found", "not-found", "not-applied"],
  ];
  for (const [name, reply, status, outcome, state] of cases) {
    const fixture = new Fixture();
    fixture.answers.set(APPLY, reply);
    const requests = fixture.requests();
    if (status === "done" || status === "not-applied" || status === "unknown") {
      assert.deepEqual(await requests.deployStart(start(), SIGNAL), { status }, name);
    } else {
      assert.equal(await refusalOf(() => requests.deployStart(start(), SIGNAL)), status, name);
    }
    assert.deepEqual(fixture.outcomes(), ["started", outcome], name);
    fixture.answers.set(PHONE_ROUTE, { status: 200, json: { currentVersion: "1.0.0", waiting: [], undo: [], partial: false } });
    assert.deepEqual((await requests.deployFamily(FAMILY, SIGNAL)).run, { state, at: fixture.clock.now() }, name);
  }
});

test("tells a phone to check back when a run takes long, and still writes how it ended", async () => {
  const fixture = new Fixture();
  let finish: (answer: AppAnswer) => void = () => {};
  fixture.answers.set(APPLY, () => new Promise<AppAnswer>((resolve) => { finish = resolve; }));
  const requests = fixture.requests();

  const started = requests.deployStart(start(), SIGNAL);
  await waitFor(() => runsStarted(fixture) === 1);
  assert.deepEqual(fixture.outcomes(), ["started"]);
  fixture.clock.advance(START_WAIT_MS);
  assert.deepEqual(await started, { status: "running" });
  assert.equal(fixture.clock.waiting(), 0);

  // While it runs, a second try is refused, from this phone or any other.
  fixture.answers.set(PHONE_ROUTE, planAnswer());
  assert.equal(await refusalOf(() => requests.deployStart(start(), SIGNAL)), "already-running");
  assert.equal(await refusalOf(() => fixture.actions.forPhone(PHONE, fixture.control).deployStart(start(), SIGNAL)), "already-running");
  assert.deepEqual(fixture.routes().filter((route) => route === APPLY), [APPLY]);

  fixture.answers.set(PHONE_ROUTE, { status: 200, json: { currentVersion: "1.0.0", waiting: ["2.0.0"], undo: [], partial: false } });
  const startedAt = fixture.clock.now();
  assert.deepEqual((await requests.deployFamily(FAMILY, SIGNAL)).run, { state: "running", at: startedAt - START_WAIT_MS });

  fixture.clock.advance(1000);
  finish({ status: 200, json: { success: true } });
  await settle();
  assert.deepEqual(fixture.outcomes(), ["started", "already-running", "already-running", "done"]);
  assert.deepEqual((await requests.deployFamily(FAMILY, SIGNAL)).run, { state: "done", at: fixture.clock.now() });
});

test("counts the phone's wait from when the request began, not from when the run did", async () => {
  const fixture = new Fixture();
  fixture.answers.set(PHONE_ROUTE, () => {
    fixture.clock.advance(START_WAIT_MS - 1);
    return planAnswer();
  });
  fixture.answers.set(APPLY, () => new Promise<AppAnswer>(() => {}));
  const started = fixture.requests().deployStart(start(), SIGNAL);
  await waitFor(() => runsStarted(fixture) === 1);
  await settle();
  fixture.clock.advance(1);
  assert.deepEqual(await started, { status: "running" });
});

test("keeps a run going when the phone goes away, without leaving a refusal unhandled", async () => {
  const fixture = new Fixture();
  const controller = new AbortController();
  let finish: (answer: AppAnswer) => void = () => {};
  let runSignal: AbortSignal | null = null;
  fixture.answers.set(APPLY, () => {
    runSignal = fixture.calls.at(-1)?.signal ?? null;
    return new Promise<AppAnswer>((resolve) => { finish = resolve; });
  });
  const started = fixture.requests().deployStart(start(), controller.signal);
  await waitFor(() => runsStarted(fixture) === 1);
  controller.abort();
  assert.deepEqual(await started, { status: "running" });
  assert.equal((runSignal as AbortSignal | null)?.aborted, false);

  // Ends with a refusal nobody is waiting for. A test run fails on an unhandled one.
  finish({ status: 409, json: {} });
  await settle();
  assert.deepEqual(fixture.outcomes(), ["started", "changed"]);
  assert.equal(fixture.clock.waiting(), 0);
});

test("answers at once when the phone left just before its run began", async () => {
  const fixture = new Fixture();
  const controller = new AbortController();
  fixture.answers.set(APPLY, () => {
    controller.abort();
    return new Promise<AppAnswer>(() => {});
  });
  const started = fixture.requests().deployStart(start(), controller.signal);
  assert.deepEqual(await started, { status: "running" });
  assert.equal(fixture.clock.waiting(), 0);
});

test("lets a family run again once its last run has ended, and keeps families apart", async () => {
  const fixture = new Fixture();
  const requests = fixture.requests();
  assert.deepEqual(await requests.deployStart(start(), SIGNAL), { status: "done" });
  assert.deepEqual(await requests.deployStart(start(), SIGNAL), { status: "done" });

  const holds = new Fixture();
  holds.answers.set(APPLY, () => new Promise<AppAnswer>(() => {}));
  const first = holds.requests().deployStart(start(), SIGNAL);
  await waitFor(() => runsStarted(holds) === 1);
  holds.answers.set(PHONE_ROUTE, planAnswer({ scriptName: "other_script" }));
  const second = holds.requests().deployStart(start({ ...DEPLOY, scriptName: "other_script" }), SIGNAL);
  await waitFor(() => runsStarted(holds) === 2);
  await settle();
  holds.clock.advance(START_WAIT_MS);
  assert.deepEqual(await first, { status: "running" });
  assert.deepEqual(await second, { status: "running" });
});

test("cancels exactly the query the phone signed for, and logs how it went", async () => {
  const fixture = new Fixture();
  const { signal } = new AbortController();
  fixture.answers.set(CANCEL, { status: 200, json: { status: "cancelled", secret: "kept" } });
  assert.deepEqual(await fixture.requests().cancelSession(CANCEL_PARAMS, signal), { status: "cancelled" });
  const call = fixture.calls.at(-1);
  assert.deepEqual(call?.body, { connectionId: 5, pid: 4242, queryStart: CANCEL_PARAMS.queryStart });
  assert.equal(call?.signal, signal);
  assert.deepEqual(fixture.entries, [{ action: "cancel-query", connectionId: 5, schema: null, outcome: "done", detail: "session 4242" }]);

  fixture.answers.set(CANCEL, { status: 200, json: { status: "gone" } });
  assert.deepEqual(await fixture.requests().cancelSession(CANCEL_PARAMS, signal), { status: "gone" });
  assert.equal(fixture.entries.at(-1)?.outcome, "gone");
});

test("refuses a cancel in order, leaves its entry, and cancels nothing it should not", async () => {
  const before: [(fixture: Fixture) => void, Refusal, PhoneActionOutcome][] = [
    [(f) => { f.checkRefuses = "control-expired"; }, "control-expired", "expired"],
    [(f) => { f.checkRefuses = "passkey-refused"; }, "passkey-refused", "passkey-refused"],
    [(f) => { f.allowed = false; }, "control-off", "control-off"],
    [(f) => { f.shared = []; }, "not-shared", "not-shared"],
    [(f) => { f.signedIn = OTHER_APPROVER; }, "control-other-person", "other-person"],
  ];
  for (const [change, refusal, outcome] of before) {
    const fixture = new Fixture();
    change(fixture);
    assert.equal(await refusalOf(() => fixture.requests().cancelSession(CANCEL_PARAMS, SIGNAL)), refusal);
    assert.deepEqual(fixture.outcomes(), [outcome]);
    assert.ok(!fixture.routes().includes(CANCEL));
  }

  const answers: [number, Refusal, PhoneActionOutcome][] = [
    [409, "database-refused", "database-refused"],
    [423, "read-only", "read-only"],
    [403, "forbidden", "forbidden"],
    [404, "not-found", "not-found"],
    [401, "signed-out", "signed-out"],
    [502, "unreachable", "unreachable"],
    [500, "failed", "failed"],
  ];
  for (const [status, refusal, outcome] of answers) {
    const fixture = new Fixture();
    fixture.answers.set(CANCEL, { status, json: { error: "words of the server" } });
    assert.equal(await refusalOf(() => fixture.requests().cancelSession(CANCEL_PARAMS, SIGNAL)), refusal);
    assert.deepEqual(fixture.outcomes(), [outcome]);
  }

  const fixture = new Fixture();
  fixture.answers.set(CANCEL, { status: 200, json: { status: "maybe" } });
  assert.equal(await refusalOf(() => fixture.requests().cancelSession(CANCEL_PARAMS, SIGNAL)), "failed");
  assert.ok(logText().includes("The app's answer to a cancel for phones was not in the shape the phone link reads."));
});

test("logs no SQL or who is signed in, even when a run could not tell how it ended", async () => {
  const fixture = new Fixture();
  fixture.answers.set(APPLY, new Error("no answer"));
  await fixture.requests().deployStart(start(), SIGNAL);
  const lines = logText();
  assert.ok(lines.includes("The phone link could not tell how a phone's run ended."));
  for (const secret of [SQL, APPROVER, OTHER_APPROVER, SIGNATURE.signature]) assert.ok(!lines.includes(secret));
});

/** Every value of next a plan can hold, so a new one cannot slip past the run and ask checks. */
const NOT_A_RUN: DeployNext[] = ["ask-approval", "waiting", "blocked"];

test("starts a run only for a plan that says to run", async () => {
  for (const next of NOT_A_RUN) {
    const fixture = new Fixture();
    fixture.answers.set(PHONE_ROUTE, planAnswer({ next }));
    assert.equal(await refusalOf(() => fixture.requests().deployStart(start(), SIGNAL)), "control-changed", next);
  }
});
