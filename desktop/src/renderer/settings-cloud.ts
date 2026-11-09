/**
 * The Web site section of the Settings window (renderer/settings.html), where
 * this computer is linked to a team's Schema Studio web site, so that its owner
 * can compare the connections shared here from the site's phone app.
 *
 * The main process does the work (src/main/cloud-agent.ts) and words what goes
 * wrong, so this page only shows what it is told. The code on show is the one
 * thing to check against the site's page, and the token never reaches this page.
 *
 * The page is served with a strict security policy (src/main/protocol.ts), so
 * this script changes only text, attributes and the state of the form, and it
 * stops the form from being sent the ordinary way.
 */
{
  type CloudSettingsApi = import("../shared/ipc").CloudSettingsApi;
  type CloudView = import("../shared/ipc").CloudView;
  type CloudSync = import("../shared/ipc").CloudSync;

  const NOT_LOADED = "Schema Studio could not set up the site link in this window. Close it and open Settings again.";
  const NOT_STARTED = "Schema Studio could not start linking. Try again, and if it keeps happening, the logs say why.";
  const OFFLINE_NOTE = "Schema Studio keeps working here without a site. Linking is optional.";

  function connections(count: number): string {
    return count === 1 ? "1 connection" : `${count} connections`;
  }

  /**
   * How the two-way sync stands, in a sentence or three: the website role that
   * holds the person here, when it last worked, and what each side keeps.
   * Empty for a site without the sync.
   */
  function syncLine(sync: CloudSync | null, offline: boolean): string {
    if (sync === null) return "";
    const parts: string[] = [];
    if (sync.role !== null) parts.push(`Your website role, ${sync.role}, applies here while linked.`);
    parts.push(
      sync.lastSyncedAt === null
        ? "Not synced with the website yet."
        : `Last synced ${new Date(sync.lastSyncedAt).toLocaleString()}.`
    );
    if (sync.website !== null && sync.here !== null) {
      parts.push(`${connections(sync.website)} from the website, and ${connections(sync.here)} on this computer only.`);
    }
    if (offline) parts.push("The website's connections can be looked at here, but not changed, until it can be reached.");
    return parts.join(" ");
  }

  function element<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`The Settings page has no #${id}.`);
    return found as T;
  }

  const unavailable = element<HTMLParagraphElement>("site-link-unavailable");
  const clear = element<HTMLButtonElement>("site-link-clear");
  const formParts = {
    form: element<HTMLFormElement>("site-link-form"),
    address: element<HTMLInputElement>("site-link-address"),
    start: element<HTMLButtonElement>("site-link-start"),
    error: element<HTMLParagraphElement>("site-link-error"),
    notice: element<HTMLParagraphElement>("site-link-notice"),
  };
  const waitingParts = {
    box: element<HTMLDivElement>("site-link-waiting"),
    origin: element<HTMLSpanElement>("site-link-origin-waiting"),
    code: element<HTMLElement>("site-link-code"),
    cancel: element<HTMLButtonElement>("site-link-cancel"),
  };
  const linkedParts = {
    box: element<HTMLDivElement>("site-link-linked"),
    dot: element<HTMLSpanElement>("site-link-dot"),
    state: element<HTMLSpanElement>("site-link-state"),
    where: element<HTMLParagraphElement>("site-link-where"),
    sync: element<HTMLParagraphElement>("site-link-sync"),
    problem: element<HTMLParagraphElement>("site-link-problem"),
    unlink: element<HTMLButtonElement>("site-link-unlink"),
  };

  /** Whether a request to link is under way, so that a second press does nothing. */
  let starting = false;

  function setText(target: HTMLElement, text: string): void {
    if (target.textContent !== text) target.textContent = text;
  }

  function showError(message: string): void {
    formParts.error.hidden = false;
    setText(formParts.error, message);
    formParts.address.setAttribute("aria-invalid", "true");
    formParts.address.focus();
  }

  function clearError(): void {
    formParts.error.hidden = true;
    setText(formParts.error, "");
    formParts.address.removeAttribute("aria-invalid");
  }

  function setStarting(value: boolean): void {
    starting = value;
    formParts.start.setAttribute("aria-disabled", String(value));
    setText(formParts.start, value ? "Linking…" : "Link");
  }

  function render(view: CloudView): void {
    unavailable.hidden = view.state !== "unavailable";
    setText(unavailable, view.state === "unavailable" ? view.message : "");
    clear.hidden = !(view.state === "unavailable" && view.canClear);
    formParts.form.hidden = view.state !== "off";
    waitingParts.box.hidden = view.state !== "linking";
    linkedParts.box.hidden = view.state !== "linked";

    switch (view.state) {
      case "off":
        // Never over what the person is typing.
        if (formParts.address.value === "" && view.origin !== null) formParts.address.value = view.origin;
        setText(formParts.notice, view.notice ?? OFFLINE_NOTE);
        break;
      case "linking":
        setText(waitingParts.origin, `The site is ${view.origin}.`);
        setText(waitingParts.code, view.code);
        break;
      case "linked":
        linkedParts.dot.classList.toggle("dot-good", view.problem === null);
        linkedParts.dot.classList.toggle("dot-bad", view.problem !== null);
        setText(linkedParts.state, `Linked to ${view.orgName}`);
        setText(linkedParts.where, `${view.origin}, since ${new Date(view.linkedAt).toLocaleDateString()}`);
        setText(linkedParts.sync, syncLine(view.sync, view.problem !== null));
        linkedParts.sync.hidden = view.sync === null;
        linkedParts.problem.hidden = view.problem === null;
        setText(linkedParts.problem, view.problem ?? "");
        break;
      case "unavailable":
        break;
    }
  }

  function showLoadError(): void {
    unavailable.hidden = false;
    setText(unavailable, NOT_LOADED);
    formParts.form.hidden = true;
    waitingParts.box.hidden = true;
    linkedParts.box.hidden = true;
  }

  function start(api: CloudSettingsApi): void {
    formParts.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (starting) return;
      clearError();
      setStarting(true);
      api.link(formParts.address.value).then(
        (result) => {
          setStarting(false);
          if (!result.ok) showError(result.message);
        },
        () => {
          setStarting(false);
          showError(NOT_STARTED);
        }
      );
    });
    formParts.address.addEventListener("input", clearError);
    waitingParts.cancel.addEventListener("click", () => api.cancelLink());
    linkedParts.unlink.addEventListener("click", () => api.unlink());
    clear.addEventListener("click", () => api.unlink());

    api.onChange(render);
    api.get().then(render, showLoadError);
  }

  const api = window.schemaStudioCloud;
  if (api === undefined) showLoadError();
  else start(api);
}
