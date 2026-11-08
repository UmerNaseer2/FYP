/** @jest-environment jsdom */
// The "Organization AI key" card on the Admin screen's AI tab
// (components/admin/AiKeyCard.tsx). fetch is a stand-in, so nothing leaves
// the test, and the key typed in is a made-up string.

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { AiKeyCard } from "@/components/admin/AiKeyCard";
import type { AiAdminView, AiKeyView } from "@/lib/ai/views";

const FAKE_KEY = "fake-test-key-not-real-0000";

const SETUP = { configured: true, service: "Google Gemini", models: { fast: "f", smart: "s" }, ownKey: false };

function view(over: Partial<AiAdminView> = {}): AiAdminView {
  return {
    setup: SETUP,
    serverSetup: SETUP,
    orgKey: null,
    canStoreKeys: true,
    enabled: false,
    features: [],
    updatedBy: null,
    updatedAt: null,
    usage: null,
    dailyLimit: 300,
    canUpdate: true,
    ...over,
  };
}

const SAVED: AiKeyView = {
  provider: "anthropic",
  service: "Anthropic Claude",
  hint: "0000",
  models: { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5" },
  setBy: "admin@example.com",
  setAt: "2026-11-08T00:00:00.000Z",
  readable: true,
};

/** The card with a parent that keeps the view, as the AI tab does. */
function Harness({ start, seen }: { start: AiAdminView; seen: AiAdminView[] }) {
  const [current, setCurrent] = useState(start);
  return (
    <AiKeyCard
      view={current}
      onChange={(next) => {
        seen.push(next);
        setCurrent(next);
      }}
    />
  );
}

let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

/** jsdom has no Response, and the card only reads ok, status and json(). */
function answer(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("with no key saved, it says AI uses the server's settings", () => {
  render(<Harness start={view()} seen={[]} />);
  expect(screen.getByRole("status")).toHaveTextContent("No key saved. AI uses the server's settings.");
  expect(screen.getByRole("button", { name: "Save key" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Remove key" })).not.toBeInTheDocument();
});

test("saving with no key typed asks for one and sends nothing", () => {
  render(<Harness start={view()} seen={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Paste the API key first.");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("saving sends the key once, then the page forgets it and shows only the hint", async () => {
  const seen: AiAdminView[] = [];
  render(<Harness start={view()} seen={seen} />);
  const keyBox = screen.getByLabelText("API key");
  expect(keyBox).toHaveAttribute("type", "password");
  fireEvent.change(keyBox, { target: { value: FAKE_KEY } });
  fireEvent.change(screen.getByLabelText("Model for reviews and explanations"), { target: { value: "claude-opus-5-5" } });

  answer(view({ orgKey: { ...SAVED, models: { ...SAVED.models, smart: "claude-opus-5-5" } } }));
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  await settle();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/admin/ai/key");
  expect(init.method).toBe("PUT");
  expect(JSON.parse(String(init.body))).toEqual({
    provider: "anthropic",
    apiKey: FAKE_KEY,
    modelFast: "",
    modelSmart: "claude-opus-5-5",
  });

  expect(seen).toHaveLength(1);
  expect(screen.getByLabelText("API key")).toHaveValue("");
  expect(screen.getByRole("status")).toHaveTextContent("A key for Anthropic Claude is saved, ending in 0000.");
  expect(document.body.textContent).not.toContain(FAKE_KEY);
  expect(screen.getByRole("button", { name: "Replace key" })).toBeInTheDocument();
  // The Admin's own model name stays in its box; the usual one is the placeholder.
  expect(screen.getByLabelText("Model for reviews and explanations")).toHaveValue("claude-opus-5-5");
  expect(screen.getByLabelText("Model for short summaries")).toHaveValue("");
});

test("a refused save shows the server's words and keeps what was typed", async () => {
  const seen: AiAdminView[] = [];
  render(<Harness start={view()} seen={seen} />);
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "fake key" } });
  answer({ error: "An API key has no spaces or line breaks in it." }, 400);
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  await settle();
  expect(screen.getByRole("alert")).toHaveTextContent("An API key has no spaces or line breaks in it.");
  expect(screen.getByLabelText("API key")).toHaveValue("fake key");
  expect(seen).toHaveLength(0);
});

test("a network error changes nothing", async () => {
  render(<Harness start={view()} seen={[]} />);
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: FAKE_KEY } });
  fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  await settle();
  expect(screen.getByRole("alert")).toHaveTextContent("Network error. Nothing was changed.");
});

test("removing asks first, then sends a DELETE and goes back to the server's settings", async () => {
  const seen: AiAdminView[] = [];
  render(<Harness start={view({ orgKey: SAVED })} seen={seen} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByText("Remove the organization's AI key?")).toBeInTheDocument();

  answer({ ...view(), removed: true });
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await settle();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/admin/ai/key");
  expect(init.method).toBe("DELETE");
  expect(init.body).toBeUndefined();
  expect(seen).toHaveLength(1);
  expect(screen.getByRole("status")).toHaveTextContent("No key saved. AI uses the server's settings.");
});

test("a saved key this server cannot open is called out", () => {
  render(<Harness start={view({ orgKey: { ...SAVED, readable: false } })} seen={[]} />);
  expect(screen.getByRole("alert")).toHaveTextContent("The saved key can't be read on this server");
});

test("someone who is not an Admin sees the key's service and hint, but no form", () => {
  render(<Harness start={view({ orgKey: SAVED, canUpdate: false })} seen={[]} />);
  expect(screen.getByRole("status")).toHaveTextContent("ending in 0000");
  expect(screen.getByText("Only an Admin can save or remove the key.")).toBeInTheDocument();
  expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Replace key" })).not.toBeInTheDocument();
});

test("a server with no encryption key locks the form and says why", () => {
  render(<Harness start={view({ canStoreKeys: false })} seen={[]} />);
  expect(screen.getByText(/This server has no encryption key/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  expect(screen.getByLabelText("API key")).toHaveAttribute("readonly");
});
