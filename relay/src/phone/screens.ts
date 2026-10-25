/**
 * The phone app's screens, built from what main.ts knows. Each one is a
 * list of elements for the main part of the page; what the buttons do is
 * main.ts's, through Actions.
 */
import { ACTION_LABELS, requestedText, requestSize, requestTitle, versionText, type Choices } from "./approvals.js";
import { BUILD_VERSION } from "./build-info.js";
import { button, el, envBadge, failed, heading, loading, notice, type Child } from "./dom.js";
import { accessProblem, CHANGE_LABELS, countText, dayText, foreignKeyText, SEVERITY_LABELS, targetHeadline } from "./format.js";
import type { Route } from "./routes.js";
import type { PairedComputer } from "./store.js";
import type { ApprovalDecision, ApprovalScript } from "../shared/remote/approval.js";
import { MAX_COMPARE_TARGETS } from "../shared/remote/rpc.js";
import type { ApprovalList, ApprovalRead, ApprovalSummary, CompareSummary, HelloResult, SchemaOverview, SharedConnection } from "../shared/remote/rpc.js";

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
};

/** The Scan screen's parts that change while it shows. */
export type ScanUi = { video: HTMLVideoElement; message: HTMLParagraphElement; retry: HTMLButtonElement };

/** What shows when the app cannot run, or cannot use its storage. */
export function blockedScreen(message: string, canReload: boolean, actions: Actions): Node[] {
  return [heading("The phone app cannot open"), notice(message, "bad", canReload && button("Reload", actions.reload, { class: "secondary" }))];
}

export function pairScreen(alert: string | null, iosTip: boolean, actions: Actions): Node[] {
  return [
    heading("Pair with a computer"),
    alert !== null && notice(alert, "bad"),
    el("p", { class: "lead" }, "See the schemas on a computer running Schema Studio from this phone, and compare them, wherever you are."),
    el(
      "ol",
      { class: "steps" },
      el("li", {}, "On the computer, open Schema Studio and go to Settings."),
      el("li", {}, "Under Phone, turn on Let paired phones connect, then choose Show a code."),
      el("li", {}, "Scan the code with this phone."),
    ),
    el("div", { class: "actions" }, button("Scan the code", actions.openScan, { class: "primary" })),
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
 * new picture of the screen keeps it.
 */
export function confirmScreen(name: string, problem: string | null, pairing: boolean, status: string | null, replaces: string | null, actions: Actions): Node[] {
  const input = el("input", { id: "phone-name", type: "text", maxlength: 64, autocomplete: "off", value: name, disabled: pairing });
  input.addEventListener("input", () => actions.setName(input.value));
  const form = el(
    "form",
    { class: "card" },
    el("label", { class: "field", for: "phone-name" }, "Name this phone"),
    input,
    el("p", { class: "hint" }, "The computer lists this phone under this name in Settings, under Paired phones."),
    replaces !== null && el("p", { class: "hint" }, `This phone is paired with ${replaces}. Pairing with this code replaces that pairing.`),
    status !== null && el("p", { class: "hint", role: "status" }, status),
    el(
      "div",
      { class: "actions" },
      problem === null
        ? el("button", { type: "submit", class: "primary", id: "pair", disabled: pairing }, pairing ? "Pairing\u{2026}" : "Pair")
        : button("Scan a new code", actions.openScan, { class: "primary", id: "scan-again" }),
      button("Cancel", actions.cancelPairing, { class: "secondary", id: "cancel" }),
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    actions.pair(input.value);
  });
  return [heading("Pair this phone"), problem !== null ? notice(problem, "bad") : el("span", {}), form];
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

export function connectionScreen(connection: SharedConnection | null, schemas: Load<string[]> | undefined, actions: Actions, connectionId: number): Node[] {
  const nodes: Node[] = [heading(connection?.name ?? "Connection")];
  if (connection !== null) nodes.push(el("p", { class: "lead" }, envBadge(connection.environment), " ", el("span", { class: "mono" }, connection.database)));
  if (schemas === undefined || schemas.status === "loading") return [...nodes, loading("Asking the computer for the schemas\u{2026}")];
  if (schemas.status === "failed") return [...nodes, failed(schemas.message, actions.refresh)];
  if (schemas.value.length === 0) return [...nodes, notice("This database has no schemas the phone can show.", "info")];
  const rows = schemas.value.map((schema) =>
    button(el("span", { class: "row-title mono" }, schema), () => actions.go({ screen: "schema", connectionId, schema }), { class: "row", id: `schema-${schema}` }),
  );
  return [...nodes, el("h2", { class: "section" }, countText(schemas.value.length, "schema", "schemas")), el("div", { class: "list" }, rows)];
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
      return [el("p", { class: "hint" }, "Approvals are set up on this phone.")];
    case "none":
      return [
        notice(
          "To approve or reject requests from this phone, choose Allow approvals for it in Schema Studio's Settings on the computer, under Paired phones. Then set them up here within 5 minutes.",
          "info",
          button("Check again", actions.refresh, { class: "secondary", id: "check-passkey" }),
        ),
      ];
    case "other-person":
      return [
        notice(
          "The person signed in on the computer is not the one who set up approvals on this phone. To decide as whoever is signed in now, choose Allow approvals for this phone in Schema Studio's Settings on the computer, then set them up here again.",
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
            "This phone makes a passkey for approvals, kept by its password manager. Each decision asks for Face ID, a fingerprint or the phone's screen lock, and the computer checks the passkey before it records anything.",
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
  else nodes.push(notice("The role signed in on the computer may not approve or reject requests, so this phone can only show them.", "info"));
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
    el("pre", { class: "sql", tabindex: 0, "aria-label": `The SQL of ${script.name}` }, script.sql),
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
      "Approving does not run anything: it lets the person who asked run it from the Deploy screen in Schema Studio. Either way, the phone asks for Face ID, a fingerprint or its screen lock first.",
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
      "Get an alert on this phone when a schema tracked on the computer drifts, for the connections it shares with phones. Schema Studio has to be running on the computer.",
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
      nodes.push(el("p", { id: "alerts-state" }, alerts.on ? "This phone gets drift alerts." : "This phone does not get drift alerts."));
      if (alerts.problem !== null) nodes.push(notice(alerts.problem, "bad"));
      if (alerts.blocked) {
        return [...nodes, notice("Alerts are blocked for this app in the phone's settings. Allow notifications for it there, then try again.", "bad")];
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

export function settingsScreen(paired: PairedComputer, hello: HelloResult | null, alerts: AlertsView, forgetting: boolean, actions: Actions): Node[] {
  return [
    heading("Settings"),
    el(
      "dl",
      { class: "card" },
      infoRow("This phone", paired.phoneName),
      infoRow("Computer", paired.computerName),
      infoRow("Paired", `Paired on ${dayText(paired.pairedAt)}`),
      infoRow("Relay", new URL(paired.relayOrigin).host, true),
      infoRow("Phone app version", BUILD_VERSION, true),
      infoRow("Schema Studio version", hello?.appVersion ?? "Not known until the computer answers", hello !== null),
    ),
    ...alertsPart(alerts, actions),
    el("h2", { class: "section" }, "Pairing"),
    el("div", { class: "actions" }, button("Scan a new pairing code", actions.openScan, { class: "secondary", id: "scan-new" })),
    forgetting
      ? notice(
          `Forget ${paired.computerName}? The computer keeps this phone in its list until you remove it there, under Paired phones.`,
          "bad",
          el("div", { class: "actions" }, button("Forget", actions.forget, { class: "danger", id: "forget-yes" }), button("Cancel", () => actions.askForget(false), { class: "secondary" })),
        )
      : el("div", { class: "actions" }, button("Forget this computer", () => actions.askForget(true), { class: "danger", id: "forget" })),
  ];
}
