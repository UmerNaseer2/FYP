/** @jest-environment jsdom */

/**
 * lib/ui/copy-text.ts: Copy must work on a plain http page, where the
 * browser offers no navigator.clipboard. These check that it uses the
 * clipboard API when there is one, copies from a hidden text box when there is
 * not, puts that box inside an open dialog, tidies up after itself, and throws
 * when the browser refuses both ways so the caller can say so.
 */
import { copyText } from "@/lib/ui/copy-text";

type Doc = Document & { execCommand?: (command: string) => boolean };

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

afterEach(() => {
  delete (navigator as { clipboard?: unknown }).clipboard;
  delete (document as { execCommand?: unknown }).execCommand;
  document.body.innerHTML = "";
});

it("uses navigator.clipboard when the page has it", async () => {
  const written: string[] = [];
  setClipboard({ writeText: async (text: string) => void written.push(text) });
  const execCommand = jest.fn(() => true);
  (document as Doc).execCommand = execCommand;

  await copyText("SELECT 1;");

  expect(written).toEqual(["SELECT 1;"]);
  expect(execCommand).not.toHaveBeenCalled();
});

it("copies from a hidden text box when there is no clipboard API", async () => {
  const button = document.createElement("button");
  document.body.appendChild(button);
  button.focus();
  let copiedValue = "";
  let parent: Node | null = null;
  (document as Doc).execCommand = jest.fn((command: string) => {
    const box = document.activeElement as HTMLTextAreaElement;
    copiedValue = command === "copy" ? box.value : "";
    parent = box.parentNode;
    return true;
  });

  await copyText("ALTER TABLE t ADD c int;");

  expect(copiedValue).toBe("ALTER TABLE t ADD c int;");
  expect(parent).toBe(document.body);
  // The box is gone and focus is back on the button that asked.
  expect(document.querySelector("textarea")).toBeNull();
  expect(document.activeElement).toBe(button);
});

it("puts the text box inside the dialog the copy started in", async () => {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const button = document.createElement("button");
  dialog.appendChild(button);
  document.body.appendChild(dialog);
  let parent: Node | null = null;
  (document as Doc).execCommand = jest.fn(() => {
    parent = (document.activeElement as HTMLElement).parentNode;
    return true;
  });

  await copyText("x", button);

  expect(parent).toBe(dialog);
});

it("tries the text box when the clipboard API refuses", async () => {
  setClipboard({ writeText: () => Promise.reject(new Error("blocked")) });
  const execCommand = jest.fn(() => true);
  (document as Doc).execCommand = execCommand;

  await copyText("x");

  expect(execCommand).toHaveBeenCalledWith("copy");
});

it("throws when the browser refuses both ways", async () => {
  setClipboard({ writeText: () => Promise.reject(new Error("blocked")) });
  (document as Doc).execCommand = () => false;

  await expect(copyText("x")).rejects.toThrow("The browser blocked the copy.");
  expect(document.querySelector("textarea")).toBeNull();
});

it("throws when the page has neither way to copy", async () => {
  await expect(copyText("x")).rejects.toThrow("The browser blocked the copy.");
});
