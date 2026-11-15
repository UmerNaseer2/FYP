/** @jest-environment jsdom */

// The trial notice (components/studio/TrialBar.tsx): one line and a "Trial
// options" menu. Reset trial asks first, then posts to /api/trial/reset, and
// says so plainly when that fails. Which people see the strip and the Reset
// item is in tests/component-studio-shell.test.tsx.

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { TrialBar } from "@/components/studio/TrialBar";
import { START_TOUR_EVENT } from "@/lib/tour";

const realFetch = globalThis.fetch;
let calls: { url: string; method?: string }[] = [];

function answer(status: number, body: unknown) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as typeof fetch;
}

// jsdom cannot navigate and will not let location.reload be replaced, so a
// reload shows up as its "Not implemented: navigation" note on the console
// (as in tests/component-view-as-switcher.test.tsx).
let consoleError: jest.SpyInstance;
const reloads = () =>
  consoleError.mock.calls.filter(([first]) =>
    String((first as { message?: unknown } | null)?.message ?? first).includes("Not implemented: navigation")
  ).length;

beforeEach(() => {
  calls = [];
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = realFetch;
  consoleError.mockRestore();
});

/** Open the "Trial options" menu and pick Reset trial from it. */
function pickReset() {
  fireEvent.click(screen.getByRole("button", { name: "Trial options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Reset trial" }));
}

function pressReset() {
  pickReset();
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("The GitHub token and AI settings stay.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Reset trial" }));
}

test("asks before it resets anything", () => {
  answer(200, { reset: true });
  render(<TrialBar isAdmin />);
  pickReset();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(calls).toEqual([]);
});

test("posts the reset once the Admin says yes", async () => {
  answer(200, { reset: true });
  render(<TrialBar isAdmin />);
  pressReset();
  await waitFor(() => expect(reloads()).toBe(1));
  expect(calls).toEqual([{ url: "/api/trial/reset", method: "POST" }]);
});

test("shows the server's words when the reset is refused", async () => {
  answer(403, { error: "Only the Trial Admin can reset the trial." });
  render(<TrialBar isAdmin />);
  pressReset();
  expect(await screen.findByText("Only the Trial Admin can reset the trial.")).toBeInTheDocument();
  expect(reloads()).toBe(0);
});

test("says so when the server cannot be reached", async () => {
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  render(<TrialBar isAdmin />);
  pressReset();
  expect(await screen.findByText("Could not reach the server. Try again.")).toBeInTheDocument();
});

test("has no Reset trial for anyone but the Admin", () => {
  render(<TrialBar isAdmin={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Trial options" }));
  expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Take the tour"]);
});

test("says it in one line", () => {
  render(<TrialBar isAdmin={false} />);
  expect(screen.getByRole("note")).toHaveTextContent("Shared trial. Others see what you change.");
});

test("keeps its menu shut until it is asked for, and Escape shuts it again", () => {
  render(<TrialBar isAdmin />);
  const button = screen.getByRole("button", { name: "Trial options" });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(button);
  const menu = screen.getByRole("menu", { name: "Trial options" });
  expect(within(menu).getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
    "Take the tour",
    "Reset trial",
  ]);
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(button).toHaveFocus();
});

test("Take the tour asks the tour to start", () => {
  const heard = jest.fn();
  window.addEventListener(START_TOUR_EVENT, heard);
  try {
    render(<TrialBar isAdmin={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Trial options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Take the tour" }));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  } finally {
    window.removeEventListener(START_TOUR_EVENT, heard);
  }
});
