/**
 * The phone app itself: what it remembers, what it asks the computer, and
 * which screen it shows.
 *
 * It remembers one thing, the computer it is paired with (idb-store.ts), and
 * keeps everything else in memory only, for as long as the page is open.
 * Everything it shows comes from the computer, over the phone link
 * (connection.ts), sealed so that the relay passing the messages on cannot
 * read them. The page talks to nothing else: its Content-Security-Policy
 * (public/_headers) lets it connect only to the relay it came from. Drift
 * alerts come through the browser's own push service, which the browser
 * talks to, not the page.
 *
 * The screens are built in screens.ts. This file decides which one shows,
 * with what, and what each button does.
 */
import { DECIDED_TEXT, decisionChoices, passkeyErrorText, type Choices } from "./approvals.js";
import { PhoneConnection, RpcError, type ConnectionState, type EndReason, type RpcErrorCode } from "./connection.js";
import { append, button, el, notice } from "./dom.js";
import { defaultPhoneName, retryText } from "./format.js";
import { forgetPairedComputer, loadPairedComputer, savePairedComputer } from "./idb-store.js";
import { HOME, parentOf, readRoute, writeRoute, type Route } from "./routes.js";
import { readAddressPairing, readScannedText } from "./scan.js";
import { startScanner } from "./scanner.js";
import {
  approvalScreen, approvalsScreen, blockedScreen, compareScreen, confirmScreen, connectionScreen, homeScreen,
  pairScreen, scanScreen, schemaScreen, settingsScreen,
  type Actions, type AlertsView, type CompareForm, type Load, type ScanUi,
} from "./screens.js";
import type { PairedComputer } from "./store.js";
import { approvalChallenge, approvalFingerprint, type ApprovalDecision } from "../shared/remote/approval.js";
import { fromBase64Url, sameBytes, toBase64Url, type Bytes } from "../shared/remote/bytes.js";
import { generateKeyPair, type KeyPair } from "../shared/remote/keys.js";
import { cleanDeviceName, PAIRING_LIFETIME_MS, type PairingCode } from "../shared/remote/pairing.js";
import { MAX_COMPARE_TARGETS } from "../shared/remote/rpc.js";
import type { ApprovalList, ApprovalRead, CompareSummary, HelloResult, PasskeyChallenge, PushStatus, SharedConnection } from "../shared/remote/rpc.js";

/** How long the phone waits for its offline helper (sw.ts) to start before it gives up on drift alerts for now. */
const HELPER_WITHIN_MS = 10_000;
/** How long the phone gives the computer to say it has let go of a push subscription, so that a slow computer does not hold up the screen. */
const LET_GO_WITHIN_MS = 3_000;
/** The computer takes a decision's challenge for 5 minutes (desktop/src/main/phone-approvals.ts), so the phone asks for a fresh one a minute before then. */
const CHALLENGE_FOR_MS = 4 * 60_000;
/** After the app was out of sight this long, what it shows is asked for again as it comes back. */
const STALE_AFTER_MS = 30_000;
/** How long a passkey prompt may stay open. */
const PASSKEY_WITHIN_MS = 120_000;

const SOMETHING_WRONG = "Something went wrong on this phone. Reload the page, then try again.";
const WAITING_TEXT = "Waiting for the computer. Schema Studio has to be running on it, with Let paired phones connect turned on.";
const UNREADABLE_CHALLENGE = "The phone could not read what the computer sent for the passkey. Update Schema Studio on the computer, then try again.";
/** Refusals that mean what Requests said about this phone's passkey is out of date, so the list is asked for again. */
const PASSKEY_GONE = new Set<RpcErrorCode>(["no-passkey", "other-person", "not-allowed", "forbidden"]);
/** A load that has not finished yet. */
const LOADING: Load<never> = { status: "loading" };

/** A problem this file found itself, with a sentence for the person holding the phone. */
class Problem extends Error {}

function part<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`The page has no #${id}.`);
  return element as T;
}
const app = part<HTMLElement>("app");
const statusBar = part<HTMLElement>("status");
const tabBar = part<HTMLElement>("tabs");
const backButton = part<HTMLButtonElement>("back");

type Entry = { load: Load<unknown>; generation: number };   // generation -1 = ask again
type Session = { paired: PairedComputer; link: PhoneConnection; state: ConnectionState; generation: number; answers: Map<string, Entry>; asking: Map<string, object> };
type Pending = { code: PairingCode; scannedAt: number; name: string; problem: string | null; pairing: boolean; connection: PhoneConnection | null };
type DecisionKeys = { credentialId: Bytes; fingerprint: string; challenges: Record<ApprovalDecision, Bytes> };
type AlertsSetup = { registration: ServiceWorkerRegistration; key: Bytes; status: PushStatus; subscription: PushSubscription | null };
type StatusLine = { key: string; text: string; time: string | null; action: { label: string; run: () => void } | null };
type Focus = { id: string; start: number | null; end: number | null };

let session: Session | null = null;
let pending: Pending | null = null;
let blocked: { message: string; canReload: boolean } | null = null;
let pairAlert: string | null = null;
let route: Route = HOME;
let depth = 0;
let compareForm: CompareForm = { sourceId: null, schema: "", targets: new Set() };
let compareResult: Load<CompareSummary> | null = null;
let compareToken = 0;
let openTables = new Set<string>();
let filter = "";
let setup: { prepared: Load<PasskeyChallenge> | null; working: "create" | null; problem: string | null } = { prepared: null, working: null, problem: null };
let setupToken = 0;
let deciding: { prepared: Load<DecisionKeys> | null; working: ApprovalDecision | null; problem: string | null } = { prepared: null, working: null, problem: null };
let decidingToken = 0;
let decidingTimer: number | undefined;
let alerts: { prepared: Load<AlertsSetup> | null; working: boolean; problem: string | null } = { prepared: null, working: false, problem: null };
let alertsToken = 0;
let flash: string | null = null;
let forgetting = false;
let forgetBusy = false;
const fingerprints = new WeakMap<ApprovalRead, string | null>();
const fingerprinting = new WeakSet<ApprovalRead>();
let scanUi: ScanUi | null = null;
let stopScanning: (() => void) | null = null;
let shownKey: string | null = null;
let statusKey: string | null = null;
let statusTime: Text | null = null;
let tabsKey: string | null = null;
let hiddenAt: number | null = null;

const actions: Actions = {
  go, openScan,
  restartScan: () => { if (scanUi !== null) startScan(scanUi); },
  setName: (name) => { if (pending !== null) pending.name = name; },
  pair: (name) => void pair(name),
  cancelPairing,
  checkAgain: () => { drop("hello"); drop("connections"); drop("approvals"); render(); },
  refresh, compareFrom, setCompare, toggleTarget,
  runCompare: () => void runCompare(),
  toggleTable: (key, open) => { if (open) openTables.add(key); else openTables.delete(key); },
  setFilter: (text) => { filter = text; },
  askForget: (on) => { forgetting = on; render(); },
  forget: () => void forget(),
  reload: () => location.reload(),
  setUpPasskey: () => void setUpPasskey(),
  decide: (decision) => void decide(decision),
  turnOnAlerts: () => void turnOnAlerts(),
  turnOffAlerts: () => void turnOffAlerts(),
};

/** The sentence to show for something that went wrong. Only this app's own words are shown, never a browser's, which are written for developers. */
function errorText(error: unknown): string {
  return error instanceof RpcError || error instanceof Problem ? error.message : SOMETHING_WRONG;
}

/** What a load holds once it has loaded, or null before then and after it failed. */
function value<T>(load: Load<T> | undefined | null): T | null {
  return load !== undefined && load !== null && load.status === "loaded" ? load.value : null;
}

/** `promise`, or a Problem saying `message` once it has taken longer than `ms`. */
function withinTime<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: number | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Problem(message)), ms);
  });
  return Promise.race([promise, late]).finally(() => window.clearTimeout(timer));
}

/** What the phone calls itself until the person names it: "iPhone", "Android phone" and so on. */
function phoneKind(): string {
  return defaultPhoneName(navigator.userAgent, navigator.maxTouchPoints);
}

/** A session with the paired computer over `link`, which has asked it nothing yet. */
function newSession(paired: PairedComputer, link: PhoneConnection): Session {
  return { paired, link, state: link.state, generation: 0, answers: new Map(), asking: new Map() };
}

/** Starts the link to the computer this phone is paired with. */
function startSession(paired: PairedComputer): void {
  let link: PhoneConnection;
  try {
    link = new PhoneConnection({
      relayOrigin: paired.relayOrigin,
      desktopId: paired.desktopId,
      desktopKey: paired.desktopKey,
      staticKey: paired.phoneKey,
      onState: (state) => onLinkState(link, state),
    });
  } catch {
    // The saved pairing was checked as it was read (store.ts), so this should
    // not happen. If it does, pairing again is the way out.
    session = null;
    pairAlert = "This phone's saved pairing could not be used. Pair it again.";
    return;
  }
  // Set before start(), which can already say how the link is doing.
  session = newSession(paired, link);
  link.start();
}

/**
 * Follows a link as it connects, drops and comes back. Every time the link
 * to the paired computer opens again, what the screens show is asked for
 * again, since anything could have changed on the computer in between.
 */
function onLinkState(link: PhoneConnection, state: ConnectionState): void {
  const current = session;
  if (current !== null && current.link === link) {
    current.state = state;
    if (state.kind !== "ready") {
      renderStatus();
      return;
    }
    current.generation += 1;
    if (state.computerName !== current.paired.computerName) {
      current.paired = { ...current.paired, computerName: state.computerName };
      // Only the name the phone shows depends on this, and the computer sends
      // it again every time the link opens, so a failed save does no harm.
      savePairedComputer(current.paired).catch(() => {});
    }
    render();
    return;
  }
  if (pending !== null && pending.connection === link && state.kind !== "off") {
    if (state.kind === "ended") {
      pending.pairing = false;
      pending.connection = null;
      pending.problem = state.message;
    }
    render();
  }
}

/**
 * What the computer answered for `key`, asking for it when the phone has no
 * answer yet, or only one from before the link last opened. Called while a
 * screen is built, so each screen asks for what it shows, and only that.
 * Undefined when no computer is paired.
 */
function need<T>(key: string, ask: (link: PhoneConnection) => Promise<T>): Load<T> | undefined {
  const owner = session;
  if (owner === null) return undefined;
  const entry = owner.answers.get(key);
  if (entry === undefined) owner.answers.set(key, { load: LOADING, generation: owner.generation });
  if ((entry === undefined || entry.generation < owner.generation) && !owner.asking.has(key)) {
    // drop() forgets the ticket, so an answer that was on its way when the
    // screen asked again is not shown over the newer one.
    const ticket = {};
    owner.asking.set(key, ticket);
    const answered = (load: Load<T> | null): void => {
      if (owner.asking.get(key) !== ticket) return;
      owner.asking.delete(key);
      if (load === null) {
        // The link dropped before the computer answered. What the screen
        // showed stays, marked to be asked for again once the link is back.
        const old = owner.answers.get(key);
        if (old !== undefined) old.generation = -1;
      } else owner.answers.set(key, { load, generation: owner.generation });
      if (session === owner) render();
    };
    new Promise<T>((resolve) => resolve(ask(owner.link))).then(
      (result) => answered({ status: "loaded", value: result }),
      (error: unknown) => answered(error instanceof RpcError && error.code === "lost" ? null : { status: "failed", message: errorText(error) }),
    );
  }
  return owner.answers.get(key)?.load as Load<T> | undefined;
}

/** Forgets the computer's answer for `key`, and any answer still on its way, so that the screen asks for it again. */
function drop(key: string): void {
  session?.answers.delete(key);
  session?.asking.delete(key);
}

/** Who is signed in on the computer, and what they may do. */
function helloLoad(): Load<HelloResult> | undefined {
  return need("hello", (link) => link.request({ method: "hello" }));
}

/** The connections the computer shares with phones. */
function connectionsLoad(): Load<SharedConnection[]> | undefined {
  return need("connections", (link) => link.request({ method: "connections.list" }).then((answer) => answer.connections));
}

/** The schemas in one shared connection's database. */
function schemasLoad(connectionId: number): Load<string[]> | undefined {
  return need(`schemas:${connectionId}`, (link) => link.request({ method: "schemas.list", params: { connectionId } }).then((answer) => answer.schemas));
}

/** The deploy and rollback requests waiting for a decision, and whether this phone may decide them. */
function approvalsLoad(): Load<ApprovalList> | undefined {
  return need("approvals", (link) => link.request({ method: "approvals.list" }));
}

/** Holds a pairing code the phone just read, for the person to confirm with a name for the phone. */
function startPending(code: PairingCode): void {
  dropPending();
  pending = { code, scannedAt: Date.now(), name: session?.paired.phoneName ?? phoneKind(), problem: null, pairing: false, connection: null };
  pairAlert = null;
}

/** Puts aside a pairing code the phone read, stopping its pairing if one is under way. */
function dropPending(): void {
  const current = pending;
  pending = null;
  current?.connection?.stop();
}

/** Pairs with the computer whose code the phone read, under the name the person chose for the phone. */
async function pair(typed: string): Promise<void> {
  const current = pending;
  if (current === null || current.pairing) return;
  const name = cleanDeviceName(typed, phoneKind());
  current.name = name;
  current.pairing = true;
  current.problem = null;
  render();
  let staticKey: KeyPair;
  try {
    // The phone's own key for the link. The browser keeps it so that it can
    // only be used, never read out, not even by this page.
    staticKey = await generateKeyPair("X25519", false);
  } catch {
    if (pending === current) {
      current.pairing = false;
      current.problem = "This phone could not make a key for the pairing. Reload the page, then scan the code again.";
      render();
    }
    return;
  }
  if (pending !== current) return;
  const code = current.code;
  let connection: PhoneConnection;
  try {
    connection = new PhoneConnection({
      relayOrigin: location.origin,
      desktopId: code.desktopId,
      desktopKey: code.desktopKey,
      staticKey,
      pairing: { secret: code.secret, name, until: current.scannedAt + PAIRING_LIFETIME_MS },
      onPaired: (computerName) => onPaired(current, connection, staticKey, name, computerName),
      onState: (state) => onLinkState(connection, state),
    });
  } catch {
    current.pairing = false;
    current.problem = "That pairing code could not be read. Make a new one in Settings on the computer, then scan it.";
    render();
    return;
  }
  // Set before start(), which ends the pairing at once, and says so, when the code has already run out.
  current.connection = connection;
  connection.start();
}

/**
 * Saves the pairing once the computer has taken it, before the link counts
 * as open, so that a phone that could not save it never looks paired. A
 * throw here ends the link, and the confirm screen says why.
 */
async function onPaired(current: Pending, connection: PhoneConnection, phoneKey: KeyPair, phoneName: string, computerName: string): Promise<void> {
  if (pending !== current || current.connection !== connection) throw new Error("The pairing was cancelled.");
  const record: PairedComputer = {
    version: 1,
    relayOrigin: location.origin,
    desktopId: current.code.desktopId,
    desktopKey: current.code.desktopKey,
    computerName,
    phoneName,
    pairedAt: Date.now(),
    phoneKey,
  };
  await savePairedComputer(record);
  // The computer took the pairing and the phone saved it, so the phone is
  // paired even when the person cancelled while it was being saved. Then it
  // starts a link of its own, since the pairing's link was stopped.
  const kept = pending === current;
  if (kept) pending = null;
  adopt(record, kept ? connection : null);
}

/** Makes `record` the computer this phone is paired with, in place of any other, and shows its home screen. */
function adopt(record: PairedComputer, connection: PhoneConnection | null): void {
  const old = session;
  pairAlert = null;
  resetScreens();
  if (connection === null) startSession(record);
  else session = newSession(record, connection);
  old?.link.stop();
  // Drift alerts this browser gets come from the computer it was paired with
  // before, which now has no way to be told to stop sending them.
  if (old !== null) void dropBrowserPush();
  replace(HOME);
}

/** Forgets what the screens were in the middle of, as when the phone pairs with another computer or forgets this one. */
function resetScreens(): void {
  compareForm = { sourceId: null, schema: "", targets: new Set() };
  compareResult = null;
  compareToken += 1;
  openTables = new Set();
  filter = "";
  setup = { prepared: null, working: null, problem: null };
  setupToken += 1;
  resetDeciding();
  alerts = { prepared: null, working: false, problem: null };
  alertsToken += 1;
  flash = null;
  forgetting = false;
}

/** Puts the code the phone read aside without pairing. */
function cancelPairing(): void {
  dropPending();
  render();
}

/** Opens the camera to read a pairing code, putting aside one the phone read before. */
function openScan(): void {
  dropPending();
  pairAlert = null;
  go({ screen: "scan" });
}

/** What the confirm screen says about a pairing under way, or null when there is nothing to say. */
function pendingStatus(state: ConnectionState): string | null {
  switch (state.kind) {
    case "connecting":
      return "Connecting to the relay\u{2026}";
    case "waiting":
      return WAITING_TEXT;
    case "opening":
      return "Pairing with the computer\u{2026}";
    case "retrying":
      return `${state.reason} ${retryText(state.retryAt, Date.now())}.`;
    default:
      return null;
  }
}

/** The line under the app's title about the link to the computer, or null while there is nothing to say. */
function statusLine(state: ConnectionState): StatusLine | null {
  switch (state.kind) {
    case "off":
    case "ready":
      return null;
    case "connecting":
      return { key: "connecting", text: "Connecting to the relay\u{2026}", time: null, action: null };
    case "opening":
      return { key: "opening", text: "Opening a private connection to the computer\u{2026}", time: null, action: null };
    case "waiting":
      return { key: "waiting", text: WAITING_TEXT, time: null, action: null };
    case "retrying":
      return {
        key: `retrying:${state.reason}`,
        text: state.reason,
        time: `${retryText(state.retryAt, Date.now())}.`,
        action: { label: "Try now", run: () => session?.link.wake() },
      };
    case "ended":
      return { key: `ended:${state.why}`, text: state.message, time: null, action: endedAction(state.why) };
  }
}

/** What the status line offers once the link has ended, as fits why it ended. */
function endedAction(why: EndReason): StatusLine["action"] {
  switch (why) {
    case "not-paired":
      return { label: "Pair again", run: openScan };
    case "version":
      return { label: "Reload", run: () => location.reload() };
    default:
      return {
        label: "Try again",
        run: () => {
          const old = session;
          if (old !== null) {
            startSession(old.paired);
            old.link.stop();
          }
          render();
        },
      };
  }
}

/**
 * Shows the line about the link. It is built again only when what it says
 * changes, and the countdown in it is hidden from screen readers, so that
 * they do not read the line out again every second.
 */
function renderStatus(): void {
  const line = session !== null && pending === null && blocked === null ? statusLine(session.state) : null;
  if (line === null) {
    statusBar.hidden = true;
    if (statusKey !== null) statusBar.replaceChildren();
    statusKey = null;
    statusTime = null;
    return;
  }
  statusBar.hidden = false;
  if (line.key === statusKey) {
    if (statusTime !== null && line.time !== null) statusTime.data = line.time;
    return;
  }
  statusKey = line.key;
  statusTime = line.time === null ? null : document.createTextNode(line.time);
  statusBar.replaceChildren();
  append(statusBar, [
    el("span", { class: "status-text" }, line.text),
    statusTime !== null && " ",
    statusTime !== null && el("span", { "aria-hidden": "true" }, statusTime),
    line.action !== null && button(line.action.label, line.action.run, { class: "secondary" }),
  ]);
}

/** The tab a screen belongs to, or null for the camera, which shows no tabs. */
function tabOf(screen: Route["screen"]): "home" | "approvals" | "settings" | null {
  switch (screen) {
    case "home":
    case "connection":
    case "schema":
    case "compare":
      return "home";
    case "approvals":
    case "approval":
      return "approvals";
    case "settings":
      return "settings";
    case "scan":
      return null;
  }
}

/** Shows the Back button and the tabs as they fit the screen showing. */
function renderChrome(): void {
  const plain = pending === null && blocked === null;
  backButton.hidden = !plain || (session === null ? route.screen !== "scan" : parentOf(route) === null);
  const current = plain && session !== null ? tabOf(route.screen) : null;
  // The Requests tab says how many requests are waiting, so the list is asked for on every tab.
  const waiting = current !== null ? value(approvalsLoad())?.approvals.length ?? 0 : 0;
  const key = current === null ? null : `${current}:${waiting}`;
  if (key !== tabsKey) {
    tabsKey = key;
    tabBar.hidden = current === null;
    tabBar.replaceChildren();
    if (current !== null) {
      append(tabBar, [
        tab("Schemas", HOME, current === "home", 0),
        tab("Requests", { screen: "approvals" }, current === "approvals", waiting),
        tab("Settings", { screen: "settings" }, current === "settings", 0),
      ]);
    }
  }
  renderStatus();
}

/** One of the tabs, with how many requests are waiting when there are any. */
function tab(label: string, target: Route, current: boolean, count: number): HTMLButtonElement {
  return button([label, count > 0 && el("span", { class: "count" }, count)], () => go(target), {
    class: "tab",
    "aria-current": current ? "page" : null,
  });
}

/**
 * Shows what the app should show now. Called after anything changes. The
 * screen is built again each time, keeping the focus where it was while the
 * same screen shows, and moving it to the title when another one does.
 */
function render(): void {
  renderChrome();
  const key = screenKey();
  if (shownKey === "scan" && key !== "scan") {
    stopScan();
    scanUi = null;
  }
  if (key === "scan") {
    // The camera screen is built once, so that the camera keeps running.
    if (shownKey !== "scan") {
      const { nodes, ui } = scanScreen(actions);
      app.replaceChildren(...nodes);
      shownKey = "scan";
      scanUi = ui;
      focusTitle();
      startScan(ui);
    }
    return;
  }
  const focus = rememberFocus();
  app.replaceChildren(...screenNodes());
  if (key === shownKey) restoreFocus(focus);
  else {
    shownKey = key;
    focusTitle();
  }
}

/** Which screen shows, as a key that changes only when another screen shows. */
function screenKey(): string {
  if (blocked !== null) return "blocked";
  if (pending !== null) return "pending";
  if (route.screen === "scan") return "scan";
  if (session === null) return "pair";
  return `route:${writeRoute(route)}`;
}

/** The screen to show now. */
function screenNodes(): Node[] {
  if (blocked !== null) return blockedScreen(blocked.message, blocked.canReload, actions);
  if (pending !== null) {
    const connection = pending.connection;
    return confirmScreen(
      pending.name,
      pending.problem,
      pending.pairing,
      connection === null ? null : pendingStatus(connection.state),
      session?.paired.computerName ?? null,
      actions,
    );
  }
  if (session === null) return pairScreen(pairAlert, iosTip(), actions);
  return withAlert(routeNodes(session));
}

/** A screen with the problem the app last ran into under its title. */
function withAlert(nodes: Node[]): Node[] {
  return pairAlert === null || nodes.length === 0 ? nodes : [nodes[0], notice(pairAlert, "bad"), ...nodes.slice(1)];
}

/** The screen for the route showing, with what the computer has said for it so far. */
function routeNodes(current: Session): Node[] {
  switch (route.screen) {
    case "home":
      return homeScreen(current.paired.computerName, value(helloLoad()), connectionsLoad() ?? LOADING, actions);
    case "connection": {
      const id = route.connectionId;
      const connection = value(connectionsLoad())?.find((each) => each.id === id) ?? null;
      return connectionScreen(connection, schemasLoad(id), actions, id);
    }
    case "schema": {
      const { connectionId, schema } = route;
      const overview = need(`schema:${connectionId}/${schema}`, (link) => link.request({ method: "schema.read", params: { connectionId, schema } }));
      return schemaScreen(connectionId, schema, overview, value(helloLoad())?.canCompare ?? false, openTables, filter, actions);
    }
    case "compare":
      return compareNodes();
    case "approvals":
      return approvalsNodes(current);
    case "approval":
      return approvalNodes(current, route.approvalId);
    case "settings":
      if (pushSupported() && alerts.prepared === null) void prepareAlerts(current);
      return settingsScreen(current.paired, value(helloLoad()), alertsView(), forgetting, actions);
    case "scan":
      return [];
  }
}

/** The Compare screen, keeping its choices to connections and schemas the computer still shares. */
function compareNodes(): Node[] {
  const connections = connectionsLoad();
  const list = value(connections);
  if (list !== null && !list.some((each) => each.id === compareForm.sourceId)) {
    const sourceId = list[0]?.id ?? null;
    if (sourceId !== compareForm.sourceId) {
      compareForm = { sourceId, schema: "", targets: new Set() };
      compareResult = null;
      compareToken += 1;
    }
  }
  const source = compareForm.sourceId;
  const schemas = source === null ? undefined : schemasLoad(source);
  const names = value(schemas);
  if (names !== null && !names.includes(compareForm.schema)) {
    // Most databases keep their tables in "public", so it is the first choice.
    const schema = names.includes("public") ? "public" : names[0] ?? "";
    if (schema !== compareForm.schema) {
      compareForm = { ...compareForm, schema };
      compareResult = null;
      compareToken += 1;
    }
  }
  if (list !== null) {
    const listed = new Set(list.map((each) => each.id));
    const targets = new Set([...compareForm.targets].filter((id) => listed.has(id) && id !== source));
    if (targets.size !== compareForm.targets.size) compareForm = { ...compareForm, targets };
  }
  return compareScreen(connections ?? LOADING, compareForm, schemas, compareResult, actions);
}

/** The Requests screen, getting the passkey setup ready as soon as the computer allows it, so that its prompt opens at once. */
function approvalsNodes(current: Session): Node[] {
  const list = approvalsLoad();
  const shown = value(list);
  if (shown !== null && setup.working === null) {
    if (shown.canApprove && shown.passkey === "allowed" && passkeysSupported()) {
      if (setup.prepared === null) void prepareSetup(current);
    } else if (setup.prepared !== null || setup.problem !== null) {
      setup = { prepared: null, working: null, problem: null };
    }
  }
  return approvalsScreen(list, connectionsLoad(), flash, setup, passkeysSupported(), actions);
}

/** One request's screen, getting its decision ready once the phone may decide it, so that the passkey prompt opens at once. */
function approvalNodes(current: Session, approvalId: number): Node[] {
  const list = approvalsLoad();
  const read = need(`approval:${approvalId}`, (link) => link.request({ method: "approvals.read", params: { approvalId } }));
  const shown = value(read);
  const keys = value(deciding.prepared);
  // The challenges were for what the request was before it changed.
  if (shown !== null && keys !== null && keys.fingerprint !== shown.fingerprint && deciding.working === null) resetDeciding();
  const choices = choicesFor(value(list), shown, approvalId);
  if (choices !== null && (choices.approve || choices.reject) && shown !== null && deciding.prepared === null && deciding.working === null) {
    void prepareDecision(current, approvalId, shown);
  }
  return approvalScreen(approvalId, list, read, connectionsLoad(), choices, deciding, actions);
}

/** What the phone offers for a request, or null until it knows. */
function choicesFor(list: ApprovalList | null, read: ApprovalRead | null, approvalId: number): Choices | null {
  const summary = list?.approvals.find((each) => each.id === approvalId);
  if (list === null || read === null || summary === undefined) return null;
  const hashed = fingerprintOf(read);
  return hashed === undefined ? null : decisionChoices(list, summary, read, hashed);
}

/**
 * The fingerprint of the SQL the computer showed for a request, worked out
 * on the phone itself, so that what it approves is exactly what it showed.
 * Null when the computer showed no SQL, and undefined while it is still
 * being worked out.
 */
function fingerprintOf(read: ApprovalRead): string | null | undefined {
  if (read.scripts === null) return null;
  if (fingerprints.has(read)) return fingerprints.get(read);
  if (!fingerprinting.has(read)) {
    fingerprinting.add(read);
    approvalFingerprint(read.scripts, read.action)
      .then(
        (hash) => fingerprints.set(read, hash),
        () => fingerprints.set(read, null),
      )
      .finally(() => render());
  }
  return undefined;
}

/** Which field has the focus, and where its cursor is, so that a screen built again keeps them. */
function rememberFocus(): Focus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active.id === "" || !app.contains(active)) return null;
  if (active instanceof HTMLInputElement && (active.type === "text" || active.type === "search")) {
    return { id: active.id, start: active.selectionStart, end: active.selectionEnd };
  }
  return { id: active.id, start: null, end: null };
}

/** Puts the focus, and the cursor, back where they were before the screen was built again. */
function restoreFocus(focus: Focus | null): void {
  if (focus === null) return;
  const element = document.getElementById(focus.id);
  if (element === null || !app.contains(element)) return;
  element.focus({ preventScroll: true });
  if (element instanceof HTMLInputElement && focus.start !== null && focus.end !== null) {
    try {
      element.setSelectionRange(focus.start, focus.end);
    } catch {
      // Some kinds of field have no cursor to put back.
    }
  }
}

/** Moves the focus to a new screen's title, so that a screen reader starts reading there, and shows the screen from its top. */
function focusTitle(): void {
  (document.getElementById("title") ?? app).focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

/** The address for a route. Home's is the app's own address, with no "#". */
function addressOf(next: Route): string {
  return writeRoute(next) || "/";
}

/** The route showing, read afresh after an await, when the one checked before may have changed since. */
function currentRoute(): Route {
  return route;
}

/** How many screens of the app are behind the one in a history entry, from what the app stamped on the entry, or null when it stamped nothing. */
function readDepth(state: unknown): number | null {
  if (typeof state !== "object" || state === null) return null;
  const stamped = (state as { depth?: unknown }).depth;
  return typeof stamped === "number" && Number.isSafeInteger(stamped) && stamped >= 0 ? stamped : null;
}

/** Opens another screen, with a history entry of its own, so that the phone's Back gesture comes back here. */
function go(next: Route): void {
  if (writeRoute(next) === writeRoute(route)) {
    render();
    return;
  }
  depth += 1;
  history.pushState({ depth }, "", addressOf(next));
  setRoute(next);
}

/** Shows `next` in place of the screen showing, without a history entry of its own. */
function replace(next: Route): void {
  history.replaceState({ depth }, "", addressOf(next));
  setRoute(next);
}

/** The app's Back button: the browser's own Back while there is an earlier screen of the app, and otherwise the screen above this one. */
function back(): void {
  if (depth > 0) history.back();
  else replace(parentOf(route) ?? HOME);
}

/** Goes back to `target`, a screen behind this one, as after a decision, without leaving a way forward to this one. */
function returnTo(target: Route): void {
  if (depth > 0) {
    setRoute(target);
    history.back();
  } else replace(target);
}

/**
 * Follows the browser's Back and Forward, and an address opened from a
 * link. The browser can say so twice for one change, once as "popstate" and
 * once as "hashchange", so this does nothing the second time.
 */
function fromAddress(): void {
  const stamped = readDepth(history.state);
  depth = stamped ?? depth + 1;
  const code = readAddressPairing(location.origin, location.hash);
  if (code !== null) {
    // The code is taken out of the address at once, so it is not kept in the history.
    replace(HOME);
    takeCode(code);
    render();
    return;
  }
  const next = readRoute(location.hash);
  if (stamped === null) history.replaceState({ depth }, "", addressOf(next));
  if (writeRoute(next) !== writeRoute(route)) setRoute(next);
}

/** Reads the address the app was opened at, taking a pairing code out of it at once. */
function readFirstAddress(): void {
  depth = readDepth(history.state) ?? 0;
  const code = readAddressPairing(location.origin, location.hash);
  if (code !== null) {
    takeCode(code);
    route = HOME;
  } else route = readRoute(location.hash);
  history.replaceState({ depth }, "", addressOf(route));
}

/** Takes the pairing code from a link the phone was opened with, or says why it could not. */
function takeCode(code: PairingCode | "unreadable"): void {
  if (code === "unreadable") pairAlert = "That pairing link could not be read. Scan the code on the computer's screen instead.";
  else startPending(code);
}

/** Shows another screen, letting go of what the one before was in the middle of. */
function setRoute(next: Route): void {
  if (route.screen === "scan" && next.screen !== "scan") {
    stopScan();
    scanUi = null;
  }
  if (next.screen !== "approvals") flash = null;
  if (route.screen === "settings" && next.screen !== "settings") forgetting = false;
  if (route.screen === "approval" && (next.screen !== "approval" || next.approvalId !== route.approvalId)) resetDeciding();
  if (next.screen === "schema" && (route.screen !== "schema" || route.connectionId !== next.connectionId || route.schema !== next.schema)) filter = "";
  if (session !== null) pairAlert = null;
  route = next;
  render();
}

/** Asks the computer again for what the screen showing shows. */
function refresh(): void {
  switch (route.screen) {
    case "home":
      drop("hello");
      drop("connections");
      break;
    case "connection":
      drop("connections");
      drop(`schemas:${route.connectionId}`);
      break;
    case "schema":
      drop(`schema:${route.connectionId}/${route.schema}`);
      break;
    case "compare":
      drop("connections");
      if (compareForm.sourceId !== null) drop(`schemas:${compareForm.sourceId}`);
      break;
    case "approvals":
      drop("approvals");
      if (setup.working === null) setup = { prepared: null, working: null, problem: null };
      break;
    case "approval":
      drop("approvals");
      drop(`approval:${route.approvalId}`);
      if (deciding.working === null) resetDeciding();
      break;
    case "settings":
      drop("hello");
      if (!alerts.working) {
        alerts = { prepared: null, working: false, problem: null };
        alertsToken += 1;
      }
      break;
    case "scan":
      break;
  }
  render();
}

/** Chooses the connection and schema to compare from. */
function setCompare(sourceId: number, schema: string): void {
  compareForm = { sourceId, schema, targets: new Set([...compareForm.targets].filter((id) => id !== sourceId)) };
  compareResult = null;
  compareToken += 1;
  render();
}

/** Adds a connection to compare against, up to as many as the computer compares at once, or takes one away. */
function toggleTarget(id: number, on: boolean): void {
  const targets = new Set(compareForm.targets);
  if (!on) targets.delete(id);
  else if (targets.size < MAX_COMPARE_TARGETS) targets.add(id);
  compareForm = { ...compareForm, targets };
  compareResult = null;
  compareToken += 1;
  render();
}

/** Opens Compare from a schema's screen, comparing from that schema. */
function compareFrom(connectionId: number, schema: string): void {
  compareForm = { sourceId: connectionId, schema, targets: new Set() };
  compareResult = null;
  compareToken += 1;
  go({ screen: "compare" });
}

/** Compares the chosen schema with the same schema on each connection chosen to compare against. */
async function runCompare(): Promise<void> {
  const owner = session;
  const { sourceId, schema, targets } = compareForm;
  if (owner === null || sourceId === null || schema === "" || targets.size === 0 || compareResult?.status === "loading") return;
  compareToken += 1;
  const token = compareToken;
  compareResult = LOADING;
  render();
  let result: Load<CompareSummary>;
  try {
    const summary = await owner.link.request({
      method: "compare.run",
      params: { source: { connectionId: sourceId, schema }, targets: [...targets].map((connectionId) => ({ connectionId, schema })) },
    });
    result = { status: "loaded", value: summary };
  } catch (error) {
    result = { status: "failed", message: errorText(error) };
  }
  // A change to the choices since then makes this answer one to a question no longer asked.
  if (session !== owner || compareToken !== token) return;
  compareResult = result;
  render();
}

/** Starts the camera on the scan screen, and reads what it sees until it finds a pairing code. */
function startScan(ui: ScanUi): void {
  stopScan();
  ui.retry.hidden = true;
  say(ui, "Starting the camera\u{2026}");
  stopScanning = startScanner(ui.video, {
    started: () => say(ui, "Point the camera at the code on the computer's screen."),
    found: (text) => foundCode(text, ui),
    failed: (message) => {
      say(ui, message);
      ui.retry.hidden = false;
    },
  });
}

/** Turns the camera off. */
function stopScan(): void {
  const stop = stopScanning;
  stopScanning = null;
  stop?.();
}

/** Shows `text` under the camera. The line is read out as it changes, so the same words are not set again while the camera keeps seeing the same code. */
function say(ui: ScanUi, text: string): void {
  if (ui.message.textContent !== text) ui.message.textContent = text;
}

/** Acts on a code the camera read: pairs with it, or says why it cannot. */
function foundCode(text: string, ui: ScanUi): void {
  const read = readScannedText(text, location.origin);
  switch (read.kind) {
    case "pair":
      stopScan();
      startPending(read.code);
      returnTo(HOME);
      return;
    case "other-relay":
      say(ui, `That code is for another relay (${new URL(read.relayOrigin).host}). Open that relay's address on this phone to pair with it.`);
      return;
    case "not-pairing":
      say(ui, "That is not a Schema Studio pairing code. Scan the code under Pair a phone in Settings on the computer.");
      return;
  }
}

/** Whether this browser can make and use passkeys at all. */
function passkeysSupported(): boolean {
  return typeof PublicKeyCredential !== "undefined" && typeof navigator.credentials?.create === "function";
}

/**
 * Opens the phone's passkey prompt. Called before anything is awaited, so
 * that the browser still counts the tap that asked for it, which some
 * browsers need before they show the prompt at all.
 */
function startPasskey(prompt: () => Promise<Credential | null>): Promise<PublicKeyCredential> {
  let started: Promise<Credential | null>;
  try {
    started = prompt();
  } catch (error) {
    started = Promise.reject(error);
  }
  return started.then((credential) => {
    if (credential === null) throw new DOMException("No passkey was used.", "NotAllowedError");
    return credential as PublicKeyCredential;
  });
}

/** The sentence for a passkey that could not be made ("create") or used ("get"), or for the computer turning it down. */
function passkeyProblem(error: unknown, kind: "create" | "get"): string {
  if (error instanceof RpcError || error instanceof Problem) return error.message;
  return passkeyErrorText(error instanceof DOMException ? error.name : "", kind);
}

/** Asks the computer for the challenge a new passkey signs, before the person taps Set up approvals, so that the prompt opens at once. */
async function prepareSetup(owner: Session): Promise<void> {
  setupToken += 1;
  const token = setupToken;
  setup = { ...setup, prepared: LOADING };
  let prepared: Load<PasskeyChallenge> | null;
  let gone = false;
  try {
    prepared = { status: "loaded", value: await owner.link.request({ method: "passkey.begin" }) };
  } catch (error) {
    gone = error instanceof RpcError && PASSKEY_GONE.has(error.code);
    // A link that dropped is asked again once it is back, as the screen shows again.
    prepared = error instanceof RpcError && error.code === "lost" ? null : { status: "failed", message: errorText(error) };
  }
  if (session !== owner || setupToken !== token) return;
  if (gone) drop("approvals");
  setup = { ...setup, prepared };
  render();
}

/** Makes this phone's passkey for approvals, and gives the computer its public half, which the computer checks every decision with. */
async function setUpPasskey(): Promise<void> {
  const owner = session;
  const challenge = value(setup.prepared);
  if (owner === null || challenge === null || setup.working !== null) return;
  const challengeBytes = fromBase64Url(challenge.challenge);
  const userId = fromBase64Url(challenge.userId);
  if (challengeBytes === null || userId === null) {
    setup = { prepared: null, working: null, problem: UNREADABLE_CHALLENGE };
    render();
    return;
  }
  const label = `Approvals on ${owner.paired.computerName}`;
  const made = startPasskey(() =>
    navigator.credentials.create({
      publicKey: {
        // The computer checks the passkey was made for the relay's own address (desktop/src/core/webauthn.ts).
        rp: { id: location.hostname, name: "Schema Studio" },
        user: { id: userId, name: label, displayName: label },
        challenge: challengeBytes,
        // ES256 (-7) only, because it is the one kind of key the computer can
        // check. Chrome warns that RS256 is missing, but every phone's
        // passkeys can do ES256, and offering RS256 too would let the phone
        // make a passkey that the computer then turns down.
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
        attestation: "none",
        timeout: PASSKEY_WITHIN_MS,
      },
    }),
  );
  setup = { ...setup, working: "create", problem: null };
  render();
  let problem: string | null = null;
  let gone = false;
  try {
    const credential = await made;
    const response = credential.response as AuthenticatorAttestationResponse;
    await owner.link.request({
      method: "passkey.finish",
      params: {
        clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
        attestationObject: toBase64Url(new Uint8Array(response.attestationObject)),
      },
    });
  } catch (error) {
    gone = error instanceof RpcError && PASSKEY_GONE.has(error.code);
    problem = passkeyProblem(error, "create");
  }
  if (session !== owner) return;
  if (problem === null && route.screen === "approvals") flash = "Approvals are set up on this phone. Open a request to approve or reject it.";
  if (problem === null || gone) drop("approvals");
  setup = { prepared: null, working: null, problem };
  render();
}

/**
 * Asks the computer for a one-time challenge for deciding the request, and
 * works out what the passkey signs for each decision, before the person
 * taps Approve or Reject, so that the passkey prompt opens at once. What it
 * signs covers the request, the decision and the fingerprint of the SQL the
 * phone showed, so a signature for one cannot be used for another.
 */
async function prepareDecision(owner: Session, approvalId: number, read: ApprovalRead): Promise<void> {
  const token = decidingToken;
  deciding = { ...deciding, prepared: LOADING };
  let prepared: Load<DecisionKeys> | null;
  let gone = false;
  try {
    const begun = await owner.link.request({ method: "approvals.begin" });
    const nonce = fromBase64Url(begun.nonce);
    const credentialId = fromBase64Url(begun.credentialId);
    if (nonce === null || credentialId === null) throw new Problem(UNREADABLE_CHALLENGE);
    const [approve, reject] = await Promise.all([
      approvalChallenge(nonce, approvalId, "approve", read.fingerprint),
      approvalChallenge(nonce, approvalId, "reject", read.fingerprint),
    ]);
    prepared = { status: "loaded", value: { credentialId, fingerprint: read.fingerprint, challenges: { approve, reject } } };
  } catch (error) {
    gone = error instanceof RpcError && PASSKEY_GONE.has(error.code);
    prepared = error instanceof RpcError && error.code === "lost" ? null : { status: "failed", message: errorText(error) };
  }
  if (session !== owner || decidingToken !== token) return;
  if (gone) drop("approvals");
  deciding = { ...deciding, prepared };
  window.clearTimeout(decidingTimer);
  decidingTimer = undefined;
  if (prepared !== null && prepared.status === "loaded") {
    decidingTimer = window.setTimeout(() => {
      if (decidingToken !== token || deciding.working !== null) return;
      deciding = { ...deciding, prepared: null };
      render();
    }, CHALLENGE_FOR_MS);
  }
  render();
}

/** Approves or rejects the request showing, signed with the phone's passkey. */
async function decide(decision: ApprovalDecision): Promise<void> {
  const owner = session;
  const keys = value(deciding.prepared);
  const shownRoute = currentRoute();
  if (owner === null || shownRoute.screen !== "approval" || keys === null || deciding.working !== null) return;
  const approvalId = shownRoute.approvalId;
  const token = decidingToken;
  const signed = startPasskey(() =>
    navigator.credentials.get({
      publicKey: {
        challenge: keys.challenges[decision],
        rpId: location.hostname,
        allowCredentials: [{ type: "public-key", id: keys.credentialId }],
        userVerification: "required",
        timeout: PASSKEY_WITHIN_MS,
      },
    }),
  );
  window.clearTimeout(decidingTimer);
  decidingTimer = undefined;
  deciding = { ...deciding, working: decision, problem: null };
  render();
  try {
    const credential = await signed;
    const response = credential.response as AuthenticatorAssertionResponse;
    const answer = await owner.link.request({
      method: "approvals.decide",
      params: {
        approvalId,
        decision,
        fingerprint: keys.fingerprint,
        assertion: {
          credentialId: toBase64Url(new Uint8Array(credential.rawId)),
          authenticatorData: toBase64Url(new Uint8Array(response.authenticatorData)),
          clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
          signature: toBase64Url(new Uint8Array(response.signature)),
        },
      },
    });
    if (session !== owner) return;
    drop("approvals");
    drop(`approval:${approvalId}`);
    if (decidingToken === token) resetDeciding();
    const now = currentRoute();
    const here = now.screen === "approval" && now.approvalId === approvalId;
    if (here || now.screen === "approvals") flash = DECIDED_TEXT[answer.status === "approved" ? "approve" : "reject"];
    if (here) returnTo({ screen: "approvals" });
    else render();
  } catch (error) {
    if (session !== owner) return;
    const code = error instanceof RpcError ? error.code : null;
    if (code === "already-decided" || code === "changed" || code === "not-found") {
      drop("approvals");
      drop(`approval:${approvalId}`);
    } else if (code !== null && PASSKEY_GONE.has(code)) drop("approvals");
    if (decidingToken === token) deciding = { prepared: null, working: null, problem: passkeyProblem(error, "get") };
    render();
  }
}

/** Lets go of the challenges for a decision, as when the request showing changes. */
function resetDeciding(): void {
  decidingToken += 1;
  window.clearTimeout(decidingTimer);
  decidingTimer = undefined;
  deciding = { prepared: null, working: null, problem: null };
}

/** Whether this browser can get drift alerts at all. */
function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Finds out whether drift alerts are on for this phone, from both the computer and the browser, since either can forget them. */
async function prepareAlerts(owner: Session): Promise<void> {
  alertsToken += 1;
  const token = alertsToken;
  alerts = { prepared: LOADING, working: false, problem: null };
  let prepared: Load<AlertsSetup> | null;
  try {
    const status = await owner.link.request({ method: "push.status" });
    const key = fromBase64Url(status.key);
    if (key === null) throw new Problem("The computer sent a key for drift alerts that this phone cannot read. Update Schema Studio on the computer, then try again.");
    const registration = await withinTime(
      navigator.serviceWorker.ready,
      HELPER_WITHIN_MS,
      "The phone app's offline helper did not start, and drift alerts need it. Reload the page, then try again.",
    );
    let subscription = await registration.pushManager.getSubscription();
    // A subscription made for another computer's key cannot carry this computer's alerts.
    const subscribedKey = subscription?.options.applicationServerKey ?? null;
    if (subscription !== null && (subscribedKey === null || !sameBytes(new Uint8Array(subscribedKey), key))) {
      await subscription.unsubscribe().catch(() => false);
      subscription = null;
    }
    prepared = { status: "loaded", value: { registration, key, status, subscription } };
  } catch (error) {
    prepared = error instanceof RpcError && error.code === "lost" ? null : { status: "failed", message: errorText(error) };
  }
  if (session !== owner || alertsToken !== token) return;
  alerts = { ...alerts, prepared };
  render();
}

/** Turns drift alerts on: the phone asks to allow notifications, and the computer is told where to send them. */
async function turnOnAlerts(): Promise<void> {
  const owner = session;
  const prepared = alerts.prepared;
  const ready = value(prepared);
  if (owner === null || ready === null || alerts.working) return;
  // Asked for before anything is awaited, so that the browser still counts
  // the tap that asked, which it needs before it shows its permission prompt.
  let subscribing: Promise<PushSubscription>;
  try {
    subscribing = ready.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: ready.key });
  } catch (error) {
    subscribing = Promise.reject(error);
  }
  alerts = { ...alerts, working: true, problem: null };
  render();
  let problem: string | null = null;
  try {
    const subscription = await subscribing;
    const p256dh = subscription.getKey("p256dh");
    const auth = subscription.getKey("auth");
    if (p256dh === null || auth === null) {
      await subscription.unsubscribe().catch(() => false);
      throw new Problem("This browser did not give the keys drift alerts need. Try the phone's own browser: Safari on an iPhone, or Chrome on Android.");
    }
    let status: PushStatus;
    try {
      status = await owner.link.request({
        method: "push.subscribe",
        params: { endpoint: subscription.endpoint, p256dh: toBase64Url(new Uint8Array(p256dh)), auth: toBase64Url(new Uint8Array(auth)) },
      });
    } catch (error) {
      // The computer turned this subscription down for good, so the browser does not keep it either.
      if (error instanceof RpcError && (error.code === "bad-request" || error.code === "forbidden")) await subscription.unsubscribe().catch(() => false);
      throw error;
    }
    if (alerts.prepared === prepared) alerts = { ...alerts, prepared: { status: "loaded", value: { ...ready, status, subscription } } };
  } catch (error) {
    problem = alertsProblem(error);
  }
  if (session !== owner) return;
  alerts = { ...alerts, working: false, problem };
  render();
}

/** Turns drift alerts off, in the browser first, so that none arrive even when the computer cannot be told. */
async function turnOffAlerts(): Promise<void> {
  const owner = session;
  const prepared = alerts.prepared;
  const ready = value(prepared);
  if (owner === null || ready === null || alerts.working) return;
  alerts = { ...alerts, working: true, problem: null };
  render();
  let problem: string | null = null;
  try {
    const subscription = ready.subscription ?? (await ready.registration.pushManager.getSubscription());
    if (subscription !== null) await subscription.unsubscribe();
    let status: PushStatus = { ...ready.status, subscribed: false };
    // The computer forgets a subscription the push service says is gone the
    // next time it sends an alert, so telling it now only tidies up sooner.
    if (owner.link.state.kind === "ready") {
      status = await withinTime(owner.link.request({ method: "push.unsubscribe" }), LET_GO_WITHIN_MS, "").catch(() => status);
    }
    if (alerts.prepared === prepared) alerts = { ...alerts, prepared: { status: "loaded", value: { ...ready, status, subscription: null } } };
  } catch {
    problem = "The phone could not turn off drift alerts. Try again.";
  }
  if (session !== owner) return;
  alerts = { ...alerts, working: false, problem };
  render();
}

/** The sentence for drift alerts that could not be turned on. */
function alertsProblem(error: unknown): string {
  if (error instanceof RpcError || error instanceof Problem) return error.message;
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError") return "Alerts were not turned on, because the phone did not allow notifications for this app.";
  if (name === "AbortError") return "The browser's push service could not be reached. Check the phone's connection, then try again.";
  return "The phone could not turn on drift alerts. Try again.";
}

/** What the Settings screen shows about drift alerts. */
function alertsView(): AlertsView {
  if (!pushSupported()) {
    return {
      kind: "unsupported",
      message: iosTip()
        ? "On an iPhone or iPad, drift alerts work only in the app added to the Home Screen (iOS 16.4 or later). Add it with Share, then Add to Home Screen, and open it from there."
        : "This browser cannot get drift alerts. Try the phone's own browser: Safari on an iPhone, or Chrome on Android.",
    };
  }
  const prepared = alerts.prepared;
  if (prepared === null || prepared.status === "loading") return { kind: "loading" };
  if (prepared.status === "failed") return { kind: "failed", message: prepared.message };
  const { status, subscription } = prepared.value;
  const permission = Notification.permission;
  return {
    kind: "ready",
    on: status.subscribed && subscription !== null && permission === "granted",
    working: alerts.working,
    blocked: permission === "denied",
    problem: alerts.problem,
  };
}

/** Unsubscribes this browser from drift alerts, as far as it can, when it stops being paired with the computer that sends them. */
async function dropBrowserPush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // Best effort. If it fails, the old computer's alerts can still arrive
    // until the phone is removed in Settings on that computer.
  }
}

/** Forgets the paired computer: stops its alerts reaching this browser, tells it so when it can, and deletes the saved pairing. */
async function forget(): Promise<void> {
  const owner = session;
  if (owner === null || forgetBusy) return;
  forgetBusy = true;
  await dropBrowserPush();
  if (owner.link.state.kind === "ready") {
    await withinTime(owner.link.request({ method: "push.unsubscribe" }), LET_GO_WITHIN_MS, "").catch(() => undefined);
  }
  if (session !== owner) {
    forgetBusy = false;
    return;
  }
  session = null;
  owner.link.stop();
  resetScreens();
  try {
    await forgetPairedComputer();
  } catch (error) {
    // idb-store.ts words its errors for the person holding the phone.
    const reason = error instanceof Error ? ` ${error.message}` : "";
    pairAlert = `This phone could not finish forgetting the computer, so it may still be paired the next time the app opens.${reason}`;
  }
  forgetBusy = false;
  replace(HOME);
}

/** Whether to tell the person to add the app to the Home Screen: on an iPhone or iPad, outside the Home Screen app, where drift alerts do not work. */
function iosTip(): boolean {
  const kind = phoneKind();
  return (kind === "iPhone" || kind === "iPad") && !standalone();
}

/** Whether the app was opened from the Home Screen rather than in a browser tab. */
function standalone(): boolean {
  return matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Shows only `message`, for a problem that stops the app from running at all. */
function block(message: string, canReload: boolean): void {
  blocked = { message, canReload };
  render();
}

/** Whether this browser has what the app needs: Web Crypto with X25519 keys, which older browsers lack, and IndexedDB to keep the pairing in. */
async function browserWorks(): Promise<boolean> {
  if (typeof crypto === "undefined" || crypto.subtle === undefined || typeof indexedDB === "undefined") return false;
  try {
    await generateKeyPair("X25519", false);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the offline helper (sw.ts), which keeps the app's files for when
 * the relay cannot be reached, and shows drift alerts. The app works without
 * it, only not offline and without alerts, so a failure is not shown.
 */
function registerHelper(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
}

/** Follows the browser's history, the Back button, the network, and the app going out of sight and coming back. */
function listen(): void {
  window.addEventListener("popstate", fromAddress);
  window.addEventListener("hashchange", fromAddress);
  backButton.addEventListener("click", back);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (session === null) return;
    // A phone that slept may have lost the link without noticing, so it checks now.
    session.link.wake();
    if (away >= STALE_AFTER_MS) for (const entry of session.answers.values()) entry.generation = -1;
    render();
  });
  window.addEventListener("online", () => session?.link.wake());
  window.setInterval(tick, 1000);
}

/** Counts down to the link's next try, once a second. */
function tick(): void {
  if (pending?.connection?.state.kind === "retrying") render();
  else if (session?.state.kind === "retrying") renderStatus();
}

/** Starts the app: checks the browser can run it, reads the saved pairing, and shows the first screen. */
async function start(): Promise<void> {
  if (!isSecureContext) {
    block("This page was opened without HTTPS, so the phone app cannot run. Open the relay's https:// address instead.", false);
    return;
  }
  if (!(await browserWorks())) {
    block("This browser is too old for the phone app. Update it, or try the phone's own browser: Safari on an iPhone, or Chrome on Android.", false);
    return;
  }
  let paired: PairedComputer | null;
  try {
    paired = await loadPairedComputer();
  } catch (error) {
    block(error instanceof Error ? error.message : SOMETHING_WRONG, true);
    return;
  }
  if (paired !== null) startSession(paired);
  readFirstAddress();
  listen();
  registerHelper();
  render();
}

void start();
