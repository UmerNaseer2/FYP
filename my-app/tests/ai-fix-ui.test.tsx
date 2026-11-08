/** @jest-environment jsdom */
// The AI panels after the review fixes.
//
//   - An answer that comes back after the screen moved on (another resetKey, a
//     newer question) is thrown away, and its request is stopped (U28).
//   - The AI status follows the organization, is read again after an Admin
//     saves the AI tab, and a failed read is not kept (U29).
//   - Every answer carries the same label and names its model (U30).
//   - When AI is off for this person, the panel says why in plain words (U31).
//   - The Compare and drift panels draw their graded items with one RiskRow (U60).
//
// The routes and the shared limits are in tests/ai-fix-ui.test.ts.

import "@testing-library/jest-dom";
import { act, fireEvent, render as renderWithoutOrg, screen } from "@testing-library/react";
import { OrgProvider } from "@/components/OrgProvider";
import { AiPanel, AI_SUGGESTION_LABEL, resetAiStatus } from "@/components/studio/AiPanel";
import { RiskRow } from "@/components/studio/CompareSummaryPanel";
import type { SummaryLevel } from "@/lib/ai/features/compare-summary-view";
import { apiFetch } from "@/lib/api-fetch";
import { ORG_HEADER } from "@/lib/org-slug";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  render,
  resetPageState,
  setAccessError,
  setRoutes,
  setUser,
  type FetchRoute,
} from "./helpers/render-page";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

const FEATURES = {
  "compare-summary": true,
  "migration-review": true,
  "drift-explain": true,
  "drift-oneliner": true,
  "sql-generate": true,
};
const ON = { configured: true, service: "Test AI", enabled: true, features: FEATURES };
const SWITCHED_OFF = { ...ON, enabled: false };

const META = { callId: 7, model: "test-model-1", saved: false, ms: 1500, retries: 0, inputTokens: 1, outputTokens: 1 };

type Note = { text: string };
const isNote = (value: unknown): value is Note =>
  typeof value === "object" && value !== null && typeof (value as Note).text === "string";

/** The requests each question was sent with, in order. */
let asked: { key: string | null; signal: AbortSignal | undefined }[] = [];

/** Answers each question with the resetKey it was asked under. */
const askRoute = (meta: typeof META = META): FetchRoute => ({
  match: "/api/test/ask",
  method: "POST",
  body: (url: string, init?: RequestInit) => {
    const key = new URL(url, "http://localhost").searchParams.get("key");
    asked.push({ key, signal: init?.signal ?? undefined });
    return { answer: { text: `Answer for ${key}.` }, meta };
  },
});

const statusRoute = (body: unknown): FetchRoute => ({ match: "/api/ai/status", body });

function Panel({ resetKey }: { resetKey?: string }) {
  return (
    <AiPanel
      feature="compare-summary"
      title="Summary"
      blurb="Ask for a summary."
      askLabel="Ask"
      ask={(signal) => apiFetch(`/api/test/ask?key=${resetKey}`, { method: "POST", signal })}
      isAnswer={isNote}
      resetKey={resetKey}
    >
      {(answer) => <p>{answer.text}</p>}
    </AiPanel>
  );
}

function inOrg(slug: string, ui: React.ReactElement) {
  return (
    <OrgProvider slug={slug} name={slug}>
      {ui}
    </OrgProvider>
  );
}

const statusCalls = () => fetchCalls.filter((call) => call.url.includes("/api/ai/status")).length;

beforeEach(() => {
  resetPageState();
  resetAiStatus();
  asked = [];
});

afterEach(() => {
  window.history.pushState({}, "", "/");
});

describe("an answer the screen no longer waits for (U28)", () => {
  test("is dropped, and its request stopped, when the resetKey changes", async () => {
    setRoutes([statusRoute(ON), askRoute()]);
    const release = holdNext("/api/test/ask");
    const { rerender } = render(<Panel resetKey="a" />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask" }));
    expect(await screen.findByText(/Asking the AI/)).toBeInTheDocument();

    rerender(<Panel resetKey="b" />);
    expect(asked[0].signal?.aborted).toBe(true);
    release();
    await flushAsync();

    expect(screen.queryByText("Answer for a.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask" })).toBeInTheDocument();
  });

  test("loses to a newer question on the new resetKey", async () => {
    setRoutes([statusRoute(ON), askRoute()]);
    const release = holdNext("key=a");
    const { rerender } = render(<Panel resetKey="a" />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask" }));
    rerender(<Panel resetKey="b" />);
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Answer for b.")).toBeInTheDocument();

    release();
    await flushAsync();
    expect(screen.queryByText("Answer for a.")).not.toBeInTheDocument();
    expect(screen.getByText("Answer for b.")).toBeInTheDocument();
  });

  test("is stopped when the panel leaves the screen", async () => {
    setRoutes([statusRoute(ON), askRoute()]);
    holdNext("/api/test/ask");
    const { unmount } = render(<Panel resetKey="a" />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask" }));
    await flushAsync();
    unmount();
    expect(asked[0].signal?.aborted).toBe(true);
  });
});

describe("the AI status (U29)", () => {
  test("is read again for another organization", async () => {
    // Each organization's status is answered from the header apiFetch sends.
    setRoutes([
      {
        match: "/api/ai/status",
        body: (_url: string, init?: RequestInit) =>
          new Headers(init?.headers).get(ORG_HEADER) === "acme" ? ON : SWITCHED_OFF,
      },
    ]);
    window.history.pushState({}, "", "/acme/compare");
    const { rerender } = renderWithoutOrg(inOrg("acme", <Panel />));
    expect(await screen.findByRole("button", { name: "Ask" })).toBeInTheDocument();

    window.history.pushState({}, "", "/globex/compare");
    rerender(inOrg("globex", <Panel />));
    expect(await screen.findByText(/AI is switched off for this organization/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask" })).not.toBeInTheDocument();
    expect(statusCalls()).toBe(2);
  });

  test("is not kept when it could not be read", async () => {
    setRoutes([{ match: "/api/ai/status", networkError: true }]);
    const first = render(<Panel />);
    expect(await screen.findByText(/Could not check whether AI is on here/)).toBeInTheDocument();
    first.unmount();

    setRoutes([statusRoute(ON)]);
    render(<Panel />);
    expect(await screen.findByRole("button", { name: "Ask" })).toBeInTheDocument();
    expect(statusCalls()).toBe(2);
  });

  test("is read again after resetAiStatus, the call the Admin AI tab makes on save", async () => {
    setRoutes([statusRoute(ON)]);
    render(<Panel />);
    expect(await screen.findByRole("button", { name: "Ask" })).toBeInTheDocument();

    setRoutes([statusRoute(SWITCHED_OFF)]);
    act(() => resetAiStatus());
    expect(await screen.findByText(/AI is switched off for this organization/)).toBeInTheDocument();
    expect(statusCalls()).toBe(2);
  });

  test("is shared by the panels on one page", async () => {
    setRoutes([statusRoute(ON)]);
    render(
      <>
        <Panel resetKey="a" />
        <Panel resetKey="b" />
      </>
    );
    expect(await screen.findAllByRole("button", { name: "Ask" })).toHaveLength(2);
    expect(statusCalls()).toBe(1);
  });
});

describe("an answer's label (U30)", () => {
  test("names the model of a fresh answer", async () => {
    setRoutes([statusRoute(ON), askRoute()]);
    render(<Panel resetKey="a" />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Answer for a.")).toBeInTheDocument();
    expect(screen.getByText("AI suggestion, check before use")).toBeInTheDocument();
    expect(screen.getByText(/test-model-1, 1\.5 s\./)).toBeInTheDocument();
  });

  test("names the model of a saved answer too", async () => {
    setRoutes([statusRoute(ON), askRoute({ ...META, callId: null, saved: true, ms: 0 })]);
    render(<Panel resetKey="a" />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Answer for a.")).toBeInTheDocument();
    expect(screen.getByText(AI_SUGGESTION_LABEL)).toBeInTheDocument();
    expect(screen.getByText(/test-model-1, a saved answer for the same question/)).toBeInTheDocument();
  });

  test("is the wording the chat uses", () => {
    expect(AI_SUGGESTION_LABEL).toBe("AI suggestion, check before use");
  });
});

describe("why AI is off (U31)", () => {
  test("a role without AI is told so, with a way to ask for it", async () => {
    setUser("viewer");
    setRoutes([statusRoute(ON)]);
    render(<Panel />);
    expect(await screen.findByText(/can't use AI assistance/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ask for it" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask" })).not.toBeInTheDocument();
    // The role alone decides it, so the status is not asked for.
    expect(statusCalls()).toBe(0);
  });

  test("a role that could not be read is told to reload", async () => {
    setAccessError();
    setRoutes([statusRoute(ON)]);
    render(<Panel />);
    expect(await screen.findByText(/Could not check what your role may do/)).toBeInTheDocument();
  });

  test.each([
    ["AI is not set up", { ...ON, configured: false }, "AI is not set up on this server."],
    [
      "AI is switched off",
      SWITCHED_OFF,
      "AI is switched off for this organization. An Admin can switch it on in Admin, AI.",
    ],
    [
      "the feature is switched off",
      { ...ON, features: { ...FEATURES, "compare-summary": false } },
      "Compare change summary is switched off for this organization. An Admin can switch it on in Admin, AI.",
    ],
  ])("%s", async (_name, status, reason) => {
    setRoutes([statusRoute(status)]);
    render(<Panel />);
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Ask for it" })).not.toBeInTheDocument();
  });
});

describe("RiskRow, shared by the Compare and drift panels (U60)", () => {
  const item = {
    title: "Drop `books`",
    changes: ["C1"],
    level: "breaking" as SummaryLevel,
    why: "Orders read it.",
    affects: ["order_lines", "book_view"],
  };

  test("draws the grade, the title, why, what uses it and the cited change", () => {
    const { container } = renderWithoutOrg(
      <ul>
        <RiskRow item={item} cited={{ C1: { label: "Table books removed", severity: "breaking" } }} />
      </ul>
    );
    expect(screen.getByText("Breaking")).toBeInTheDocument();
    expect(container.querySelector("code")?.textContent).toBe("books");
    expect(screen.getByText("Orders read it.")).toBeInTheDocument();
    expect(screen.getByText(/Used by:/)).toBeInTheDocument();
    const used = [...container.querySelectorAll("p code")].map((node) => node.textContent);
    expect(used).toEqual(["order_lines", "book_view"]);
    expect(screen.getByText("Table books removed")).toBeInTheDocument();
  });

  test("still draws a grade it does not know", () => {
    renderWithoutOrg(
      <ul>
        <RiskRow item={{ ...item, level: "odd" as SummaryLevel, affects: [] }} cited={{}} />
      </ul>
    );
    expect(screen.getByText("odd")).toBeInTheDocument();
    expect(screen.queryByText(/Used by:/)).not.toBeInTheDocument();
  });
});
