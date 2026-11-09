/**
 * The phone app's screens, built from what main.ts knows. Each one is a
 * list of elements for the main part of the page; what the buttons do is
 * main.ts's, through Actions.
 */
import { ACTION_LABELS, requestedText, requestSize, requestTitle, versionText, type Choices } from "./approvals.js";
import { BUILD_VERSION } from "./build-info.js";
import { allTicked, CANCEL_QUESTION, cancelResultText, deployButtonText, HIDDEN_TEXT, hidesCharacters, mayCancel, mayControl, MISMATCH_TEXT, NO_FAMILIES_TEXT, PARTIAL_TEXT, passkeyText, planTitle, registryText, riskRows, rollbackButtonText, runText, startStatusText, startStatusTone, stepButton, stepOf, stepText, whereText, type RiskRow } from "./deploy.js";
import { button, el, envBadge, failed, heading, loading, notice, type Child } from "./dom.js";
import { accessProblem, CHANGE_LABELS, countText, dayText, foreignKeyText, SEVERITY_LABELS, showHiddenCharacters, targetHeadline } from "./format.js";
import {
  ACKNOWLEDGE_QUESTION,
  activityProblemText,
  agoText,
  controlHint,
  driftCheckedText,
  driftControls,
  driftProblemText,
  driftTag,
  healthSinceText,
  HEALTH_LABELS,
  HEALTH_TONES,
  KIND_LABELS,
  KIND_TONES,
  longRunningText,
  moreSessionsText,
  queryTextHint,
  sessionTimeText,
  timeText,
  transactionText,
  type DriftResult,
  type Tone,
} from "./live.js";
import type { Route } from "./routes.js";
import type { PairedComputer } from "./store.js";
import type { ApprovalDecision, ApprovalScript } from "../shared/remote/approval.js";
import type { ControlTick } from "../shared/remote/control.js";
import { MAX_COMPARE_TARGETS } from "../shared/remote/rpc.js";
import type { ApprovalList, ApprovalRead, ApprovalSummary, CancelResult, CompareSummary, DeployFamilyStatus, DeployList, DeployPlan, DeployStartStatus, HelloResult, LiveActivity, LiveControl, LiveDrift, LiveHealth, LiveSession, LiveStatus, PasskeyState, SchemaOverview, SharedConnection } from "../shared/remote/rpc.js";

/** Something asked of the computer: still coming, in, or failed with a sentence to show. */
export type Load<T> = { status: "loading" } | { status: "loaded"; value: T } | { status: "failed"; message: string };
export type CompareForm = { sourceId: number | null; schema: string; targets: Set<number> };

/**
 * Where a step that needs the phone's passkey has got to. The computer's
 * challenge is asked for as the screen opens (prepared), because a browser
 * lets a page use a passkey only straight after a tap, not after waiting for
 * the computer.
 */
export type PasskeyStep<W> = { prepared: Load<unknown> | null; working: W | null; problem: string | null };

/** The Drift alerts part of Settings. */
export type AlertsView =
  /** This browser cannot get alerts, and the sentence says why. */
  | { kind: "unsupported"; message: string }
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  /** blocked: the person turned alerts off for the app in the phone's settings. */
  | { kind: "ready"; on: boolean; working: boolean; blocked: boolean; problem: string | null };

export type Actions = {
  go(route: Route): void;
  openScan(): void;
  restartScan(): void;
  openCode(): void;
  setCode(text: string): void;
  submitCode(): void;
  setName(name: string): void;
  pair(name: string): void;
  cancelPairing(): void;
  checkAgain(): void;
  refresh(): void;
  compareFrom(connectionId: number, schema: string): void;
  setCompare(sourceId: number, schema: string): void;
  toggleTarget(id: number, on: boolean): void;
  runCompare(): void;
  toggleTable(key: string, open: boolean): void;
  setFilter(text: string): void;
  askForget(on: boolean): void;
  forget(): void;
  reload(): void;
  setUpPasskey(): void;
  decide(decision: ApprovalDecision): void;
  turnOnAlerts(): void;
  turnOffAlerts(): void;
  checkDrift(connectionId: number, id: number): void;
  /** Asks the question before an acknowledgement, for this tracked schema, or takes it away. */
  askAcknowledge(id: number | null): void;
  acknowledgeDrift(connectionId: number, id: number): void;
  /** Ticks or unticks a risk of the run being looked at. */
  toggleTick(tick: ControlTick, on: boolean): void;
  startRun(): void;
  /** Asks the question before cancelling this session's query, or takes it away. */
  askCancel(session: LiveSession | null): void;
  cancelQuery(): void;
};

/** What the Enter a code screen shows. main.ts keeps it, because a screen is built again on every change. */
export type CodeForm = { typed: string; checking: boolean; problem: string | null };
/** The Scan screen's parts that change while it shows. */
export type ScanUi = { video: HTMLVideoElement; message: HTMLParagraphElement; retry: HTMLButtonElement };

/** What shows when the app cannot run, or cannot use its storage. */
export function blockedScreen(message: string, canReload: boolean, actions: Actions): Node[] {
  return [heading("The phone app cannot open"), notice(message, "bad", canReload && button("Reload", actions.reload, { class: "secondary" }))];
}

/**
 * The first screen on a device that has not paired. `typedFirst` is for a device
 * whose camera is unlikely to be pointed at a screen, such as a laptop, where
 * typing the code is the easier way.
 */
export function pairScreen(alert: string | null, iosTip: boolean, typedFirst: boolean, actions: Actions): Node[] {
  const scan = button("Scan the code", actions.openScan, { class: typedFirst ? "secondary" : "primary" });
  const type = button("Enter a code", actions.openCode, { class: typedFirst ? "primary" : "secondary", id: "enter-code" });
  return [
    heading("Pair with a computer"),
    alert !== null && notice(alert, "bad"),
    el("p", { class: "lead" }, "See a computer's schemas and live status from here, and compare schemas, wherever you are. Schema Studio has to be running on the computer."),
    el(
      "ol",
      { class: "steps" },
      el("li", {}, "On the computer, open Schema Studio and go to Settings."),
      el("li", {}, "Under Phone, turn on Let paired phones connect, then choose Show a code."),
      el("li", {}, "Scan the QR code it shows, or type the short code beside it."),
    ),
    el("div", { class: "actions" }, typedFirst ? [type, scan] : [scan, type]),
    iosTip &&
      notice(
        "On an iPhone or iPad, add this page to the Home Screen first (the Share button, then Add to Home Screen), open it from there, and scan the code in the app. A link opened from the camera opens in Safari, which keeps its pairing apart from the Home Screen app's.",
        "info",
      ),
  ].filter((node) => node !== false);
}

/**
 * Naming the phone before it pairs. `status` says where the pairing has got
 * to while it is under way, and the name typed so far goes to setName, so a
 * new picture of the screen keeps it. `typed` says the code was typed in, so
 * this is most likely a browser on a device with no camera to scan another with.
 */
export function confirmScreen(name: string, problem: string | null, pairing: boolean, status: string | null, replaces: string | null, typed: boolean, actions: Actions): Node[] {
  const device = typed ? "browser" : "phone";
  const input = el("input", { id: "phone-name", type: "text", maxlength: 64, autocomplete: "off", value: name, disabled: pairing });
  input.addEventListener("input", () => actions.setName(input.value));
  const form = el(
    "form",
    { class: "card" },
    el("label", { class: "field", for: "phone-name" }, `Name this ${device}`),
    input,
    el("p", { class: "hint" }, `The computer lists this ${device} under this name in Settings, under Paired phones.`),
    replaces !== null && el("p", { class: "hint" }, `This ${device} is paired with ${replaces}. Pairing with this code replaces that pairing.`),
    status !== null && el("p", { class: "hint", role: "status" }, status),
    el(
      "div",
      { class: "actions" },
      problem === null
        ? el("button", { type: "submit", class: "primary", id: "pair", disabled: pairing }, pairing ? "Pairing\u{2026}" : "Pair")
        : typed
          ? button("Enter a new code", actions.openCode, { class: "primary", id: "code-again" })
          : button("Scan a new code", actions.openScan, { class: "primary", id: "scan-again" }),
      button("Cancel", actions.cancelPairing, { class: "secondary", id: "cancel" }),
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    actions.pair(input.value);
  });
  const title = heading(`Pair this ${device}`);
  return problem !== null ? [title, notice(problem, "bad"), form] : [title, form];
}

/** Typing the short code Settings shows beside the QR code, for a device with no camera to scan it with. */
export function codeScreen(form: CodeForm, actions: Actions): Node[] {
  const input = el("input", {
    id: "short-code",
    class: "code-input",
    // A text box, which main.ts keeps the cursor in when the screen is built again.
    type: "text",
    maxlength: 12,
    placeholder: "XXXX-XXXX",
    autocomplete: "off",
    autocapitalize: "characters",
    // As a string, because el leaves out an attribute that is false, and the browser would then check the spelling.
    spellcheck: "false",
    value: form.typed,
    // Not disabled, which would take the focus away while the code is checked.
    readonly: form.checking,
  });
  input.addEventListener("input", () => actions.setCode(input.value));
  const box = el(
    "form",
    { class: "card" },
    el("label", { class: "field", for: "short-code" }, "The code on the computer"),
    input,
    el("p", { class: "hint" }, "In Schema Studio on the computer, go to Settings and choose Show a code under Phone. The code has 8 letters and numbers, and runs out after 5 minutes."),
    el(
      "div",
      { class: "actions" },
      el("button", { type: "submit", class: "primary", id: "code-continue", disabled: form.checking }, form.checking ? "Checking\u{2026}" : "Continue"),
    ),
  );
  box.addEventListener("submit", (event) => {
    event.preventDefault();
    actions.submitCode();
  });
  const title = heading("Enter a code");
  return form.problem !== null ? [title, notice(form.problem, "bad"), box] : [title, box];
}

export function scanScreen(actions: Actions): { nodes: Node[]; ui: ScanUi } {
  const video = el("video", { playsinline: true, muted: true, autoplay: true, "aria-label": "The camera's picture" });
  video.muted = true;
  const message = el("p", { class: "hint", role: "status" }, "Starting the camera\u{2026}");
  const retry = button("Try again", actions.restartScan, { class: "secondary", hidden: true });
  const nodes = [
    heading("Scan the code"),
    el("div", { class: "scan-view" }, video, el("div", { class: "scan-frame", "aria-hidden": "true" })),
    message,
    el("div", { class: "actions" }, retry),
  ];
  return { nodes, ui: { video, message, retry } };
}

/** A tappable row that opens a connection. */
function connectionRow(connection: SharedConnection, actions: Actions): HTMLButtonElement {
  return button(
    [el("span", { class: "row-main" }, el("span", { class: "row-title" }, connection.name), el("span", { class: "mono muted" }, connection.database)), envBadge(connection.environment)],
    () => actions.go({ screen: "connection", connectionId: connection.id }),
    { class: "row", id: `connection-${connection.id}` },
  );
}

export function homeScreen(computerName: string, hello: HelloResult | null, connections: Load<SharedConnection[]>, actions: Actions): Node[] {
  const problem = hello === null ? null : accessProblem(hello);
  const nodes: Node[] = [heading(computerName)];
  if (problem !== null) nodes.push(notice(problem, "bad", button("Check again", actions.checkAgain, { class: "secondary", id: "check-again" })));
  if (hello !== null && !hello.signedIn) return nodes;
  if (connections.status === "loading") return [...nodes, loading("Asking the computer for its connections\u{2026}")];
  if (connections.status === "failed") return [...nodes, failed(connections.message, actions.refresh)];
  const list = connections.value;
  if (list.length === 0) {
    nodes.push(notice("The computer shares no connections with phones yet. On the computer, choose them in Settings, under Connections phones may see.", "info"));
    return nodes;
  }
  nodes.push(el("h2", { class: "section" }, "Connections"), el("div", { class: "list" }, list.map((connection) => connectionRow(connection, actions))));
  if (hello?.canCompare && list.length >= 2) {
    nodes.push(el("div", { class: "actions" }, button("Compare schemas", () => actions.go({ screen: "compare" }), { class: "primary", id: "compare" })));
  } else if (list.length === 1) {
    nodes.push(el("p", { class: "hint" }, "To compare schemas, share another connection with phones in Settings on the computer."));
  }
  return nodes;
}

export function connectionScreen(connection: SharedConnection | null, schemas: Load<string[]> | undefined, canSeeLive: boolean, actions: Actions, connectionId: number): Node[] {
  const nodes: Node[] = [heading(connection?.name ?? "Connection")];
  if (connection !== null) nodes.push(el("p", { class: "lead" }, envBadge(connection.environment), " ", el("span", { class: "mono" }, connection.database)));
  // Before the schemas load, because live status does not depend on them.
  if (canSeeLive) nodes.push(el("div", { class: "actions" }, button("Live status", () => actions.go({ screen: "live", connectionId }), { class: "secondary", id: "live-status" })));
  if (schemas === undefined || schemas.status === "loading") return [...nodes, loading("Asking the computer for the schemas\u{2026}")];
  if (schemas.status === "failed") return [...nodes, failed(schemas.message, actions.refresh)];
  if (schemas.value.length === 0) return [...nodes, notice("This database has no schemas this app can show.", "info")];
  const rows = schemas.value.map((schema) =>
    button(el("span", { class: "row-title mono" }, schema), () => actions.go({ screen: "schema", connectionId, schema }), { class: "row", id: `schema-${schema}` }),
  );
  return [...nodes, el("h2", { class: "section" }, countText(schemas.value.length, "schema", "schemas")), el("div", { class: "list" }, rows)];
}

/** What the live status screen knows: the newest answer, and how the link and the last ask went. */
export type LiveView = {
  /** The newest answer, kept while a new one is on its way so the numbers do not blink away. */
  status: LiveStatus | null;
  /** When the answer came, by this phone's own clock. */
  at: number | null;
  /** False while the computer is away: the numbers then show as old. */
  linked: boolean;
  /** Why the last ask failed, when it did. */
  problem: string | null;
  driftActions: DriftActions;
  cancelling: CancelView;
  /** Setting up this device's passkey, for the buttons that need one. */
  setup: PasskeyStep<"create">;
  passkeys: boolean;
};

/** Cancel query's question, and how the last one ended. */
export type CancelView = PasskeyStep<true> & {
  /** The session the question is about, or null when nothing is being asked. */
  pid: number | null;
  /** Stays when the session leaves the list, since that is what a cancel is for. */
  result: CancelResult["status"] | null;
};

/** What the screen for one run shows. */
export type PlanView = {
  plan: Load<DeployPlan> | undefined;
  /** The fingerprint of the SQL, worked out on this device: null if it could not be, undefined while it is being worked out. */
  hash: string | null | undefined;
  ticked: ReadonlySet<ControlTick>;
  starting: PasskeyStep<true> & { result: DeployStartStatus | null };
  setup: PasskeyStep<"create">;
  passkeys: boolean;
};

/** What the drift part is in the middle of. One action runs at a time. */
export type DriftActions = {
  running: { id: number; what: "check" | "acknowledge" } | null;
  /** Which tracked schema's Acknowledge is waiting for its second tap. */
  confirming: number | null;
  /** How the last action went, shown under the schema it was for. */
  result: (DriftResult & { id: number }) | null;
};

/**
 * What a database is doing right now. The computer asks it each time, so the
 * screen is as live as the link: it refreshes only while it is open, and
 * every number on it stays marked with the time it was read.
 */
export function liveScreen(connection: SharedConnection | null, connectionId: number, view: LiveView, openTables: ReadonlySet<string>, now: number, actions: Actions): Node[] {
  const nodes: Node[] = [heading("Live status")];
  if (connection !== null) nodes.push(el("p", { class: "lead" }, envBadge(connection.environment), ` ${connection.name} \u{2022} `, el("span", { class: "mono" }, connection.database)));
  const { status, at } = view;
  if (status === null || at === null) {
    if (view.problem !== null) return [...nodes, failed(view.problem, actions.refresh)];
    return [...nodes, loading(view.linked ? "Asking the computer what this database is doing\u{2026}" : "Live status will show when the computer comes back.")];
  }
  nodes.push(el("p", { class: "hint", id: "live-updated" }, view.linked ? `Updated ${timeText(at)}. Refreshes every 5 seconds while this screen is open.` : `Last updated ${agoText(at, now)}. These numbers are old, because the computer is away.`));
  if (view.problem !== null) nodes.push(notice(`Could not refresh just now. ${view.problem}`, "info"));
  if (view.cancelling.result !== null) nodes.push(notice(cancelResultText(view.cancelling.result), "info"));
  if (view.cancelling.problem !== null) nodes.push(notice(view.cancelling.problem, "bad"));
  const { control } = status;
  if (view.linked && control !== null && mayControl(control)) {
    nodes.push(...controlPasskeyPart(control.passkey, view.setup, view.passkeys, actions));
    if (control.canDeploy) nodes.push(el("div", { class: "actions" }, button("Deploy or roll back", () => actions.go({ screen: "deploy", connectionId }), { class: "secondary", id: "open-deploy" })));
  }
  nodes.push(...activityPart(status, connectionId, view, openTables, actions), ...healthPart(status.health), ...driftPart(status, connectionId, view, now, actions));
  return nodes;
}

function activityPart(status: LiveStatus, connectionId: number, view: LiveView, openTables: ReadonlySet<string>, actions: Actions): Node[] {
  const nodes: Node[] = [el("h2", { class: "section" }, "Right now")];
  const { activity, activityProblem } = status;
  if (activity === null) return [...nodes, notice(activityProblem === null ? "This database's activity is not showing." : activityProblemText(activityProblem), "bad")];
  nodes.push(
    el(
      "dl",
      { class: "stats" },
      stat("Active", activity.total, "plain"),
      stat("Waiting for a lock", activity.blocked, activity.blocked > 0 ? "bad" : "plain"),
      stat("Idle in a transaction", activity.idleInTransaction, activity.idleInTransaction > 0 ? "warn" : "plain"),
      stat("Long-running", activity.longRunning, activity.longRunning > 0 ? "warn" : "plain"),
    ),
  );
  if (activity.sessions.length === 0) return [...nodes, el("p", { class: "muted" }, "No other session on this server is running a statement right now.")];
  nodes.push(el("p", { class: "hint" }, longRunningText(activity)));
  nodes.push(el("div", { class: "sessions" }, activity.sessions.map((session) => sessionCard(session, connectionId, status.control, view, openTables, actions))));
  const more = moreSessionsText(activity);
  if (more !== null) nodes.push(el("p", { class: "hint" }, more));
  const hint = queryTextHint(activity);
  if (hint !== null) nodes.push(el("p", { class: "hint" }, hint));
  return nodes;
}

function stat(label: string, value: number, tone: Tone): Node {
  return el("div", { class: `stat tone-${tone}` }, el("dt", {}, label), el("dd", {}, String(value)));
}

function toneTag(label: string, tone: Tone): Node {
  return el("span", { class: `tag tone-${tone}` }, label);
}

function sessionCard(session: LiveSession, connectionId: number, control: LiveControl | null, view: LiveView, openTables: ReadonlySet<string>, actions: Actions): Node {
  const time = sessionTimeText(session);
  const transaction = transactionText(session);
  const facts = [session.applicationName, `Process ${session.pid}`].filter((fact) => fact !== null && fact !== "").join(" \u{2022} ");
  const nodes: Child[] = [
    el("div", { class: "session-head" }, toneTag(KIND_LABELS[session.kind], KIND_TONES[session.kind]), time !== null && el("span", { class: "session-time" }, time)),
    el("p", { class: "small muted" }, facts),
    session.waitingOn !== null && el("p", { class: "small" }, `Waiting on ${session.waitingOn}`),
    transaction !== null && el("p", { class: "small muted" }, transaction),
  ];
  if (session.query !== null) {
    // Each screen is built anew at every refresh, so a session keeps its SQL open by its number, as a schema's tables do.
    const key = `live:${connectionId}/${session.pid}`;
    const details = el("details", { class: "session-sql", open: openTables.has(key) }, el("summary", {}, "Show the SQL"), el("pre", { class: "sql" }, showHiddenCharacters(session.query)));
    details.addEventListener("toggle", () => actions.toggleTable(key, details.open));
    nodes.push(details);
  }
  nodes.push(...cancelPart(session, control, view, actions));
  return el("div", { class: "card session" }, nodes);
}

function healthPart(health: LiveHealth | null): Node[] {
  if (health === null) return [];
  return [
    el("h2", { class: "section" }, "Health"),
    el("p", { class: "hint" }, healthSinceText(health)),
    el(
      "div",
      { class: "list" },
      health.metrics.map((metric) =>
        el(
          "div",
          { class: "row live-row" },
          el("span", { class: "row-main" }, el("span", { class: "row-title" }, metric.label), el("span", { class: "small muted" }, metric.note)),
          el("span", { class: "live-value" }, metric.display !== null && el("span", { class: "mono" }, metric.display), toneTag(HEALTH_LABELS[metric.level], HEALTH_TONES[metric.level])),
        ),
      ),
    ),
  ];
}

function driftPart(status: LiveStatus, connectionId: number, view: LiveView, now: number, actions: Actions): Node[] {
  const nodes: Node[] = [el("h2", { class: "section" }, "Drift")];
  const { drift, driftProblem } = status;
  if (drift === null) return [...nodes, notice(driftProblem === null ? "Drift is not showing." : driftProblemText(driftProblem), "bad")];
  if (drift.length === 0) return [...nodes, el("p", { class: "muted" }, "No schema on this connection is tracked for drift yet. Track one in Schema Studio on the computer.")];
  const hint = controlHint(status.control);
  return [
    ...nodes,
    el("div", { class: "list" }, drift.map((each) => driftItem(each, status.control, connectionId, view, now, actions))),
    ...(hint === null ? [] : [el("p", { class: "muted drift-hint" }, hint)]),
  ];
}

/** One tracked schema: how it stands, what this device may do about it, and how the last try went. */
function driftItem(drift: LiveDrift, control: LiveControl | null, connectionId: number, view: LiveView, now: number, actions: Actions): Node {
  const { result } = view.driftActions;
  return el(
    "div",
    { class: "drift-item" },
    driftRow(drift, now),
    view.linked && driftButtons(drift, control, connectionId, view.driftActions, actions),
    result?.id === drift.id && notice(result.text, result.tone),
  );
}

function driftButtons(drift: LiveDrift, control: LiveControl | null, connectionId: number, { running, confirming }: DriftActions, actions: Actions): Node | null {
  const { check, acknowledge } = driftControls(drift, control);
  const { id } = drift;
  if (acknowledge && confirming === id) {
    return el(
      "div",
      { class: "drift-confirm" },
      el("p", {}, ACKNOWLEDGE_QUESTION),
      el(
        "div",
        { class: "actions" },
        button("Acknowledge", () => actions.acknowledgeDrift(connectionId, id), { id: `ack-yes-${id}` }),
        button("Cancel", () => actions.askAcknowledge(null), { class: "secondary" }),
      ),
    );
  }
  if (!check && !acknowledge) return null;
  const doing = running?.id === id ? running.what : null;
  return el(
    "div",
    { class: "actions" },
    check && button(doing === "check" ? "Checking\u{2026}" : "Check now", () => actions.checkDrift(connectionId, id), { class: "secondary", id: `check-drift-${id}`, disabled: running !== null }),
    acknowledge && button(doing === "acknowledge" ? "Acknowledging\u{2026}" : "Acknowledge", () => actions.askAcknowledge(id), { class: "secondary", id: `ack-drift-${id}`, disabled: running !== null }),
  );
}

function driftRow(drift: LiveDrift, now: number): Node {
  const tag = driftTag(drift);
  const checked = driftCheckedText(drift, now);
  return el(
    "div",
    { class: "row live-row" },
    el("span", { class: "row-main" }, el("span", { class: "row-title mono" }, drift.schema), checked !== null && el("span", { class: "small muted" }, checked)),
    el("span", { class: "live-value" }, toneTag(tag.label, tag.tone), drift.acknowledgedAt !== null && el("span", { class: "small muted" }, "Acknowledged")),
  );
}

export function schemaScreen(
  connectionId: number,
  schema: string,
  overview: Load<SchemaOverview> | undefined,
  canCompare: boolean,
  openTables: Set<string>,
  filter: string,
  actions: Actions,
): Node[] {
  const nodes: Node[] = [heading(schema)];
  if (overview === undefined || overview.status === "loading") return [...nodes, loading("Asking the computer for the schema\u{2026}")];
  if (overview.status === "failed") return [...nodes, failed(overview.message, actions.refresh)];
  const { tables, views, database } = overview.value;
  nodes.push(el("p", { class: "lead" }, el("span", { class: "mono" }, database), ` \u{2022} ${countText(tables.length, "table", "tables")}, ${countText(views.length, "view", "views")}`));
  if (canCompare) {
    nodes.push(el("div", { class: "actions" }, button("Compare this schema", () => actions.compareFrom(connectionId, schema), { class: "secondary", id: "compare-schema" })));
  }
  const items: HTMLElement[] = [];
  for (const table of tables) {
    const key = `${connectionId}/${schema}/${table.name}`;
    const details = el(
      "details",
      { class: "card table", open: openTables.has(key), "data-name": table.name.toLowerCase() },
      el("summary", {}, el("span", { class: "mono" }, table.name), el("span", { class: "muted" }, countText(table.columns.length, "column", "columns"))),
      el(
        "ul",
        { class: "columns" },
        table.columns.map((column) =>
          el(
            "li",
            {},
            el("span", { class: "mono" }, column.name),
            el("span", { class: "mono muted" }, column.type),
            !column.nullable && el("span", { class: "tag" }, "not null"),
            table.primaryKey.includes(column.name) && el("span", { class: "tag" }, "primary key"),
            column.default !== null && el("span", { class: "muted mono small" }, `default ${column.default}`),
          ),
        ),
      ),
      table.foreignKeys.length > 0 && el("p", { class: "hint" }, "Foreign keys"),
      table.foreignKeys.map((key) => el("p", { class: "mono small" }, foreignKeyText(key, schema))),
    );
    details.addEventListener("toggle", () => actions.toggleTable(key, details.open));
    items.push(details);
  }
  for (const view of views) {
    items.push(el("div", { class: "card table", "data-name": view.name.toLowerCase() }, el("span", { class: "mono" }, view.name), el("span", { class: "tag" }, view.materialized ? "materialized view" : "view")));
  }
  const input = el("input", { type: "search", id: "filter", placeholder: "Find a table or view", value: filter, "aria-label": "Find a table or view" });
  const apply = (): void => {
    const text = input.value.trim().toLowerCase();
    for (const item of items) item.hidden = text !== "" && !(item.dataset.name ?? "").includes(text);
  };
  input.addEventListener("input", () => {
    actions.setFilter(input.value);
    apply();
  });
  apply();
  return [...nodes, items.length > 0 ? input : notice("This schema has no tables or views.", "info"), el("div", { class: "list" }, items)];
}

export function compareScreen(
  connections: Load<SharedConnection[]>,
  form: CompareForm,
  schemas: Load<string[]> | undefined,
  result: Load<CompareSummary> | null,
  actions: Actions,
): Node[] {
  const nodes: Node[] = [heading("Compare schemas")];
  if (connections.status === "loading") return [...nodes, loading("Asking the computer for its connections\u{2026}")];
  if (connections.status === "failed") return [...nodes, failed(connections.message, actions.refresh)];
  const list = connections.value;
  const source = el("select", { id: "source" }, list.map((c) => el("option", { value: c.id, selected: c.id === form.sourceId }, c.name)));
  source.addEventListener("change", () => actions.setCompare(Number(source.value), form.schema));
  const schemaList = schemas?.status === "loaded" ? schemas.value : [];
  const schema = el("select", { id: "schema", disabled: schemaList.length === 0 }, schemaList.map((s) => el("option", { value: s, selected: s === form.schema }, s)));
  schema.addEventListener("change", () => actions.setCompare(form.sourceId ?? 0, schema.value));
  const full = form.targets.size >= MAX_COMPARE_TARGETS;
  const targets = list
    .filter((c) => c.id !== form.sourceId)
    .map((c) => {
      const box = el("input", { type: "checkbox", id: `target-${c.id}`, checked: form.targets.has(c.id), disabled: full && !form.targets.has(c.id) });
      box.addEventListener("change", () => actions.toggleTarget(c.id, box.checked));
      return el("label", { class: "row", for: `target-${c.id}` }, box, el("span", { class: "row-title" }, c.name), envBadge(c.environment));
    });
  const running = result?.status === "loading";
  nodes.push(
    el(
      "div",
      { class: "card" },
      el("label", { class: "field", for: "source" }, "Source"),
      source,
      el("label", { class: "field", for: "schema" }, "Schema"),
      schemas?.status === "failed" ? notice(schemas.message, "bad") : schema,
      el("p", { class: "field" }, `Compare with (up to ${MAX_COMPARE_TARGETS})`),
      el("div", { class: "list" }, targets),
      el("div", { class: "actions" }, button(running ? "Comparing\u{2026}" : "Compare", actions.runCompare, { class: "primary", id: "run", disabled: running || form.targets.size === 0 || form.schema === "" })),
    ),
  );
  if (result === null || result.status === "loading") return nodes;
  if (result.status === "failed") return [...nodes, notice(result.message, "bad")];
  const summary = result.value;
  if (summary.source.error !== null) nodes.push(notice(summary.source.error, "bad"));
  for (const target of summary.targets) {
    nodes.push(
      el(
        "section",
        { class: "card target" },
        el("h2", { class: "section" }, target.name, " ", envBadge(target.environment)),
        el("p", { class: "lead" }, targetHeadline(target)),
        target.error !== null && el("p", { class: "muted" }, target.error),
        target.breaking + target.manual > 0 &&
          el("p", { class: "muted" }, `${countText(target.breaking, "breaking change", "breaking changes")}, ${countText(target.manual, "to finish by hand", "to finish by hand")}`),
        target.lines.map((line) =>
          el(
            "div",
            { class: `change sev-${line.severity}` },
            el("p", {}, el("strong", {}, CHANGE_LABELS[line.change]), ` ${line.category} `, el("span", { class: "mono" }, line.table === "" ? line.object : `${line.table}.${line.object}`)),
            line.detail !== "" && el("p", { class: "muted small" }, line.detail),
            el("p", { class: "small" }, el("span", { class: "tag" }, SEVERITY_LABELS[line.severity]), line.manual && el("span", { class: "tag" }, "Finish by hand")),
          ),
        ),
        target.moreLines > 0 && el("p", { class: "hint" }, `and ${countText(target.moreLines, "more change", "more changes")}. See them all in Schema Studio on the computer.`),
        target.history !== null && el("p", { class: "hint" }, target.history),
      ),
    );
  }
  return nodes;
}

/** A label and its value, for a list of details such as Settings'. */
function infoRow(label: string, value: Child | Child[], mono = false): HTMLDivElement {
  return el("div", { class: "pair-row" }, el("dt", {}, label), el("dd", { class: mono ? "mono" : null }, value));
}

/** A tappable row that opens a request. */
function requestRow(request: ApprovalSummary, connection: SharedConnection | undefined, actions: Actions): HTMLButtonElement {
  return button(
    [
      el(
        "span",
        { class: "row-main" },
        el("span", { class: "row-title" }, requestTitle(request)),
        el("span", { class: "muted" }, connection === undefined ? request.schemaName : `${request.schemaName} on ${connection.name}`),
        el("span", { class: "muted small" }, requestedText(request)),
      ),
      connection === undefined ? el("span", { class: "tag" }, ACTION_LABELS[request.action]) : envBadge(connection.environment),
    ],
    () => actions.go({ screen: "approval", approvalId: request.id }),
    { class: "row", id: `approval-${request.id}` },
  );
}

/** What the Requests screen says about the phone's passkey, which approving and rejecting need. */
function passkeyPart(passkey: ApprovalList["passkey"], setup: PasskeyStep<"create">, passkeys: boolean, actions: Actions): Node[] {
  switch (passkey) {
    case "ready":
      return [el("p", { class: "hint" }, "Approvals are set up on this device.")];
    case "none":
      return [
        notice(
          "To approve or reject requests from this device, choose Allow approvals for it in Schema Studio's Settings on the computer, under Paired phones. Then set them up here within 5 minutes.",
          "info",
          button("Check again", actions.refresh, { class: "secondary", id: "check-passkey" }),
        ),
      ];
    case "other-person":
      return [
        notice(
          "The person signed in on the computer is not the one who set up approvals on this device. To decide as whoever is signed in now, choose Allow approvals for this device in Schema Studio's Settings on the computer, then set them up here again.",
          "info",
          button("Check again", actions.refresh, { class: "secondary", id: "check-passkey" }),
        ),
      ];
    case "allowed": {
      const ready = setup.prepared?.status === "loaded" && setup.working === null;
      return [
        el(
          "section",
          { class: "card" },
          el("h2", { class: "section" }, "Set up approvals"),
          el(
            "p",
            {},
            "This device makes a passkey for approvals, kept by its password manager. Each decision asks for Face ID, a fingerprint or its screen lock, and the computer checks the passkey before it records anything.",
          ),
          !passkeys &&
            notice("This browser cannot use passkeys, so approvals cannot be set up in it. Try the phone's own browser: Safari on an iPhone, or Chrome on Android.", "bad"),
          setup.problem !== null && notice(setup.problem, "bad"),
          setup.prepared?.status === "failed" && failed(setup.prepared.message, actions.refresh),
          passkeys &&
            el(
              "div",
              { class: "actions" },
              button(setup.working !== null ? "Setting up\u{2026}" : "Set up approvals", actions.setUpPasskey, { class: "primary", id: "set-up", disabled: !ready }),
            ),
        ),
      ];
    }
  }
}

/**
 * The deploy and rollback requests waiting for a decision, on the
 * connections the computer shares with phones. `flash` is what the phone
 * last did, such as approving one, and `passkeys` whether this browser can
 * use passkeys at all.
 */
export function approvalsScreen(
  list: Load<ApprovalList> | undefined,
  connections: Load<SharedConnection[]> | undefined,
  flash: string | null,
  setup: PasskeyStep<"create">,
  passkeys: boolean,
  actions: Actions,
): Node[] {
  const nodes: Node[] = [heading("Requests")];
  if (flash !== null) nodes.push(notice(flash, "info"));
  if (list === undefined || list.status === "loading") return [...nodes, loading("Asking the computer for the requests\u{2026}")];
  if (list.status === "failed") return [...nodes, failed(list.message, actions.refresh)];
  const { approvals, passkey, canApprove } = list.value;
  if (canApprove) nodes.push(...passkeyPart(passkey, setup, passkeys, actions));
  else nodes.push(notice("The role signed in on the computer may not approve or reject requests, so this device can only show them.", "info"));
  if (approvals.length === 0) return [...nodes, notice("No deploy or rollback requests are waiting for a decision.", "info")];
  const known = connections?.status === "loaded" ? connections.value : [];
  return [
    ...nodes,
    el("h2", { class: "section" }, countText(approvals.length, "request waiting", "requests waiting")),
    el(
      "div",
      { class: "list" },
      approvals.map((request) =>
        requestRow(
          request,
          known.find((connection) => connection.id === request.connectionId),
          actions,
        ),
      ),
    ),
  ];
}

/** One migration or rollback script of a request, and its SQL. */
function scriptCard(script: ApprovalScript): HTMLElement {
  return el(
    "section",
    { class: "card script" },
    el("p", { class: "script-name" }, el("span", { class: "tag" }, versionText(script.version)), el("span", { class: "mono" }, script.name)),
    // Focusable, so the SQL can be scrolled sideways from a keyboard too.
    // Characters that do not show on screen are marked, so the SQL read here
    // is the SQL that runs (format.ts, HIDDEN).
    el("pre", { class: "sql", tabindex: 0, "aria-label": `The SQL of ${script.name}` }, showHiddenCharacters(script.sql)),
  );
}

/**
 * One request: what it runs, who asked for it, its SQL, and the decisions
 * the phone may make. `choices` is null while the phone checks that the SQL
 * it was shown is the SQL the request runs.
 */
export function approvalScreen(
  approvalId: number,
  list: Load<ApprovalList> | undefined,
  read: Load<ApprovalRead> | undefined,
  connections: Load<SharedConnection[]> | undefined,
  choices: Choices | null,
  deciding: PasskeyStep<ApprovalDecision>,
  actions: Actions,
): Node[] {
  if (list === undefined || list.status === "loading") return [heading("Request"), loading("Asking the computer for the request\u{2026}")];
  if (list.status === "failed") return [heading("Request"), failed(list.message, actions.refresh)];
  const summary = list.value.approvals.find((request) => request.id === approvalId);
  if (summary === undefined) {
    return [
      heading("Request"),
      notice("That request is no longer waiting for a decision.", "info", button("Back to Requests", () => actions.go({ screen: "approvals" }), { class: "secondary" })),
    ];
  }
  const connection = connections?.status === "loaded" ? connections.value.find((known) => known.id === summary.connectionId) : undefined;
  const askedAt = Date.parse(summary.requestedAt);
  const nodes: Node[] = [
    heading(requestTitle(summary)),
    el(
      "dl",
      { class: "card" },
      infoRow("Kind", ACTION_LABELS[summary.action]),
      infoRow("Script", summary.scriptName, true),
      infoRow("Schema", summary.schemaName, true),
      connection !== undefined
        ? infoRow("Connection", [connection.name, " ", envBadge(connection.environment)])
        : connections?.status === "loaded" && infoRow("Connection", "Not shared with phones"),
      infoRow("Runs", requestSize(summary)),
      infoRow("Asked for by", summary.requestedBy),
      !Number.isNaN(askedAt) && infoRow("Asked on", dayText(askedAt)),
      summary.note !== null && infoRow("Note", summary.note),
    ),
  ];
  if (read === undefined || read.status === "loading") return [...nodes, loading("Asking the computer for the SQL\u{2026}")];
  if (read.status === "failed") return [...nodes, failed(read.message, actions.refresh)];
  const scripts = read.value.scripts;
  if (scripts !== null) {
    nodes.push(el("h2", { class: "section" }, summary.action === "revert" ? "The SQL it runs to roll back" : "The SQL it runs"), ...scripts.map(scriptCard));
  }
  if (choices === null) return [...nodes, loading("Checking the SQL\u{2026}")];
  if (choices.reason !== null) nodes.push(notice(choices.reason, "info"));
  if (!choices.approve && !choices.reject) return nodes;
  if (deciding.problem !== null) nodes.push(notice(deciding.problem, "bad"));
  if (deciding.prepared?.status === "failed") nodes.push(failed(deciding.prepared.message, actions.refresh));
  const ready = deciding.prepared?.status === "loaded" && deciding.working === null;
  nodes.push(
    el(
      "p",
      { class: "hint" },
      "Approving does not run anything: it lets the person who asked run it from the Deploy screen in Schema Studio. Either way, this device asks for Face ID, a fingerprint or its screen lock first.",
    ),
    el(
      "div",
      { class: "actions" },
      choices.approve &&
        button(deciding.working === "approve" ? "Approving\u{2026}" : "Approve", () => actions.decide("approve"), { class: "primary", id: "approve", disabled: !ready }),
      choices.reject &&
        button(deciding.working === "reject" ? "Rejecting\u{2026}" : "Reject", () => actions.decide("reject"), { class: "danger", id: "reject", disabled: !ready }),
    ),
  );
  return nodes;
}

/** The Drift alerts part of Settings. */
function alertsPart(alerts: AlertsView, actions: Actions): Node[] {
  const nodes: Node[] = [
    el("h2", { class: "section" }, "Drift alerts"),
    el(
      "p",
      { class: "hint" },
      "Get an alert on this device when a schema tracked on the computer drifts, for the connections it shares with phones. Schema Studio has to be running on the computer.",
    ),
  ];
  switch (alerts.kind) {
    case "unsupported":
      return [...nodes, notice(alerts.message, "info")];
    case "loading":
      return [...nodes, loading("Asking the computer about drift alerts\u{2026}")];
    case "failed":
      return [...nodes, failed(alerts.message, actions.refresh)];
    case "ready":
      nodes.push(el("p", { id: "alerts-state" }, alerts.on ? "This device gets drift alerts." : "This device does not get drift alerts."));
      if (alerts.problem !== null) nodes.push(notice(alerts.problem, "bad"));
      if (alerts.blocked) {
        return [...nodes, notice("Alerts are blocked for this app in this device's settings. Allow notifications for it there, then try again.", "bad")];
      }
      nodes.push(
        el(
          "div",
          { class: "actions" },
          alerts.on
            ? button(alerts.working ? "Turning off\u{2026}" : "Turn off drift alerts", actions.turnOffAlerts, { class: "secondary", id: "alerts-off", disabled: alerts.working })
            : button(alerts.working ? "Turning on\u{2026}" : "Turn on drift alerts", actions.turnOnAlerts, { class: "primary", id: "alerts-on", disabled: alerts.working }),
        ),
      );
      return nodes;
  }
}

/** Cancel query, with its question. The computer asks for the passkey and decides again. */
function cancelPart(session: LiveSession, control: LiveControl | null, view: LiveView, actions: Actions): Node[] {
  if (!view.linked || control?.passkey !== "ready" || !mayCancel(session, control)) return [];
  const { cancelling } = view;
  const id = session.pid;
  if (cancelling.pid !== id) return [el("div", { class: "actions" }, button("Cancel query", () => actions.askCancel(session), { class: "secondary", id: `cancel-${id}` }))];
  const ready = cancelling.prepared?.status === "loaded" && cancelling.working === null;
  return [
    el("div", { class: "drift-confirm" }, el("p", {}, CANCEL_QUESTION),
      cancelling.prepared?.status === "failed" && failed(cancelling.prepared.message, () => actions.askCancel(session)),
      el("div", { class: "actions" },
        button(cancelling.working !== null ? "Cancelling\u{2026}" : "Cancel query", actions.cancelQuery, { class: "danger", id: `cancel-yes-${id}`, disabled: !ready }),
        button("Keep it running", () => actions.askCancel(null), { class: "secondary", id: `cancel-no-${id}`, disabled: cancelling.working !== null }),
      )),
  ];
}

/**
 * The passkey for the buttons that change something. Approvals have their own
 * (passkeyPart), since someone who may approve but not deploy should not read
 * about deploys.
 */
function controlPasskeyPart(passkey: PasskeyState, setup: PasskeyStep<"create">, passkeys: boolean, actions: Actions): Node[] {
  if (passkey === "ready") return [];
  const text = passkeyText(passkey);
  if (text !== null) return [notice(text, "info", button("Check again", actions.refresh, { class: "secondary", id: "check-passkey" }))];
  const ready = setup.prepared?.status === "loaded" && setup.working === null;
  return [
    el("section", { class: "card" },
      el("h2", { class: "section" }, "Set up a passkey"),
      el("p", {}, "This device makes a passkey for Schema Studio, kept by its password manager. Each action asks for Face ID, a fingerprint or its screen lock, and the computer checks the passkey before it does anything."),
      !passkeys && notice("This browser cannot use passkeys, so this cannot be set up in it. Try the phone's own browser: Safari on an iPhone, or Chrome on Android.", "bad"),
      setup.problem !== null && notice(setup.problem, "bad"),
      setup.prepared?.status === "failed" && failed(setup.prepared.message, actions.refresh),
      passkeys && el("div", { class: "actions" },
        button(setup.working !== null ? "Setting up\u{2026}" : "Set up passkey", actions.setUpPasskey, { class: "primary", id: "set-up", disabled: !ready })),
    ),
  ];
}

/** The scripts that could run on a connection, under each schema. */
export function deployScreen(connection: SharedConnection | null, connectionId: number, list: Load<DeployList> | undefined, setup: PasskeyStep<"create">, passkeys: boolean, actions: Actions): Node[] {
  const nodes: Node[] = [heading("Deploy or roll back")];
  if (connection !== null) nodes.push(el("p", { class: "lead" }, envBadge(connection.environment), ` ${connection.name}`));
  if (list === undefined || list.status === "loading") return [...nodes, loading("Asking the computer for its scripts\u{2026}")];
  if (list.status === "failed") return [...nodes, failed(list.message, actions.refresh)];
  const { registry, partial, families, passkey } = list.value;
  nodes.push(...controlPasskeyPart(passkey, setup, passkeys, actions));
  const problem = registryText(registry);
  if (problem !== null) return [...nodes, notice(problem, "info", button("Check again", actions.refresh, { class: "secondary", id: "check-registry" }))];
  if (partial) nodes.push(notice(PARTIAL_TEXT, "info"));
  if (families.length === 0) return [...nodes, el("p", { class: "muted" }, NO_FAMILIES_TEXT)];
  for (const schema of new Set(families.map((family) => family.schemaName))) {
    const rows = families.flatMap((family, index) =>
      family.schemaName !== schema
        ? []
        : [button(
            el("span", { class: "row-main" }, el("span", { class: "row-title mono" }, family.scriptName), el("span", { class: "small muted" }, `Newest ${versionText(family.newestVersion)}`)),
            () => actions.go({ screen: "deploy-family", connectionId, schema, script: family.scriptName }),
            { class: "row", id: `family-${index}` },
          )],
    );
    nodes.push(el("h2", { class: "section mono" }, schema), el("div", { class: "list" }, rows));
  }
  return nodes;
}

/** Where one script stands, and the runs on offer from there. */
export function deployFamilyScreen(route: Extract<Route, { screen: "deploy-family" }>, status: Load<DeployFamilyStatus> | undefined, now: number, actions: Actions): Node[] {
  const { connectionId, schema, script } = route;
  const nodes: Node[] = [heading(script), el("p", { class: "hint mono" }, schema)];
  if (status === undefined || status.status === "loading") return [...nodes, loading("Asking the computer where this script stands\u{2026}")];
  if (status.status === "failed") return [...nodes, failed(status.message, actions.refresh)];
  const { waiting, undo, partial, run } = status.value;
  nodes.push(el("p", { class: "lead" }, whereText(status.value)));
  if (partial) nodes.push(notice(PARTIAL_TEXT, "info"));
  if (run !== null) nodes.push(notice(runText(run, now), run.state === "not-applied" || run.state === "unknown" ? "bad" : "info"));
  // The computer refuses a second run of a script while one is going, so none is offered.
  if (run?.state === "running") return [...nodes, el("div", { class: "actions" }, button("Check again", actions.refresh, { class: "secondary", id: "check-run" }))];
  if (waiting.length === 0 && undo.length === 0) nodes.push(el("p", { class: "muted" }, "There is nothing to deploy or roll back on this script."));
  if (waiting.length > 0) {
    nodes.push(el("h2", { class: "section" }, "Deploy"), el("div", { class: "list" }, waiting.map((version, index) =>
      button(el("span", { class: "row-title" }, deployButtonText(version)), () => actions.go({ screen: "deploy-plan", connectionId, schema, script, action: "deploy", version }), { class: "row", id: `deploy-${index}` }))));
  }
  if (undo.length > 0) {
    nodes.push(el("h2", { class: "section" }, "Roll back"), el("div", { class: "list" }, undo.map((choice, index) =>
      button(el("span", { class: "row-title" }, rollbackButtonText(choice)), () => actions.go({ screen: "deploy-plan", connectionId, schema, script, action: "revert", version: choice.target }), { class: "row", id: `undo-${index}` }))));
  }
  return nodes;
}

function riskRow(row: RiskRow, canTick: boolean, ticked: ReadonlySet<ControlTick>, actions: Actions): Node {
  const body = el("span", { class: "row-main" }, el("span", {}, row.text), row.labels.map((label) => el("span", { class: "small mono risk-label" }, label)));
  if (!canTick) return el("div", { class: "row" }, body);
  const box = el("input", { type: "checkbox", id: `risk-${row.tick}`, checked: ticked.has(row.tick) });
  box.addEventListener("change", () => actions.toggleTick(row.tick, box.checked));
  return el("label", { class: "row", for: `risk-${row.tick}` }, box, body);
}

/** One run: what it would do, what it risks, and the passkey button for its next step. */
export function deployPlanScreen(route: Extract<Route, { screen: "deploy-plan" }>, connection: SharedConnection | null, view: PlanView, actions: Actions): Node[] {
  const { connectionId, schema, script, action, version } = route;
  const load = view.plan;
  const environment = load?.status === "loaded" ? load.value.environment : connection?.environment ?? null;
  const nodes: Node[] = [
    heading(planTitle(action, version)),
    el("dl", { class: "card" },
      infoRow("Script", script, true),
      infoRow("Schema", schema, true),
      infoRow("Connection", [connection?.name ?? "", " ", environment !== null && envBadge(environment)]),
    ),
  ];
  const { starting } = view;
  if (starting.result !== null) {
    return [...nodes,
      notice(startStatusText(starting.result, action), startStatusTone(starting.result)),
      el("div", { class: "actions" }, button("Back to this script", () => actions.go({ screen: "deploy-family", connectionId, schema, script }), { class: "primary", id: "back-to-family" })),
    ];
  }
  if (load === undefined || load.status === "loading") return [...nodes, loading("Asking the computer for the SQL\u{2026}")];
  if (load.status === "failed") return [...nodes, failed(load.message, actions.refresh)];
  const plan = load.value;
  const label = stepButton(plan.next, plan.action);
  nodes.push(...controlPasskeyPart(plan.passkey, view.setup, view.passkeys, actions));
  if (label === null) nodes.push(notice(stepText(plan), "info"));
  if (plan.partial) nodes.push(notice(PARTIAL_TEXT, "info"));
  const rows = riskRows(plan.risks);
  const canTick = stepOf(plan.next) === "run";
  if (rows.length > 0) nodes.push(el("h2", { class: "section" }, canTick ? "Tick each one to go on" : "What this run risks"), el("div", { class: "list" }, rows.map((row) => riskRow(row, canTick, view.ticked, actions))));
  nodes.push(el("h2", { class: "section" }, plan.action === "revert" ? "The SQL it runs to roll back" : "The SQL it runs"), ...plan.scripts.map(scriptCard));
  // No step to take, or no passkey to take it with: what is above says why.
  if (label === null || plan.passkey !== "ready") return nodes;
  if (view.hash !== undefined && view.hash !== plan.fingerprint) return [...nodes, notice(MISMATCH_TEXT, "bad")];
  // The fingerprint covers characters that do not show, so signing would
  // accept SQL other than what the person read: no button for it.
  if (hidesCharacters(plan)) return [...nodes, notice(HIDDEN_TEXT, "bad")];
  if (starting.problem !== null) nodes.push(notice(starting.problem, "bad"));
  if (starting.prepared?.status === "failed") nodes.push(failed(starting.prepared.message, actions.refresh));
  const ready = starting.prepared?.status === "loaded" && starting.working === null && allTicked(plan, view.ticked);
  nodes.push(
    el("p", { class: "hint" }, stepText(plan)),
    el("div", { class: "actions" }, button(starting.working !== null ? "Starting\u{2026}" : label, actions.startRun, { class: "primary", id: "start-run", disabled: !ready })),
  );
  return nodes;
}

export function settingsScreen(paired: PairedComputer, hello: HelloResult | null, alerts: AlertsView, forgetting: boolean, actions: Actions): Node[] {
  return [
    heading("Settings"),
    el(
      "dl",
      { class: "card" },
      infoRow("This device", paired.phoneName),
      infoRow("Computer", paired.computerName),
      infoRow("Paired", `Paired on ${dayText(paired.pairedAt)}`),
      infoRow("Relay", new URL(paired.relayOrigin).host, true),
      infoRow("App version", BUILD_VERSION, true),
      infoRow("Schema Studio version", hello?.appVersion ?? "Not known until the computer answers", hello !== null),
    ),
    ...alertsPart(alerts, actions),
    el("h2", { class: "section" }, "Pairing"),
    el(
      "div",
      { class: "actions" },
      button("Scan a new pairing code", actions.openScan, { class: "secondary", id: "scan-new" }),
      button("Enter a pairing code", actions.openCode, { class: "secondary", id: "code-new" }),
    ),
    forgetting
      ? notice(
          `Forget ${paired.computerName}? The computer keeps this device in its list until you remove it there, under Paired phones.`,
          "bad",
          el("div", { class: "actions" }, button("Forget", actions.forget, { class: "danger", id: "forget-yes" }), button("Cancel", () => actions.askForget(false), { class: "secondary" })),
        )
      : el("div", { class: "actions" }, button("Forget this computer", () => actions.askForget(true), { class: "danger", id: "forget" })),
  ];
}
