/**
 * The Settings window (renderer/settings.html).
 *
 * It shows what the main process sends when the page loads, and sends each
 * change back: the theme as soon as it is picked, and the GitHub registry
 * (the repository Schema Studio publishes scripts to, and the token it uses
 * there) when Save is pressed. The main process checks the GitHub boxes
 * again before it saves anything and says which box is wrong, and the page
 * shows that message under the box.
 *
 * The token is never shown here or sent to this page; the page only knows
 * whether one is saved. A new token goes from its box straight to the main
 * process, which keeps it with the app's other keys, and the box is emptied
 * as soon as it is saved or given up on.
 *
 * The page is served with a strict security policy (src/main/protocol.ts),
 * so this script changes only text, attributes and the state of the form,
 * and it stops the form from being sent the ordinary way.
 */
{
  type SettingsApi = import("../shared/ipc").SettingsApi;
  type SettingsView = import("../shared/ipc").SettingsView;
  type GithubSettingsInput = import("../shared/ipc").GithubSettingsInput;
  type ThemeChoice = import("../shared/ipc").ThemeChoice;
  type Field = "owner" | "repo" | "token";
  /** What Save does with the token: leave it as it is, put a new one in its place, or take it away. */
  type TokenMode = GithubSettingsInput["token"]["action"];

  const NOT_LOADED = "Schema Studio could not load the settings. Close this window and open Settings again.";
  const NOT_SAVED = "Schema Studio could not save the GitHub settings. Try again, and if it keeps happening, the logs say why.";
  const KEPT_IN: Record<SettingsView["secretsKeptIn"], string> = {
    keyring: "In the system keyring",
    file: "In a file only your account can read, because no keyring was available",
  };

  function element<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`The Settings page has no #${id}.`);
    return found as T;
  }

  const loadError = element<HTMLParagraphElement>("load-error");
  const content = element<HTMLDivElement>("content");
  const form = element<HTMLFormElement>("github-form");
  const inputs: Record<Field, HTMLInputElement> = {
    owner: element<HTMLInputElement>("owner"),
    repo: element<HTMLInputElement>("repo"),
    token: element<HTMLInputElement>("token"),
  };
  const errors: Record<Field, HTMLParagraphElement> = {
    owner: element<HTMLParagraphElement>("owner-error"),
    repo: element<HTMLParagraphElement>("repo-error"),
    token: element<HTMLParagraphElement>("token-error"),
  };
  const tokenParts = {
    saved: element<HTMLDivElement>("token-saved"),
    none: element<HTMLDivElement>("token-none"),
    entry: element<HTMLDivElement>("token-entry"),
    hint: element<HTMLParagraphElement>("token-hint"),
    removing: element<HTMLDivElement>("token-removing"),
    replace: element<HTMLButtonElement>("token-replace"),
    remove: element<HTMLButtonElement>("token-remove"),
    add: element<HTMLButtonElement>("token-add"),
    cancel: element<HTMLButtonElement>("token-cancel"),
    keep: element<HTMLButtonElement>("token-keep"),
  };
  const formError = element<HTMLParagraphElement>("github-error");
  const saveStatus = element<HTMLParagraphElement>("github-status");
  const saveButton = element<HTMLButtonElement>("github-save");
  const themeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="theme"]'));
  const keptIn = element<HTMLElement>("secrets-kept-in");
  const dataPath = element<HTMLElement>("data-path");
  const logsPath = element<HTMLElement>("logs-path");
  const openLogsButton = element<HTMLButtonElement>("open-logs");
  const versionText = element<HTMLElement>("version");
  const closeButton = element<HTMLButtonElement>("close");

  let hasToken = false;
  let tokenMode: TokenMode = "keep";
  let saving = false;

  /** Shows the token controls that fit what is saved now and what Save would do. */
  function showToken(): void {
    tokenParts.saved.hidden = !(tokenMode === "keep" && hasToken);
    tokenParts.none.hidden = !(tokenMode === "keep" && !hasToken);
    tokenParts.entry.hidden = tokenMode !== "replace";
    tokenParts.hint.hidden = tokenMode !== "replace";
    tokenParts.removing.hidden = tokenMode !== "remove";
  }

  /** The token button on show at the moment, which is where keyboard focus belongs after a change. */
  function tokenButton(): HTMLButtonElement {
    if (tokenMode === "remove") return tokenParts.keep;
    return hasToken ? tokenParts.replace : tokenParts.add;
  }

  function clearError(field: Field): void {
    errors[field].hidden = true;
    errors[field].textContent = "";
    inputs[field].removeAttribute("aria-invalid");
  }

  function clearErrors(): void {
    clearError("owner");
    clearError("repo");
    clearError("token");
    formError.hidden = true;
    formError.textContent = "";
  }

  function showError(field: Field | null, message: string): void {
    if (field === null) {
      // Shown before the text goes in, so that a screen reader announces it.
      formError.hidden = false;
      formError.textContent = message;
      return;
    }
    errors[field].hidden = false;
    errors[field].textContent = message;
    if (field === "token" && tokenMode !== "replace") {
      // The message is about the saved token, so focus goes to the button that changes it.
      tokenButton().focus();
      return;
    }
    inputs[field].setAttribute("aria-invalid", "true");
    inputs[field].focus();
  }

  function setTokenMode(mode: TokenMode): void {
    tokenMode = mode;
    // A token typed and then given up on should not stay in the page.
    if (mode !== "replace") inputs.token.value = "";
    clearError("token");
    saveStatus.textContent = "";
    showToken();
    (mode === "replace" ? inputs.token : tokenButton()).focus();
  }

  function render(view: SettingsView): void {
    inputs.owner.value = view.github.owner;
    inputs.repo.value = view.github.repo;
    hasToken = view.github.hasToken;
    showToken();
    for (const input of themeInputs) input.checked = input.value === view.theme;
    keptIn.textContent = KEPT_IN[view.secretsKeptIn];
    dataPath.textContent = view.paths.data;
    logsPath.textContent = view.paths.logs;
    versionText.textContent = `Version ${view.version}`;
    content.hidden = false;
  }

  function showLoadError(): void {
    // Without the saved settings the boxes would be empty, and saving them would wipe the registry.
    content.hidden = true;
    loadError.hidden = false;
    loadError.textContent = NOT_LOADED;
  }

  function readInput(): GithubSettingsInput {
    let token: GithubSettingsInput["token"] = { action: "keep" };
    if (tokenMode === "replace") token = { action: "replace", value: inputs.token.value };
    else if (tokenMode === "remove") token = { action: "remove" };
    return { owner: inputs.owner.value, repo: inputs.repo.value, token };
  }

  async function save(api: SettingsApi): Promise<void> {
    if (saving) return;
    saving = true;
    // aria-disabled rather than disabled, because a disabled button loses keyboard focus.
    saveButton.setAttribute("aria-disabled", "true");
    clearErrors();
    saveStatus.textContent = "Saving…";
    try {
      const result = await api.saveGithub(readInput());
      if (result.ok) {
        // The token box is about to disappear, so focus must not be left inside it.
        const focusWasOnToken = tokenParts.entry.contains(document.activeElement);
        tokenMode = "keep";
        inputs.token.value = "";
        render(result.view);
        if (focusWasOnToken) tokenButton().focus();
        saveStatus.textContent = "Saved.";
      } else {
        saveStatus.textContent = "";
        showError(result.field, result.message);
      }
    } catch {
      saveStatus.textContent = "";
      showError(null, NOT_SAVED);
    } finally {
      saving = false;
      saveButton.removeAttribute("aria-disabled");
    }
  }

  /** Makes the Close button and the Escape key call `close`. */
  function closeOn(close: () => void): void {
    closeButton.addEventListener("click", () => close());
    document.addEventListener("keydown", (event) => {
      // Escape closes a dialog on Ubuntu, but not while it is finishing a character being composed.
      if (event.key === "Escape" && !event.isComposing) close();
    });
  }

  function start(api: SettingsApi): void {
    form.addEventListener("submit", (event) => {
      // The page may not send a form anywhere; the main process does the saving.
      event.preventDefault();
      void save(api);
    });
    for (const field of ["owner", "repo", "token"] as const) {
      inputs[field].addEventListener("input", () => {
        clearError(field);
        saveStatus.textContent = "";
      });
    }
    tokenParts.replace.addEventListener("click", () => setTokenMode("replace"));
    tokenParts.add.addEventListener("click", () => setTokenMode("replace"));
    tokenParts.remove.addEventListener("click", () => setTokenMode("remove"));
    tokenParts.cancel.addEventListener("click", () => setTokenMode("keep"));
    tokenParts.keep.addEventListener("click", () => setTokenMode("keep"));
    for (const input of themeInputs) {
      input.addEventListener("change", () => {
        if (input.checked) api.setTheme(input.value as ThemeChoice);
      });
    }
    openLogsButton.addEventListener("click", () => api.openLogs());
    closeOn(() => api.close());
    api.get().then(render, showLoadError);
  }

  const api = window.schemaStudioSettings;
  if (api === undefined) {
    showLoadError();
    // Without the preload script the main process cannot be asked to close
    // the window, but the window can still close itself.
    closeOn(() => window.close());
  } else {
    start(api);
  }
}
