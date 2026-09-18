/** @jest-environment jsdom */

/**
 * AlertThresholds: the form behind spec feature 10, "allow custom alert
 * thresholds for performance issues".
 *
 * Three of its rules are the reason it is worth a suite of its own:
 *
 *   A rule that is switched off is still validated. It is still about to be
 *   stored, and an impossible number stored under an off rule means switching
 *   it on later silently does nothing — the worst kind of alert, one somebody
 *   believes is watching.
 *
 *   A ratio is stored 0–1 and shown as a percentage. Typing 95 has to send
 *   0.95; sending 95 would be refused by a server whose maximum is 1, and
 *   storing it would be a rule that can never fire.
 *
 *   After a save the boxes are re-seeded from what came back, not from what
 *   was sent, so the form shows what is stored rather than what was hoped for.
 *
 *   An empty box is not a zero. Number("") is 0, which three of these rules
 *   accept, so a cleared box used to save itself as a rule that either never
 *   fires or fires on everything. Writing this suite found that, and found
 *   that a first read which failed sat on the skeleton for ever instead of
 *   saying why; both are fixed in the component alongside these tests.
 *
 * What is NOT here:
 *  - The ranges themselves. lib/perf-thresholds decides that a query time is
 *    1–3,600,000 ms; this suite only checks that the form refuses what
 *    validateThreshold refuses and says so in that function's own words. Worth
 *    knowing: validateThreshold has no unit suite of its own yet, so a wrong
 *    range in that table would not be caught here or anywhere else.
 *  - The endpoint. /api/performance/thresholds reads and writes the rows; here
 *    it is a canned reply.
 *  - Whether a stored rule ever fires. evaluateThresholds does that, and
 *    tests/db-health.test.ts covers it.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AlertThresholds } from "@/components/studio/AlertThresholds";
import type { PerfTarget } from "@/components/studio/PerfTargetPicker";
import {
  THRESHOLDS,
  THRESHOLD_KEYS,
  defaultSettings,
  type ThresholdSetting,
} from "@/lib/perf-thresholds";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  resetPageState,
  setRoutes,
  setUser,
} from "./helpers/render-page";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

/* ----------------------------------------------------------------- fixtures */

const TARGET: PerfTarget = {
  connectionId: "7",
  connectionName: "Prod shop",
  schema: "public",
};

/** What the endpoint sends: every key, with the definitions the form draws from. */
const view = (settings: ThresholdSetting[] = defaultSettings(), over = {}) => ({
  connectionName: "Prod shop",
  schema: "public",
  settings,
  definitions: THRESHOLDS,
  ...over,
});

/** The stored settings with one key changed. */
const withSetting = (key: string, value: number, enabled: boolean): ThresholdSetting[] =>
  defaultSettings().map((s) => (s.key === key ? { ...s, value, enabled } : s));

const answers = (body: unknown, status = 200, method?: string) => [
  { match: "/api/performance/thresholds", status, body, ...(method ? { method } : {}) },
];

/* ------------------------------------------------------------------ helpers */

function show(target: PerfTarget | null = TARGET) {
  return render(<AlertThresholds target={target} />);
}

/** The number box for a rule, by the words beside it. */
const box = (label: string) => screen.getByRole("spinbutton", { name: label });
/** The switch for a rule. */
const check = (label: string) => screen.getByRole("checkbox", { name: label });
const saveButton = () => screen.getByRole("button", { name: /^(Save thresholds|Saving)/ });
const loaded = () => screen.findByRole("checkbox", { name: "Query slower than" });
const puts = () => fetchCalls.filter((call) => call.method === "PUT");
const sentSettings = () => JSON.parse(puts()[0].body ?? "{}").settings;

beforeEach(() => {
  resetPageState();
  setUser("editor");
});

afterEach(() => cleanup());

/* -------------------------------------------------------------------- tests */

describe("before there is a schema to set rules for", () => {
  it("says what to pick, and asks the server nothing", () => {
    show(null);

    expect(
      screen.getByText(/Choose a PostgreSQL connection and a schema above/)
    ).toBeInTheDocument();
    expect(fetchCalls).toHaveLength(0);
  });

  it("asks per connection and schema, because one number cannot be right for both", async () => {
    setRoutes(answers(view()));
    show();
    await loaded();

    expect(fetchCalls[0].url).toBe(
      "/api/performance/thresholds?connectionId=7&schema=public"
    );
  });

  it("shows a skeleton rather than an empty form while it reads", () => {
    setRoutes(answers(view()));
    const release = holdNext("/api/performance/thresholds");
    show();

    expect(screen.queryByRole("checkbox", { name: "Query slower than" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
    release();
  });
});

describe("what the form says about itself", () => {
  it("counts what is actually switched on", async () => {
    setRoutes(answers(view(withSetting("query_exec_ms", 500, true))));
    show();
    await loaded();

    expect(screen.getByText("1 switched on")).toBeInTheDocument();
  });

  it("says none are on when none are, which is where every schema starts", async () => {
    setRoutes(answers(view()));
    show();
    await loaded();

    expect(screen.getByText("None switched on")).toBeInTheDocument();
  });

  it("does not claim the suggestions were chosen for this database", async () => {
    setRoutes(answers(view()));
    show();
    await loaded();

    expect(
      screen.getByText(/this app has not looked at your database and decided what/)
    ).toBeInTheDocument();
  });

  it("says of a rule that is off that it is never checked", async () => {
    setRoutes(answers(view(withSetting("query_exec_ms", 500, true))));
    show();
    await loaded();

    const rows = screen.getAllByText(/This rule is off, so it is never checked\./);
    expect(rows).toHaveLength(THRESHOLD_KEYS.length - 1);
  });

  it("drops that line the moment the rule is switched on", async () => {
    setRoutes(answers(view()));
    show();
    await loaded();

    fireEvent.click(check("Query slower than"));

    expect(screen.getAllByText(/This rule is off, so it is never checked\./)).toHaveLength(
      THRESHOLD_KEYS.length - 1
    );
  });
});

describe("a ratio, stored as a fraction and read as a percentage", () => {
  it("shows the stored fraction as a percentage", async () => {
    setRoutes(answers(view(withSetting("cache_hit_ratio", 0.9, true))));
    show();
    await loaded();

    expect(box("Cache hit ratio below")).toHaveValue(90);
  });

  it("sends back a fraction, which is the only thing the server accepts", async () => {
    // The guard: the server's maximum for this rule is 1, so sending 95 would
    // be refused, and storing it would be a rule that can never fire.
    setRoutes(answers(view()));
    show();
    await loaded();

    fireEvent.change(box("Cache hit ratio below"), { target: { value: "95" } });
    fireEvent.click(saveButton());
    await flushAsync();

    const sent = sentSettings().find((s: ThresholdSetting) => s.key === "cache_hit_ratio");
    expect(sent.value).toBe(0.95);
  });

  it("leaves the plain rules alone", async () => {
    setRoutes(answers(view()));
    show();
    await loaded();

    fireEvent.change(box("Query slower than"), { target: { value: "250" } });
    fireEvent.click(saveButton());
    await flushAsync();

    const sent = sentSettings().find((s: ThresholdSetting) => s.key === "query_exec_ms");
    expect(sent.value).toBe(250);
  });
});

describe("a number the server would refuse", () => {
  it("says so in the words the server would have used", async () => {
    setRoutes(answers(view()));
    show();
    await loaded();

    fireEvent.change(box("Query slower than"), { target: { value: "0" } });

    expect(
      screen.getByText("Query slower than has to be between 1 and 3600000.")
    ).toBeInTheDocument();
  });

  it("holds the save back until it is fixed", async () => {
    setRoutes(answers(view()));
    show();
    await loaded();

    fireEvent.change(box("Query slower than"), { target: { value: "0" } });

    expect(saveButton()).toBeDisabled();
    expect(screen.getByText("Fix the numbers above first.")).toBeInTheDocument();

    fireEvent.change(box("Query slower than"), { target: { value: "250" } });
    expect(saveButton()).toBeEnabled();
  });

  it("catches an empty box rather than reading it as a zero", async () => {
    // The guard: Number("") is 0, and this rule's minimum is 0, so an emptied
    // box passed validation and saved as "alert when a query scores below 0" —
    // a rule that can never fire, stored without a word said.
    setRoutes(answers(view()));
    show();
    await loaded();

    fireEvent.change(box("Query scores below"), { target: { value: "" } });

    expect(screen.getByText("Query scores below needs a number.")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("leaves an emptied percentage box empty instead of turning it into 0%", async () => {
    // The same zero, the other way round: "dead rows above 0%" fires on
    // everything. The box has to stay empty for the check above to see it.
    setRoutes(answers(view()));
    show();
    await loaded();

    fireEvent.change(box("Dead rows above"), { target: { value: "" } });

    expect(box("Dead rows above")).toHaveValue(null);
    expect(screen.getByText("Dead rows above needs a number.")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("checks a rule that is switched off just as hard", async () => {
    // The guard: an impossible number stored under an off rule means switching
    // it on later silently does nothing.
    setRoutes(answers(view()));
    show();
    await loaded();

    expect(check("Dead rows above")).not.toBeChecked();
    fireEvent.change(box("Dead rows above"), { target: { value: "150" } });

    expect(screen.getByText("Dead rows above has to be between 0% and 100%.")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });
});

describe("saving", () => {
  it("sends every rule, not only the ones that changed", async () => {
    setRoutes(answers(view()));
    show();
    await loaded();

    fireEvent.click(check("Query slower than"));
    fireEvent.click(saveButton());
    await flushAsync();

    expect(puts()).toHaveLength(1);
    expect(JSON.parse(puts()[0].body ?? "{}")).toMatchObject({
      connectionId: "7",
      schema: "public",
    });
    expect(sentSettings().map((s: ThresholdSetting) => s.key)).toEqual([...THRESHOLD_KEYS]);
    expect(sentSettings()[0]).toEqual({ key: "query_exec_ms", value: 1000, enabled: true });
  });

  it("shows what came back rather than what was sent", async () => {
    // The guard: if the server stores something other than what was typed, the
    // form has to say so — otherwise it claims a rule nobody stored.
    setRoutes([
      { match: "/api/performance/thresholds", method: "GET", body: view() },
      {
        match: "/api/performance/thresholds",
        method: "PUT",
        body: view(withSetting("query_exec_ms", 800, true)),
      },
    ]);
    show();
    await loaded();

    fireEvent.change(box("Query slower than"), { target: { value: "250" } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(box("Query slower than")).toHaveValue(800);
    expect(screen.getByText("Saved.")).toBeInTheDocument();
    expect(screen.getByText("1 switched on")).toBeInTheDocument();
  });

  it("stops saying Saved as soon as something is changed again", async () => {
    setRoutes(answers(view()));
    show();
    await loaded();

    fireEvent.click(saveButton());
    await screen.findByText("Saved.");

    fireEvent.change(box("Query slower than"), { target: { value: "250" } });

    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
  });

  it("says what the server said when it refuses, and keeps the typed numbers", async () => {
    setRoutes([
      { match: "/api/performance/thresholds", method: "GET", body: view() },
      {
        match: "/api/performance/thresholds",
        method: "PUT",
        status: 403,
        body: { error: "You need the editor role to change alert thresholds." },
      },
    ]);
    show();
    await loaded();

    fireEvent.change(box("Query slower than"), { target: { value: "250" } });
    fireEvent.click(saveButton());
    await flushAsync();

    expect(screen.getByText("The thresholds were not saved")).toBeInTheDocument();
    expect(
      screen.getByText("You need the editor role to change alert thresholds.")
    ).toBeInTheDocument();
    expect(box("Query slower than")).toHaveValue(250);
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
  });

  it("says something when the network drops rather than looking saved", async () => {
    setRoutes([
      { match: "/api/performance/thresholds", method: "GET", body: view() },
      { match: "/api/performance/thresholds", method: "PUT", networkError: true },
    ]);
    show();
    await loaded();

    fireEvent.click(saveButton());
    await flushAsync();

    expect(
      screen.getByText("Could not reach the server to save the thresholds.")
    ).toBeInTheDocument();
  });
});

describe("who may change them", () => {
  it("lets a viewer read the rules but not touch them", async () => {
    setUser("viewer");
    setRoutes(answers(view()));
    show();
    await loaded();

    expect(box("Query slower than")).toBeDisabled();
    expect(check("Query slower than")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
  });

  it("says why, because the rules are not the reader's alone", async () => {
    setUser("viewer");
    setRoutes(answers(view()));
    show();
    await loaded();

    expect(
      screen.getByText(/Changing what the app alerts on changes it for everybody/)
    ).toBeInTheDocument();
  });
});

describe("when the rules cannot be read", () => {
  // Worth its own tests because the message used to be out of reach: the
  // skeleton waited for a draft that a failed read never produces, so a first
  // load that failed sat loading for ever instead of saying why.
  it("says what the server said", async () => {
    setRoutes(answers({ error: "That connection is not a PostgreSQL database." }, 400));
    show();

    expect(await screen.findByText("Could not read the alert thresholds")).toBeInTheDocument();
    expect(
      screen.getByText("That connection is not a PostgreSQL database.")
    ).toBeInTheDocument();
  });

  it("does not blame the network for an answer it could not read", async () => {
    // The guard: the shape used to blow up inside the form and land in the
    // catch below, which says the server was never reached — about a server
    // that answered.
    setRoutes(answers({ nothing: "useful" }));
    show();

    expect(
      await screen.findByText("The server answered, but not with the alert thresholds.")
    ).toBeInTheDocument();
  });

  it("says something when the server cannot be reached at all", async () => {
    setRoutes([{ match: "/api/performance/thresholds", networkError: true }]);
    show();

    expect(await screen.findByText("Could not reach the server.")).toBeInTheDocument();
  });
});

describe("changing the schema under the form", () => {
  it("goes back to the skeleton rather than showing the last schema's rules", async () => {
    setRoutes(answers(view(withSetting("query_exec_ms", 500, true))));
    const { rerender } = show();
    await loaded();

    const release = holdNext("/api/performance/thresholds");
    rerender(<AlertThresholds target={{ ...TARGET, schema: "sales" }} />);

    expect(screen.queryByRole("checkbox", { name: "Query slower than" })).not.toBeInTheDocument();
    release();
    await loaded();
  });

  it("does not let a late answer overwrite the schema now on screen", async () => {
    setRoutes(answers(view(withSetting("query_exec_ms", 500, true))));
    const { rerender } = show();
    await loaded();

    const releaseFirst = holdNext("/api/performance/thresholds");
    rerender(<AlertThresholds target={{ ...TARGET, schema: "sales" }} />);
    setRoutes(answers(view(withSetting("query_exec_ms", 250, true), { schema: "billing" })));
    rerender(<AlertThresholds target={{ ...TARGET, schema: "billing" }} />);
    await waitFor(() => expect(fetchCalls).toHaveLength(3));
    await loaded();
    expect(box("Query slower than")).toHaveValue(250);

    releaseFirst();
    await flushAsync();

    expect(box("Query slower than")).toHaveValue(250);
  });

  it("drops what was said about the last save", async () => {
    setRoutes(answers(view()));
    const { rerender } = show();
    await loaded();

    fireEvent.click(saveButton());
    await screen.findByText("Saved.");

    rerender(<AlertThresholds target={{ ...TARGET, schema: "sales" }} />);
    await loaded();

    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
  });
});
