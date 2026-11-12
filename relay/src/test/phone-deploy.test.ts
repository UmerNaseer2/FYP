/**
 * The phone app's rules and sentences for starting a run and cancelling a query
 * (src/phone/deploy.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKED_TEXT,
  cancelResultText,
  deployButtonText,
  HIDDEN_TEXT,
  hidesCharacters,
  mayCancel,
  mayControl,
  passkeyText,
  planTitle,
  registryText,
  riskRows,
  rollbackButtonText,
  runText,
  startStatusText,
  startStatusTone,
  stepButton,
  stepOf,
  stepText,
  whereText,
} from "../phone/deploy.js";
import type { RunRisks } from "../shared/remote/control.js";
import type { DeployBlockedReason, DeployNext, LiveControl, LiveSession } from "../shared/remote/rpc.js";

const NOW = Date.UTC(2026, 10, 1, 12);

const NO_RISKS: RunRisks = { breaking: [], dataLoss: [], otherScripts: [], drift: null };

const ALL_RISKS: RunRisks = {
  breaking: ["users v2"],
  dataLoss: ["users v3"],
  otherScripts: ["orders v1"],
  drift: "drifted",
};

const CONTROL: LiveControl = { allowed: true, canCheck: true, canAcknowledge: true, canDeploy: true, canCancel: true, passkey: "ready" };

function session(fields: Partial<LiveSession> = {}): LiveSession {
  return {
    pid: 41,
    kind: "running",
    querySeconds: 1,
    queryStart: "2026-11-01T12:00:00.000Z",
    xactSeconds: null,
    applicationName: null,
    waitingOn: null,
    query: null,
    ...fields,
  };
}

test("a query can be cancelled only when the role allows it and it is really running", () => {
  assert.equal(mayCancel(session(), CONTROL), true);
  assert.equal(mayCancel(session({ kind: "blocked" }), CONTROL), true);
  assert.equal(mayCancel(session({ kind: "long-running" }), CONTROL), true);
  assert.equal(mayCancel(session({ kind: "idle-in-transaction" }), CONTROL), false);
  assert.equal(mayCancel(session({ queryStart: null }), CONTROL), false);
  assert.equal(mayCancel(session(), { ...CONTROL, canCancel: false }), false);
  assert.equal(mayCancel(session(), null), false);
});

test("a cancel's result says what happened, and does not promise it has stopped", () => {
  assert.match(cancelResultText("cancelled"), /told to cancel/);
  assert.match(cancelResultText("gone"), /already finished/);
});

test("control is on offer only with Allow control on and a role that may do something", () => {
  assert.equal(mayControl(CONTROL), true);
  assert.equal(mayControl({ ...CONTROL, canDeploy: false }), true);
  assert.equal(mayControl({ ...CONTROL, canCancel: false }), true);
  assert.equal(mayControl({ ...CONTROL, canDeploy: false, canCancel: false }), false);
  assert.equal(mayControl({ ...CONTROL, allowed: false }), false);
  assert.equal(mayControl(null), false);
});

test("every risk gets one warning, always in the same order, with the scripts it is about", () => {
  assert.deepEqual(riskRows(NO_RISKS), []);
  const rows = riskRows(ALL_RISKS);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0]?.labels, ["users v2"]);
  assert.deepEqual(rows[1]?.labels, ["users v3"]);
  assert.deepEqual(rows[2]?.labels, ["orders v1"]);
  assert.match(rows[3]?.text ?? "", /changed outside Schema Studio/);
  assert.match(riskRows({ ...NO_RISKS, drift: "unreachable" })[0]?.text ?? "", /could not reach/);
});

test("a run and an approved run are signed as a run, a request as an ask, and anything else is not signed", () => {
  const steps: [DeployNext, "run" | "ask" | null][] = [
    ["run", "run"],
    ["run-approved", "run"],
    ["ask-approval", "ask"],
    ["waiting", null],
    ["blocked", null],
  ];
  for (const [next, step] of steps) assert.equal(stepOf(next), step, next);
});

test("the passkey button is named for what it does, and only a step that can be taken has one", () => {
  assert.equal(stepButton("run", "deploy"), "Deploy with passkey");
  assert.equal(stepButton("run", "revert"), "Roll back with passkey");
  assert.equal(stepButton("run-approved", "deploy"), "Deploy with passkey");
  assert.equal(stepButton("run-approved", "revert"), "Roll back with passkey");
  assert.equal(stepButton("ask-approval", "deploy"), "Ask for approval with passkey");
  assert.equal(stepButton("waiting", "deploy"), null);
  assert.equal(stepButton("blocked", "revert"), null);
});

test("a run whose SQL holds characters that do not show on screen has no passkey button, while CRLF is fine", () => {
  const run = (...sql: string[]) => ({ scripts: sql.map((text, index) => ({ name: "users", version: `${index + 1}.0.0`, sql: text })) });
  // PostgreSQL ends the comment at the carriage return and runs the DROP, while a screen shows one comment.
  assert.equal(hidesCharacters(run("CREATE INDEX users_email ON users (email); -- adds an index\rDROP TABLE accounts;")), true);
  assert.equal(hidesCharacters(run("CREATE INDEX users_email ON users (email);", "SELECT 1;\u{FEFF}")), true);
  assert.equal(hidesCharacters(run("CREATE INDEX users_email ON users (email);\r\n\tCREATE INDEX users_name ON users (name);\r\n")), false);
  assert.equal(hidesCharacters(run()), false);
  assert.match(HIDDEN_TEXT, /^This SQL contains characters that do not show on screen,/);
  assert.match(HIDDEN_TEXT, /so this cannot be signed here\. Check it on the computer\.$/);
});

test("every step says what signing does, or why there is nothing to sign", () => {
  assert.match(stepText({ next: "run", blockedReason: null }), /straight away/);
  assert.match(stepText({ next: "run-approved", blockedReason: null }), /has been approved/);
  assert.match(stepText({ next: "ask-approval", blockedReason: null }), /nothing changes yet/);
  assert.match(stepText({ next: "waiting", blockedReason: null }), /waiting for someone/);
  for (const reason of Object.keys(BLOCKED_TEXT) as DeployBlockedReason[]) {
    assert.equal(stepText({ next: "blocked", blockedReason: reason }), BLOCKED_TEXT[reason]);
  }
  assert.match(stepText({ next: "blocked", blockedReason: null }), /cannot run/);
});

test("a start's result is honest about what is known", () => {
  assert.equal(startStatusText("done", "deploy"), "Deployed.");
  assert.equal(startStatusText("done", "revert"), "Rolled back.");
  assert.match(startStatusText("sent-for-approval", "deploy"), /An Admin has to approve/);
  assert.match(startStatusText("running", "deploy"), /Still running/);
  assert.match(startStatusText("not-applied", "revert"), /nothing changed/);
  assert.match(startStatusText("unknown", "deploy"), /Check the database/);
  assert.equal(startStatusTone("done"), "info");
  assert.equal(startStatusTone("sent-for-approval"), "info");
  assert.equal(startStatusTone("running"), "info");
  assert.equal(startStatusTone("not-applied"), "bad");
  assert.equal(startStatusTone("unknown"), "bad");
});

test("the last run reads with its time", () => {
  const at = NOW - 3 * 60_000;
  assert.match(runText({ state: "running", at }, NOW), /still going/);
  assert.match(runText({ state: "done", at }, NOW), /finished 3 minutes ago/);
  assert.match(runText({ state: "not-applied", at }, NOW), /nothing changed/);
  assert.match(runText({ state: "unknown", at }, NOW), /Check the database/);
});

test("the registry and the passkey say what to do about them, only when there is something to do", () => {
  assert.equal(registryText("ok"), null);
  assert.match(registryText("unconfigured") ?? "", /not set up/);
  assert.match(registryText("unreachable") ?? "", /could not read/);
  assert.equal(passkeyText("ready"), null);
  assert.equal(passkeyText("allowed"), null);
  assert.match(passkeyText("none") ?? "", /Set up passkey/);
  assert.match(passkeyText("other-person") ?? "", /Remove passkey and then Set up passkey/);
});

test("where a script stands, and what its buttons say", () => {
  assert.equal(whereText({ currentVersion: "1.2.0", waiting: ["1.3.0", "1.4.0"] }), "On v1.2.0, 2 waiting");
  assert.equal(whereText({ currentVersion: "1.2.0", waiting: [] }), "On v1.2.0, nothing waiting");
  assert.equal(whereText({ currentVersion: null, waiting: ["1.0.0"] }), "Not applied yet, 1 waiting");
  assert.equal(deployButtonText("v3"), "Deploy up to v3");
  assert.equal(rollbackButtonText({ target: "2", undoCount: 1 }), "Roll back to v2 (undoes 1 version)");
  assert.equal(rollbackButtonText({ target: null, undoCount: 3 }), "Roll back to before the first version (undoes 3 versions)");
  assert.equal(planTitle("deploy", "3"), "Deploy up to v3");
  assert.equal(planTitle("revert", "2"), "Roll back to v2");
  assert.equal(planTitle("revert", null), "Roll back to before the first version");
});
