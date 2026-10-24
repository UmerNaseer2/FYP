/**
 * The Phone section of the Settings window (renderer/settings.html), where
 * phones are paired and given the saved connections they may see.
 *
 * It shows what the main process sends when the page loads and again after
 * each change, whether the change came from this page, from the relay or
 * from a phone, and it sends each change back as soon as it is made. The
 * main process checks every change again and words each refusal for a
 * person, so this page has no rules of its own about when a phone may pair
 * or which relay will do: it shows what it is told.
 *
 * A pairing code reaches this page only as its drawing. The link inside it
 * carries a one-time secret, so the main process keeps the link to itself.
 * A code pairs one phone and runs out after a few minutes, and the phone
 * link stops it sooner when Cancel is pressed, when the window closes, when
 * the link is turned off and when the relay changes.
 *
 * A phone chooses its own name, so the names of phones, like those of the
 * connections, go into the page as text only, never as markup. The page is
 * served with a strict security policy (src/main/protocol.ts), so this
 * script builds its rows and the code's drawing from plain elements, and
 * everything about their look comes from app.css.
 */
{
  type PhoneSettingsApi = import("../shared/ipc").PhoneSettingsApi;
  type PhoneView = import("../shared/ipc").PhoneView;
  type PhoneStatus = import("../shared/ipc").PhoneStatus;
  type PhoneSummary = import("../shared/ipc").PhoneSummary;
  type PhoneConnection = import("../shared/ipc").PhoneConnection;
  type PhonePairing = import("../shared/ipc").PhonePairing;
  /** The view while the phone link is open. */
  type LinkView = Extract<PhoneView, { available: true }>;
  /** A new pairing code: its drawing, and when it runs out. */
  type Code = Extract<PhonePairing, { ok: true }>;
  /** A button in a phone's row, by the phone's key and what the button does. */
  type PhoneButton = { key: string; action: string };

  const NOT_LOADED = "Schema Studio could not load the phone link. Close this window and open Settings again.";
  const RELAY_NOT_SAVED = "Schema Studio could not save the relay. Try again, and if it keeps happening, the logs say why.";
  const NO_CODE = "Schema Studio could not make a pairing code. Try again, and if it keeps happening, the logs say why.";
  const CONNECTIONS_NOT_LISTED =
    "Schema Studio could not list the saved connections. Try again, and if it keeps happening, the logs say why.";
  const NO_SAVED_CONNECTIONS =
    "There are no saved PostgreSQL connections yet. Add one on Schema Studio's Connections screen, then check again.";
  const CAN_PAIR = "Shows a code that pairs one phone.";
  const CONFIRM_REMOVE = "Remove this phone? It will need pairing again to connect.";
  const RELAY_WARNING =
    "Phones paired through the current relay cannot reach this computer through a new one, so they will need pairing again.";
  /** What the status line says in each state but "waiting", which gives the reason the connection was lost. */
  const STATUS_TEXT: Record<Exclude<PhoneStatus["state"], "waiting">, string> = {
    off: "The phone link is off.",
    "needs-relay": "Add a relay below to connect.",
    connecting: "Connecting to the relay\u{2026}",
    connected: "Connected to the relay.",
    replaced: "Another Schema Studio signed in to the relay as this computer, so this one let it take over.",
  };
  // The same names as the web app's (my-app/lib/environments.ts). An unlabelled connection shows its database alone.
  const ENVIRONMENTS: Record<Exclude<PhoneConnection["environment"], "unset">, string> = {
    dev: "Dev",
    staging: "Staging",
    prod: "Production",
  };
  const SVG = "http://www.w3.org/2000/svg";

  function element<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`The Settings page has no #${id}.`);
    return found as T;
  }

  const unavailable = element<HTMLParagraphElement>("phone-unavailable");
  const content = element<HTMLDivElement>("phone-content");
  const enabledBox = element<HTMLInputElement>("phone-enabled");
  const statusParts = {
    dot: element<HTMLSpanElement>("phone-status-dot"),
    text: element<HTMLSpanElement>("phone-status"),
    retry: element<HTMLParagraphElement>("phone-retry"),
    connectNow: element<HTMLButtonElement>("phone-connect-now"),
  };
  const relayParts = {
    form: element<HTMLFormElement>("phone-relay-form"),
    input: element<HTMLInputElement>("phone-relay"),
    save: element<HTMLButtonElement>("phone-relay-save"),
    warning: element<HTMLParagraphElement>("phone-relay-warning"),
    error: element<HTMLParagraphElement>("phone-relay-error"),
    status: element<HTMLParagraphElement>("phone-relay-status"),
  };
  const pairParts = {
    row: element<HTMLDivElement>("phone-pair-row"),
    hint: element<HTMLSpanElement>("phone-pair-hint"),
    button: element<HTMLButtonElement>("phone-pair"),
    status: element<HTMLParagraphElement>("phone-pair-status"),
    error: element<HTMLParagraphElement>("phone-pair-error"),
  };
  const codeParts = {
    panel: element<HTMLDivElement>("phone-pairing"),
    drawing: element<HTMLDivElement>("phone-qr"),
    relay: element<HTMLElement>("phone-pairing-relay"),
    expiry: element<HTMLParagraphElement>("phone-pairing-expiry"),
    renew: element<HTMLButtonElement>("phone-pairing-renew"),
    cancel: element<HTMLButtonElement>("phone-pairing-cancel"),
  };
  const connectionParts = {
    list: element<HTMLDivElement>("phone-connections"),
    problem: element<HTMLDivElement>("phone-connections-problem"),
    message: element<HTMLParagraphElement>("phone-connections-message"),
    retry: element<HTMLButtonElement>("phone-connections-retry"),
  };
  const phoneList = element<HTMLDivElement>("phone-phones");
  const noPhones = element<HTMLParagraphElement>("phone-phones-empty");

  /** The latest view, or null while the phone link is not open. */
  let current: LinkView | null = null;
  /** When the code on show runs out, or null when no code is on show or it has run out. */
  let codeExpiresAt: number | null = null;
  /** The relay that the code on show leads to. */
  let codeRelay: string | null = null;
  let makingCode = false;
  let savingRelay = false;
  /** Whether the relay box holds an address typed and not saved yet, which a new view must not overwrite. */
  let relayEdited = false;
  let loadingConnections = false;
  /** Whether the saved connections are listed, so that their boxes can be ticked. */
  let connectionsListed = false;
  /** The phone whose Remove was pressed once, which now asks to be sure. */
  let confirming: string | null = null;
  /** What the phone rows show now, so that they are built again only when that changes. */
  let phonesShown = "";

  /** Changes an element's text only when it differs, so that a screen reader does not announce the same words again. */
  function setText(target: HTMLElement, text: string): void {
    if (target.textContent !== text) target.textContent = text;
  }

  /** A time left, as a person reads it: "45 seconds", or "4:05" from a minute up. */
  function duration(ms: number): string {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function showStatus(status: PhoneStatus): void {
    setText(statusParts.text, status.state === "waiting" ? status.reason : STATUS_TEXT[status.state]);
    statusParts.dot.classList.toggle("dot-good", status.state === "connected");
    statusParts.dot.classList.toggle("dot-bad", status.state === "waiting" || status.state === "replaced");
    statusParts.retry.hidden = status.state !== "waiting";
    statusParts.connectNow.hidden = status.state !== "waiting" && status.state !== "replaced";
    setText(statusParts.connectNow, status.state === "replaced" ? "Connect again" : "Try now");
  }

  /** Moves the countdowns on: to the next try at the relay, and to the end of the code on show. */
  function tick(): void {
    const status = current?.status;
    if (status?.state === "waiting") {
      const left = status.retryAt - Date.now();
      setText(statusParts.retry, left > 0 ? `Trying again in ${duration(left)}.` : "Trying again\u{2026}");
    }
    if (codeExpiresAt !== null) {
      const left = codeExpiresAt - Date.now();
      if (left > 0) setText(codeParts.expiry, `This code runs out in ${duration(left)}.`);
      else codeRunOut();
    }
  }

  /** Takes away a code that has run out, and offers a new one in its place. */
  function codeRunOut(): void {
    codeExpiresAt = null;
    codeParts.drawing.replaceChildren();
    codeParts.drawing.hidden = true;
    setText(codeParts.expiry, "This code has run out.");
    codeParts.renew.hidden = false;
  }

  /** Shows a new pairing code, drawn from the squares the main process worked out. */
  function showCode(code: Code): void {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", `0 0 ${code.qr.size} ${code.qr.size}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Pairing code");
    // Each square sits exactly on the grid, with no blurred edge for a camera to misread.
    svg.setAttribute("shape-rendering", "crispEdges");
    const ground = document.createElementNS(SVG, "rect");
    ground.setAttribute("width", String(code.qr.size));
    ground.setAttribute("height", String(code.qr.size));
    ground.setAttribute("fill", "#ffffff");
    const squares = document.createElementNS(SVG, "path");
    squares.setAttribute("d", code.qr.path);
    squares.setAttribute("fill", "#000000");
    svg.append(ground, squares);
    codeParts.drawing.replaceChildren(svg);
    codeParts.drawing.hidden = false;
    codeExpiresAt = code.expiresAt;
    codeRelay = current?.relayOrigin ?? null;
    setText(codeParts.relay, codeRelay ?? "");
    codeParts.renew.hidden = true;
    codeParts.panel.hidden = false;
    pairParts.row.hidden = true;
    tick();
    codeParts.cancel.focus();
  }

  /** Puts the code away and brings the Pair button back. */
  function hideCode(): void {
    // The panel is about to disappear, so focus must not be left inside it.
    const hadFocus = codeParts.panel.contains(document.activeElement);
    codeExpiresAt = null;
    codeRelay = null;
    codeParts.drawing.replaceChildren();
    codeParts.panel.hidden = true;
    pairParts.row.hidden = false;
    if (hadFocus) pairParts.button.focus();
  }

  /** Says beside the Pair button whether a phone can pair now, and why not. */
  function showPairButton(): void {
    const cannotPair = current?.cannotPair ?? null;
    setText(pairParts.hint, cannotPair ?? CAN_PAIR);
    // aria-disabled rather than disabled, because a disabled button loses keyboard focus.
    if (cannotPair === null && !makingCode) pairParts.button.removeAttribute("aria-disabled");
    else pairParts.button.setAttribute("aria-disabled", "true");
  }

  function clearPairMessages(): void {
    pairParts.error.hidden = true;
    pairParts.error.textContent = "";
    setText(pairParts.status, "");
  }

  function showPairError(message: string): void {
    // Shown before the text goes in, so that a screen reader announces it.
    pairParts.error.hidden = false;
    pairParts.error.textContent = message;
  }

  /** Asks for a new pairing code and shows it, or says why there is none. */
  async function makeCode(api: PhoneSettingsApi): Promise<void> {
    if (makingCode) return;
    makingCode = true;
    showPairButton();
    codeParts.renew.setAttribute("aria-disabled", "true");
    clearPairMessages();
    try {
      const answer = await api.pair();
      if (answer.ok) showCode(answer);
      else showPairError(answer.message);
    } catch {
      showPairError(NO_CODE);
    } finally {
      makingCode = false;
      codeParts.renew.removeAttribute("aria-disabled");
      showPairButton();
    }
  }

  /** Takes the code away once a phone has paired with it, and says which phone it was. */
  function phonePaired(name: string): void {
    if (!codeParts.panel.hidden) hideCode();
    clearPairMessages();
    setText(pairParts.status, `Paired with ${name}.`);
  }

  /** The relay's address as typed, near enough to the form it is saved in to compare with the saved one. */
  function typedRelay(): string {
    const typed = relayParts.input.value.trim().toLowerCase();
    return typed.endsWith("/") ? typed.slice(0, -1) : typed;
  }

  /** Warns, before a new relay is saved, that the phones paired through the current one will need pairing again. */
  function showRelayWarning(): void {
    const saved = current?.relayOrigin ?? null;
    const typed = typedRelay();
    const phones = current?.phones.length ?? 0;
    const warn = phones > 0 && saved !== null && typed !== "" && typed !== saved.toLowerCase();
    relayParts.warning.hidden = !warn;
    // Emptied while hidden, because the relay box's description would read it out even then.
    setText(relayParts.warning, warn ? RELAY_WARNING : "");
  }

  function clearRelayError(): void {
    relayParts.error.hidden = true;
    relayParts.error.textContent = "";
    relayParts.input.removeAttribute("aria-invalid");
  }

  function showRelayError(message: string): void {
    relayParts.error.hidden = false;
    relayParts.error.textContent = message;
    relayParts.input.setAttribute("aria-invalid", "true");
    relayParts.input.focus();
  }

  async function saveRelay(api: PhoneSettingsApi): Promise<void> {
    if (savingRelay) return;
    savingRelay = true;
    relayParts.save.setAttribute("aria-disabled", "true");
    clearRelayError();
    setText(relayParts.status, "Saving\u{2026}");
    try {
      const result = await api.setRelay(relayParts.input.value);
      if (result.ok) {
        relayEdited = false;
        relayParts.input.value = result.relayOrigin;
        setText(relayParts.status, "Saved.");
        showRelayWarning();
      } else {
        setText(relayParts.status, "");
        showRelayError(result.message);
      }
    } catch {
      setText(relayParts.status, "");
      showRelayError(RELAY_NOT_SAVED);
    } finally {
      savingRelay = false;
      relayParts.save.removeAttribute("aria-disabled");
    }
  }

  function showConnectionsProblem(message: string): void {
    connectionsListed = false;
    connectionParts.list.hidden = true;
    connectionParts.list.replaceChildren();
    connectionParts.problem.hidden = false;
    setText(connectionParts.message, message);
  }

  /** A saved connection's row: a box to tick, its name, and its database, but never its host or user name. */
  function connectionRow(connection: PhoneConnection): HTMLLabelElement {
    const row = document.createElement("label");
    row.className = "row row-choice";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = String(connection.id);
    const text = document.createElement("span");
    text.className = "choice-text";
    const name = document.createElement("span");
    name.className = "choice-name";
    name.textContent = connection.name;
    const detail = document.createElement("span");
    detail.className = "hint";
    detail.textContent =
      connection.environment === "unset"
        ? `Database ${connection.database}`
        : `${ENVIRONMENTS[connection.environment]}, database ${connection.database}`;
    text.append(name, detail);
    row.append(box, text);
    return row;
  }

  function showConnections(connections: PhoneConnection[]): void {
    connectionParts.list.replaceChildren(...connections.map(connectionRow));
    connectionsListed = true;
    connectionParts.list.hidden = false;
    connectionParts.problem.hidden = true;
    showShared();
  }

  function connectionBoxes(): HTMLInputElement[] {
    return Array.from(connectionParts.list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  }

  /** Ticks the boxes of the connections phones may see now. */
  function showShared(): void {
    if (current === null || !connectionsListed) return;
    const shared = new Set(current.sharedConnectionIds);
    for (const box of connectionBoxes()) box.checked = shared.has(Number(box.value));
  }

  /** Lists the saved connections, to choose which ones phones may see, or says why they cannot be listed. */
  async function loadConnections(api: PhoneSettingsApi): Promise<void> {
    if (loadingConnections) return;
    loadingConnections = true;
    // The first time there is nothing to try again yet. A later try keeps its button, dimmed, so that focus stays on it.
    if (connectionParts.problem.hidden) connectionParts.retry.hidden = true;
    connectionParts.retry.setAttribute("aria-disabled", "true");
    connectionParts.problem.hidden = false;
    // Said on every try, as a second try that fails the same way would otherwise look as if nothing happened.
    setText(connectionParts.message, "Listing the saved connections\u{2026}");
    try {
      const answer = await api.connections();
      if (!answer.ok) {
        showConnectionsProblem(answer.message);
      } else if (answer.connections.length === 0) {
        showConnectionsProblem(NO_SAVED_CONNECTIONS);
      } else {
        // Check again is about to disappear, so focus must not be left on it.
        const hadFocus = connectionParts.problem.contains(document.activeElement);
        showConnections(answer.connections);
        if (hadFocus) connectionBoxes()[0]?.focus();
      }
    } catch {
      showConnectionsProblem(CONNECTIONS_NOT_LISTED);
    } finally {
      loadingConnections = false;
      connectionParts.retry.hidden = false;
      connectionParts.retry.removeAttribute("aria-disabled");
    }
  }

  /** When a phone was last seen, or that it is connected now, when it paired, and whether it gets drift alerts. */
  function phoneDetail(phone: PhoneSummary): string {
    const pairedOn = new Date(phone.pairedAt).toLocaleDateString(undefined, { dateStyle: "medium" });
    const alerts = phone.alerts ? " Gets drift alerts." : "";
    if (phone.connected) return `Connected now. Paired on ${pairedOn}.${alerts}`;
    const lastSeen = new Date(phone.lastSeenAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    return `Last seen ${lastSeen}. Paired on ${pairedOn}.${alerts}`;
  }

  /** One of the buttons in a phone's row. Every row has the same buttons, so Remove's name says which phone it is for. */
  function phoneRowButton(phone: PhoneSummary, action: "remove" | "confirm" | "keep", detailId: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action === "keep" ? "button" : "button button-bad";
    button.dataset.key = phone.key;
    button.dataset.action = action;
    if (action === "keep") {
      button.textContent = "Keep it";
    } else {
      button.textContent = "Remove";
      button.setAttribute("aria-label", `Remove ${phone.name}`);
    }
    button.setAttribute("aria-describedby", detailId);
    return button;
  }

  /** A paired phone's row: its name, when it was last seen, and Remove, which asks to be sure first. */
  function phoneRow(phone: PhoneSummary, index: number): HTMLDivElement {
    const asking = confirming === phone.key;
    const row = document.createElement("div");
    row.className = "row phone-row";
    row.setAttribute("role", "listitem");
    const text = document.createElement("span");
    text.className = "choice-text";
    const name = document.createElement("span");
    name.className = "choice-name";
    name.textContent = phone.name;
    const detail = document.createElement("span");
    detail.className = "hint";
    detail.id = `phone-detail-${index}`;
    detail.textContent = asking ? CONFIRM_REMOVE : phoneDetail(phone);
    text.append(name, detail);
    const actions = document.createElement("span");
    actions.className = "token-actions";
    if (asking) actions.append(phoneRowButton(phone, "confirm", detail.id), phoneRowButton(phone, "keep", detail.id));
    else actions.append(phoneRowButton(phone, "remove", detail.id));
    row.append(text, actions);
    return row;
  }

  /** The button in the phone rows that has keyboard focus, if one has. */
  function focusedPhoneButton(): PhoneButton | null {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLButtonElement) || !phoneList.contains(focused)) return null;
    return { key: focused.dataset.key ?? "", action: focused.dataset.action ?? "" };
  }

  function phoneButton(target: PhoneButton): HTMLButtonElement | null {
    const buttons = Array.from(phoneList.querySelectorAll<HTMLButtonElement>("button"));
    return buttons.find((button) => button.dataset.key === target.key && button.dataset.action === target.action) ?? null;
  }

  /**
   * Lists the paired phones. The rows are built again only when what they
   * show changes, as every new view would otherwise take keyboard focus off
   * them, and focus goes back to the same button, or the nearest one left,
   * when they are.
   */
  function showPhones(phones: PhoneSummary[], focusOn: PhoneButton | null = null): void {
    if (confirming !== null && !phones.some((phone) => phone.key === confirming)) confirming = null;
    const shown = JSON.stringify([confirming, phones.map((phone) => [phone.key, phone.name, phoneDetail(phone)])]);
    let target = focusOn;
    if (shown !== phonesShown) {
      phonesShown = shown;
      target ??= focusedPhoneButton();
      phoneList.replaceChildren(...phones.map(phoneRow));
      phoneList.hidden = phones.length === 0;
      noPhones.hidden = phones.length > 0;
    }
    if (target === null) return;
    const button = phoneButton(target) ?? phoneList.querySelector<HTMLButtonElement>('button[data-action="remove"]');
    if (button !== null) button.focus();
    else if (codeParts.panel.hidden) pairParts.button.focus();
    else codeParts.cancel.focus();
  }

  function render(view: PhoneView): void {
    if (!view.available) {
      current = null;
      hideCode();
      content.hidden = true;
      unavailable.hidden = false;
      setText(unavailable, view.message);
      return;
    }
    // The phone link stops the code on show when it is turned off or its
    // relay changes, so the page takes the code away at the same moment.
    if (!codeParts.panel.hidden && (!view.enabled || view.relayOrigin !== codeRelay)) hideCode();
    current = view;
    enabledBox.checked = view.enabled;
    showStatus(view.status);
    if (!relayEdited) relayParts.input.value = view.relayOrigin ?? "";
    showRelayWarning();
    showPairButton();
    showShared();
    showPhones(view.phones);
    unavailable.hidden = true;
    content.hidden = false;
    tick();
  }

  function showLoadError(): void {
    current = null;
    content.hidden = true;
    unavailable.hidden = false;
    setText(unavailable, NOT_LOADED);
  }

  function start(api: PhoneSettingsApi): void {
    enabledBox.addEventListener("change", () => api.setEnabled(enabledBox.checked));
    statusParts.connectNow.addEventListener("click", () => api.connectNow());
    relayParts.form.addEventListener("submit", (event) => {
      // The page may not send a form anywhere; the main process does the saving.
      event.preventDefault();
      void saveRelay(api);
    });
    relayParts.input.addEventListener("input", () => {
      relayEdited = true;
      clearRelayError();
      setText(relayParts.status, "");
      showRelayWarning();
    });
    pairParts.button.addEventListener("click", () => {
      if (current !== null && current.cannotPair === null) void makeCode(api);
    });
    codeParts.renew.addEventListener("click", () => void makeCode(api));
    codeParts.cancel.addEventListener("click", () => {
      api.cancelPairing();
      hideCode();
    });
    connectionParts.list.addEventListener("change", () => {
      api.setShared(connectionBoxes().filter((box) => box.checked).map((box) => Number(box.value)));
    });
    connectionParts.retry.addEventListener("click", () => void loadConnections(api));
    phoneList.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      const key = button?.dataset.key;
      if (button === null || key === undefined || current === null) return;
      if (button.dataset.action === "remove") {
        // The first press only asks. Focus goes to Keep it, so that pressing Enter again cannot remove the phone by mistake.
        confirming = key;
        showPhones(current.phones, { key, action: "keep" });
      } else if (button.dataset.action === "keep") {
        confirming = null;
        showPhones(current.phones, { key, action: "remove" });
      } else if (button.dataset.action === "confirm") {
        api.forget(key);
      }
    });
    window.addEventListener("pagehide", () => {
      // A code left on show must not pair a phone once the window has gone.
      if (!codeParts.panel.hidden) api.cancelPairing();
    });
    window.setInterval(tick, 1000);
    api.onChange(render);
    api.onPaired(phonePaired);
    api.get().then((view) => {
      render(view);
      void loadConnections(api);
    }, showLoadError);
  }

  const api = window.schemaStudioPhone;
  if (api === undefined) showLoadError();
  else start(api);
}
