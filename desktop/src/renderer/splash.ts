/**
 * The splash (renderer/splash.html): what the main window shows while
 * Schema Studio starts.
 *
 * It lists the four steps of a start and ticks each one off as the main
 * process reports it. When a step fails, it says what went wrong and offers
 * to try again, to open the logs, and to copy the details for whoever is
 * helping. Once the last step is done, the main process replaces this page
 * with Schema Studio itself.
 *
 * The main process announces every change, and also answers when asked.
 * The page asks once, because it may load after the start has moved on,
 * and from then on it listens.
 *
 * The page is served with a strict security policy (src/main/protocol.ts),
 * so this script changes only text, the hidden attribute and data
 * attributes. How each state looks is in renderer/app.css.
 */
{
  type StartupApi = import("../shared/ipc").StartupApi;
  type StartupState = import("../shared/ipc").StartupState;
  type StartupStep = import("../shared/ipc").StartupStep;

  /** The steps in the order a start takes them. The list on the page names each one. */
  const ORDER: readonly StartupStep[] = ["secrets", "database", "server", "sign-in"];
  const COPIED = "The details are on the clipboard, with passwords, keys and email addresses taken out.";
  const NOT_COPIED = "Schema Studio could not copy the details. Open the logs instead.";
  const NOT_CONNECTED = {
    title: "Schema Studio could not finish opening",
    message: "Quit Schema Studio and open it again. If this keeps happening, the logs say why.",
  };

  function element<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`The splash has no #${id}.`);
    return found as T;
  }

  const stepList = element<HTMLOListElement>("steps");
  const stepItems = Array.from(stepList.querySelectorAll<HTMLLIElement>("li[data-step]"));
  const failure = element<HTMLElement>("failure");
  const failureTitle = element<HTMLHeadingElement>("failure-title");
  const failureMessage = element<HTMLParagraphElement>("failure-message");
  const failureActions = element<HTMLDivElement>("failure-actions");
  const retryButton = element<HTMLButtonElement>("retry");
  const openLogsButton = element<HTMLButtonElement>("open-logs");
  const copyButton = element<HTMLButtonElement>("copy-details");
  const copyNote = element<HTMLParagraphElement>("copy-note");
  const live = element<HTMLParagraphElement>("live");

  /** The last step the main process reported, so that a failure shows against the step it stopped at. */
  let lastStep: StartupStep | null = null;
  let copying = false;

  /** Marks the steps before `current` as done, `current` itself as running or failed, and the rest as still to come. */
  function markSteps(current: StartupStep, failed: boolean): void {
    const at = ORDER.indexOf(current);
    for (const item of stepItems) {
      const index = ORDER.indexOf(item.dataset.step as StartupStep);
      if (index < at) item.dataset.state = "done";
      else if (index > at) item.dataset.state = "pending";
      else item.dataset.state = failed ? "failed" : "current";
      if (index === at && !failed) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    }
  }

  function labelOf(step: StartupStep): string {
    const item = stepItems.find((candidate) => candidate.dataset.step === step);
    return item?.textContent?.trim() ?? "";
  }

  function showFailure(title: string, message: string): void {
    failureTitle.textContent = title;
    failureMessage.textContent = message;
    failure.hidden = false;
    live.textContent = `${title.replace(/\.$/, "")}. ${message}`;
  }

  function render(state: StartupState): void {
    if (state.phase === "starting") {
      lastStep = state.step;
      markSteps(state.step, false);
      stepList.hidden = false;
      failure.hidden = true;
      live.textContent = labelOf(state.step);
      return;
    }
    // A page that loads straight into a failure has no step to show it
    // against, and a list of steps still to come would only mislead.
    if (lastStep === null) stepList.hidden = true;
    else markSteps(lastStep, true);
    showFailure(state.title, state.message);
    // Trying again is what most people want, so it is ready for Enter.
    retryButton.focus();
  }

  /** Says that this window cannot follow the start at all. It shows no buttons, because none of them could work. */
  function showBroken(): void {
    stepList.hidden = true;
    failureActions.hidden = true;
    showFailure(NOT_CONNECTED.title, NOT_CONNECTED.message);
  }

  function start(api: StartupApi): void {
    let announced = false;
    api.onStatus((state) => {
      announced = true;
      render(state);
    });
    // The main process announces every change, and its messages arrive in
    // the order it sent them. So once an announcement has arrived, the
    // answer to this question can only repeat it, and is left out.
    api.getState().then(
      (state) => {
        if (!announced) render(state);
      },
      () => {
        // The main process answers every page it knows, so a page it refused
        // would have its buttons refused as well.
        if (!announced) showBroken();
      },
    );

    retryButton.addEventListener("click", () => {
      // Trying again quits and reopens Schema Studio, so one press is enough.
      retryButton.disabled = true;
      api.retry();
    });
    openLogsButton.addEventListener("click", () => api.openLogs());
    copyButton.addEventListener("click", () => {
      if (copying) return;
      copying = true;
      copyNote.textContent = "";
      api
        .copyDetails()
        .then(
          () => {
            copyNote.textContent = COPIED;
          },
          () => {
            copyNote.textContent = NOT_COPIED;
          },
        )
        .finally(() => {
          copying = false;
        });
    });
  }

  const api = window.schemaStudioStartup;
  // The preload script gives this page its messages. Without them, nothing
  // would ever arrive, and the buttons could not do anything.
  if (api === undefined) showBroken();
  else start(api);
}
