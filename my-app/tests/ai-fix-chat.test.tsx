/** @jest-environment jsdom */
// The schema chat drawer after the review fixes.
//
//   - Every answer carries the AI suggestion label and names its model (U30).
//   - A draft the app could not place on a database says so, instead of
//     silently hiding the "Open in the Script Editor" button (U26).
//   - A question can be stopped, and leaving the page stops it too: the fetch
//     is aborted, so the server stops spending AI calls on it (U27).
//
// The server side of these fixes is tested in tests/ai-schema-chat.test.ts.

import "@testing-library/jest-dom";
import { fireEvent, screen } from "@testing-library/react";
import { SchemaChatButton } from "@/components/studio/SchemaChat";
import type { ChatAnswer } from "@/lib/ai/features/schema-chat-view";
import { flushAsync, holdNext, render, resetPageState, setRoutes, type FetchRoute } from "./helpers/render-page";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
// The chat is on for these tests. Everything else in AiPanel stays real,
// the shared label included.
jest.mock("../components/studio/AiPanel", () => ({
  ...jest.requireActual("../components/studio/AiPanel"),
  useAiFeature: () => true,
}));

const META = { callId: 7, model: "test-model-1", saved: false, ms: 1500, retries: 0, inputTokens: 1, outputTokens: 1 };

const ANSWER: ChatAnswer = {
  text: "The orders table has 3 columns.",
  sql: null,
  sqlProblems: [],
  unverifiedNames: [],
  toolsUsed: [{ name: "show_schema", ok: true }],
  target: null,
};

/** The signal each question was sent with, in order. */
let signals: (AbortSignal | undefined)[] = [];

function chatRoute(answer: ChatAnswer): FetchRoute {
  return {
    match: "/api/ai/chat",
    method: "POST",
    body: (_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return { answer, meta: META };
    },
  };
}

/** Open the drawer and ask one question. */
function ask(question = "What is in orders?") {
  fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

beforeEach(() => {
  resetPageState();
  signals = [];
});

describe("schema chat drawer", () => {
  it("labels every answer as an AI suggestion with the model's name (U30)", async () => {
    setRoutes([chatRoute(ANSWER)]);
    render(<SchemaChatButton />);
    ask();
    expect(await screen.findByText("AI suggestion, check before use, written by test-model-1.")).toBeInTheDocument();
    expect(screen.getByText("The orders table has 3 columns.")).toBeInTheDocument();
  });

  it("says so when a draft has no database to open it on (U26)", async () => {
    setRoutes([chatRoute({ ...ANSWER, sql: "ALTER TABLE orders ADD COLUMN note text;", target: null })]);
    render(<SchemaChatButton />);
    ask();
    expect(await screen.findByText(/could not tell which database this draft is for/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in the Script Editor" })).not.toBeInTheDocument();
  });

  it("does not show that note when the draft has a database", async () => {
    setRoutes([
      chatRoute({
        ...ANSWER,
        sql: "ALTER TABLE orders ADD COLUMN note text;",
        target: { connectionId: 1, schema: "public" },
      }),
    ]);
    render(<SchemaChatButton />);
    ask();
    expect(await screen.findByRole("button", { name: "Open in the Script Editor" })).toBeInTheDocument();
    expect(screen.queryByText(/could not tell which database/)).not.toBeInTheDocument();
  });

  it("Stop aborts the question, and its late answer is not shown (U27)", async () => {
    setRoutes([chatRoute(ANSWER)]);
    const release = holdNext("/api/ai/chat", "POST");
    render(<SchemaChatButton />);
    ask();
    await flushAsync();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeDefined();
    expect(signals[0]?.aborted).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.getByText("You stopped this question.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();

    // The test fetch ignores the signal, so the answer still arrives. The
    // drawer must drop it.
    release();
    await flushAsync();
    expect(screen.queryByText("The orders table has 3 columns.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("leaving the page aborts the question being asked (U27)", async () => {
    setRoutes([chatRoute(ANSWER)]);
    holdNext("/api/ai/chat", "POST");
    const { unmount } = render(<SchemaChatButton />);
    ask();
    await flushAsync();

    expect(signals[0]?.aborted).toBe(false);
    unmount();
    expect(signals[0]?.aborted).toBe(true);
  });
});
