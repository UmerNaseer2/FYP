/**
 * The Backup section of the Settings window (renderer/settings.html), where
 * what Schema Studio keeps is saved into one file locked with a passphrase,
 * and where such a file is restored.
 *
 * The main process does the work: it shows the file dialogs itself, checks
 * each passphrase again and words each refusal for a person, so this page
 * has no rules of its own about passphrases or files: it shows what it is
 * told. It only ever learns a backup's file name, never where the file is.
 * A passphrase goes from its box straight to the main process, and the
 * boxes for a new one are emptied once the backup is saved.
 *
 * Restoring asks once more, in a box of the main process's own, and then
 * closes this window and shows the restore on the main window instead. So a
 * restore that starts is never answered here.
 *
 * The page is served with a strict security policy (src/main/protocol.ts),
 * so this script changes only text, attributes and the state of the forms,
 * and it stops the forms from being sent the ordinary way.
 */
{
  type BackupSettingsApi = import("../shared/ipc").BackupSettingsApi;

  const NOT_LOADED = "Schema Studio could not set up backups in this window. Close it and open Settings again.";
  const NOT_SAVED = "Schema Studio could not save the backup. Try again, and if it keeps happening, the logs say why.";
  const NOT_CHOSEN =
    "Schema Studio could not show the files to choose from. Try again, and if it keeps happening, the logs say why.";
  const NOT_RESTORED = "Schema Studio could not restore the backup. Try again, and if it keeps happening, the logs say why.";

  function element<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`The Settings page has no #${id}.`);
    return found as T;
  }

  const unavailable = element<HTMLParagraphElement>("backup-unavailable");
  const content = element<HTMLDivElement>("backup-content");
  const saveParts = {
    form: element<HTMLFormElement>("backup-save-form"),
    passphrase: element<HTMLInputElement>("backup-passphrase"),
    passphraseError: element<HTMLParagraphElement>("backup-passphrase-error"),
    repeat: element<HTMLInputElement>("backup-repeat"),
    repeatError: element<HTMLParagraphElement>("backup-repeat-error"),
    button: element<HTMLButtonElement>("backup-save"),
    error: element<HTMLParagraphElement>("backup-save-error"),
    status: element<HTMLParagraphElement>("backup-save-status"),
  };
  const restoreParts = {
    form: element<HTMLFormElement>("backup-restore-form"),
    file: element<HTMLSpanElement>("backup-file"),
    choose: element<HTMLButtonElement>("backup-choose"),
    passphrase: element<HTMLInputElement>("backup-restore-passphrase"),
    passphraseError: element<HTMLParagraphElement>("backup-restore-passphrase-error"),
    button: element<HTMLButtonElement>("backup-restore"),
    error: element<HTMLParagraphElement>("backup-restore-error"),
    status: element<HTMLParagraphElement>("backup-restore-status"),
  };

  /** Whether a save, a choice or a restore is under way. The main process does one at a time, so the page does too. */
  let busy = false;

  /** Changes an element's text only when it differs, so that a screen reader does not announce the same words again. */
  function setText(target: HTMLElement, text: string): void {
    if (target.textContent !== text) target.textContent = text;
  }

  function setBusy(value: boolean): void {
    busy = value;
    for (const button of [saveParts.button, restoreParts.choose, restoreParts.button]) {
      // aria-disabled rather than disabled, because a disabled button loses keyboard focus.
      if (value) button.setAttribute("aria-disabled", "true");
      else button.removeAttribute("aria-disabled");
    }
  }

  /** Shows a message under the box it is about and moves to that box, or under the buttons when it is about no box. */
  function showError(target: HTMLParagraphElement, message: string, input: HTMLInputElement | null): void {
    // Shown before the text goes in, so that a screen reader announces it.
    target.hidden = false;
    target.textContent = message;
    if (input === null) return;
    input.setAttribute("aria-invalid", "true");
    input.focus();
  }

  function clearError(target: HTMLParagraphElement, input: HTMLInputElement | null): void {
    target.hidden = true;
    target.textContent = "";
    input?.removeAttribute("aria-invalid");
  }

  function clearSaveMessages(): void {
    clearError(saveParts.passphraseError, saveParts.passphrase);
    clearError(saveParts.repeatError, saveParts.repeat);
    clearError(saveParts.error, null);
    setText(saveParts.status, "");
  }

  function clearRestoreMessages(): void {
    clearError(restoreParts.passphraseError, restoreParts.passphrase);
    clearError(restoreParts.error, null);
    setText(restoreParts.status, "");
  }

  /** Saves a backup with the passphrase typed twice, once the main process has asked where. */
  async function save(api: BackupSettingsApi): Promise<void> {
    if (busy) return;
    setBusy(true);
    clearSaveMessages();
    setText(saveParts.status, "Saving\u{2026}");
    try {
      const result = await api.save(saveParts.passphrase.value, saveParts.repeat.value);
      if (result.ok) {
        // Not needed here any more, so the passphrase does not stay in the page.
        saveParts.passphrase.value = "";
        saveParts.repeat.value = "";
        setText(saveParts.status, `Saved the backup as ${result.fileName}.`);
        return;
      }
      // Closing the file dialog is not a problem, so it says nothing.
      setText(saveParts.status, "");
      if (result.reason === "cancelled") return;
      if (result.field === "passphrase") showError(saveParts.passphraseError, result.message, saveParts.passphrase);
      else if (result.field === "repeat") showError(saveParts.repeatError, result.message, saveParts.repeat);
      else showError(saveParts.error, result.message, null);
    } catch {
      setText(saveParts.status, "");
      showError(saveParts.error, NOT_SAVED, null);
    } finally {
      setBusy(false);
    }
  }

  /** Has the main process ask which backup to restore, and shows the chosen file's name. */
  async function choose(api: BackupSettingsApi): Promise<void> {
    if (busy) return;
    setBusy(true);
    clearRestoreMessages();
    try {
      const result = await api.choose();
      if (result.ok) {
        setText(restoreParts.file, result.fileName);
        // The passphrase is what the restore needs next.
        restoreParts.passphrase.focus();
      } else if (result.reason === "failed") {
        showError(restoreParts.error, result.message, null);
      }
    } catch {
      showError(restoreParts.error, NOT_CHOSEN, null);
    } finally {
      setBusy(false);
    }
  }

  /** Restores the chosen backup with the passphrase typed, once the main process has asked to be sure. */
  async function restore(api: BackupSettingsApi): Promise<void> {
    if (busy) return;
    setBusy(true);
    clearRestoreMessages();
    // The main process opens the backup and checks it before it asks.
    setText(restoreParts.status, "Opening the backup\u{2026}");
    try {
      const result = await api.restore(restoreParts.passphrase.value);
      if (result.ok) {
        // Only seen if this window is slow to close, as the restore closes it.
        setText(restoreParts.status, "Restoring the backup\u{2026}");
        return;
      }
      // Saying no when asked is not a problem, so it says nothing.
      setText(restoreParts.status, "");
      if (result.reason === "cancelled") return;
      if (result.field === "passphrase") showError(restoreParts.passphraseError, result.message, restoreParts.passphrase);
      else showError(restoreParts.error, result.message, null);
    } catch {
      setText(restoreParts.status, "");
      showError(restoreParts.error, NOT_RESTORED, null);
    } finally {
      setBusy(false);
    }
  }

  function showLoadError(): void {
    content.hidden = true;
    unavailable.hidden = false;
    setText(unavailable, NOT_LOADED);
  }

  function start(api: BackupSettingsApi): void {
    saveParts.form.addEventListener("submit", (event) => {
      // The page may not send a form anywhere; the main process does the saving.
      event.preventDefault();
      void save(api);
    });
    saveParts.passphrase.addEventListener("input", clearSaveMessages);
    saveParts.repeat.addEventListener("input", clearSaveMessages);
    restoreParts.choose.addEventListener("click", () => void choose(api));
    restoreParts.form.addEventListener("submit", (event) => {
      // The page may not send a form anywhere; the main process does the restoring.
      event.preventDefault();
      void restore(api);
    });
    restoreParts.passphrase.addEventListener("input", clearRestoreMessages);
    unavailable.hidden = true;
    content.hidden = false;
  }

  const api = window.schemaStudioBackup;
  if (api === undefined) showLoadError();
  else start(api);
}
