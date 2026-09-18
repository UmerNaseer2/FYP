/** @jest-environment jsdom */

/**
 * The shared "check drift now" island: one button, three screens.
 *
 * It looks like the smallest thing in the app and is not, because the check it
 * starts writes to the same rows other buttons beside it write to. Re-baselining
 * REPLACES the baseline this check reads; run them together and the recorded
 * answer comes down to which request finished first. Neither button can see the
 * other, so this one reports upward — onBusyChange(true) when it starts,
 * onBusyChange(false) when it stops — and accepts `disabled` in return. The
 * half that is easy to get wrong is the SECOND call: a check that fails and
 * never says it stopped leaves the whole bar around it dead until a reload.
 *
 * The other decision is what counts as a failure. A 200 carrying a status is a
 * result, including "unreachable" — a database that could not be reached is a
 * finding about that database, not about the request, and the screen around
 * this button is what says so. A 200 carrying no status at all is not a result,
 * which is what the second half of the guard is for: an expired session or a
 * proxy answering with an HTML page arrives as exactly that, and reporting it as
 * a successful check would tell the screen to redraw the old answer as if it
 * were new.
 *
 * What is NOT here:
 *  - The mutual block between this button and the bar that hosts it, from the
 *    bar's side: tests/component-drift-resolution-bar.test.tsx has both
 *    directions of it. What is checked here is the signal this button sends,
 *    not what a caller does with it.
 *  - POST /api/lineage/drift itself — the role gate, runDriftCheck, the
 *    drift_event it writes. The route has no suite of its own; the answers
 *    below are written out by hand in the shapes it returns.
 *  - The screens that host it: tests/page-schema-detail.test.tsx, which renders
 *    it twice directly, and tests/page-drift.test.tsx, which reaches it through
 *    the resolution bar. The deploy screen calls the same route itself, without
 *    this button — that is tests/page-deploy.test.tsx.
 *  - The `!res.ok` half of that guard on its own. Every refusal this route can
 *    send carries a reason and no result, so the `!data?.status` half already
 *    rejects all of them, and no answer the route can produce tells the two
 *    halves apart. What is checked below is that the pair turns away both
 *    shapes; a fixture invented to separate them would not be an answer the
 *    server could give.
 *  - components/ui/Button, which has no suite of its own. The variant is read
 *    here as the class it asks for, which is all jsdom can see — no stylesheet
 *    is applied, so nothing about how either variant LOOKS is checked anywhere.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import { RecheckDriftButton } from "@/components/studio/RecheckDriftButton";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  resetPageState,
  routerCalls,
  setRoutes,
  type FetchRoute,
} from "./helpers/render-page";

const SCHEMA_ID = 7;
const CHECKING = "Checking…"; // U+2026, not three dots — a retyped copy should fail

/**
 * A finished check, in the shape app/api/lineage/drift returns it. Only
 * `status` is read here; the rest is written out so the fixture is an answer
 * the route could actually produce.
 */
const CHECKED: FetchRoute = {
  match: "/api/lineage/drift",
  method: "POST",
  body: {
    trackedSchemaId: SCHEMA_ID,
    status: "in_sync",
    summary: "Matches the baseline.",
    counts: {
      tablesAdded: 0,
      tablesRemoved: 0,
      tablesChanged: 0,
      constraintsChanged: 0,
      objectsChanged: 0,
    },
    expectedVersion: "1.2.0",
    checkedAt: "2026-09-14T08:05:00.000Z",
    report: null,
  },
};

/** The same route when the database itself could not be opened. */
const UNREACHABLE: FetchRoute = {
  match: "/api/lineage/drift",
  method: "POST",
  body: {
    trackedSchemaId: SCHEMA_ID,
    status: "unreachable",
    summary: "Could not connect to the database.",
    counts: null,
    expectedVersion: "1.2.0",
    checkedAt: "2026-09-14T08:05:00.000Z",
    report: null,
  },
};

// Two refusals in the route's own words.
const MISSING: FetchRoute = {
  match: "/api/lineage/drift",
  method: "POST",
  status: 404,
  body: { error: "Tracked schema not found." },
};
const NO_BASELINE: FetchRoute = {
  match: "/api/lineage/drift",
  method: "POST",
  status: 409,
  body: { error: "This tracked schema has no baseline snapshot to compare against." },
};

beforeEach(() => resetPageState());

type Overrides = Partial<Parameters<typeof RecheckDriftButton>[0]>;

/*
  onDone is required on the component, so the helper always has one. Tests that
  care about it pass their own; `defaultDone` is for the rest, and is reset in
  beforeEach so a leftover count cannot travel between tests.
*/
let defaultDone: jest.Mock;
beforeEach(() => {
  defaultDone = jest.fn();
});

function button(over: Overrides = {}) {
  return render(
    <RecheckDriftButton trackedSchemaId={SCHEMA_ID} onDone={defaultDone} {...over} />
  );
}

const check = (name = "Check drift now") => screen.getByRole("button", { name });
const sent = () => JSON.parse(String(fetchCalls[0].body));

describe("before you press it", () => {
  test("names itself for what pressing it does", () => {
    button();
    expect(check()).toBeEnabled();
  });

  test("takes the wording its caller gives it instead", () => {
    // The drift hero calls it "Re-check drift" because the screen it sits on
    // has already run one; the schema page calls it something else again.
    button({ label: "Re-check drift" });
    expect(check("Re-check drift")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check drift now" })).toBeNull();
  });

  test("stands back as a secondary button unless asked otherwise", () => {
    button();
    expect(check()).toHaveClass("btn-secondary");
  });

  test("leads when a caller asks it to", () => {
    button({ variant: "primary" });
    expect(check()).toHaveClass("btn-primary");
    expect(check()).not.toHaveClass("btn-secondary");
  });

  test("has nothing to report yet", () => {
    button();
    expect(screen.queryByText(/failed|Network error/)).toBeNull();
  });
});

describe("running a check", () => {
  test("asks the server to check this schema", async () => {
    setRoutes([CHECKED]);
    button();

    fireEvent.click(check());
    await flushAsync();

    expect(fetchCalls[0].url).toBe("/api/lineage/drift");
    expect(fetchCalls[0].method).toBe("POST");
    expect(sent()).toEqual({ trackedSchemaId: SCHEMA_ID });
  });

  test("asks once", async () => {
    setRoutes([CHECKED]);
    button();

    fireEvent.click(check());
    await flushAsync();

    expect(fetchCalls).toHaveLength(1);
  });

  test("says it is checking, and stops offering to start another", async () => {
    setRoutes([CHECKED]);
    const release = holdNext("/api/lineage/drift", "POST");
    button();

    fireEvent.click(check());
    expect(check(CHECKING)).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Check drift now" })).toBeNull();

    release();
    await flushAsync();
  });

  test("tells its caller it has started before the answer arrives", async () => {
    // The whole point of the signal: the caller has to shut its own writes
    // while this runs, and it cannot wait for the result to learn that.
    const onBusyChange = jest.fn();
    setRoutes([CHECKED]);
    const release = holdNext("/api/lineage/drift", "POST");
    button({ onBusyChange });

    fireEvent.click(check());
    expect(onBusyChange.mock.calls).toEqual([[true]]);

    release();
    await flushAsync();
  });

  test("offers itself again once the answer is in", async () => {
    setRoutes([CHECKED]);
    button();

    fireEvent.click(check());
    await flushAsync();

    expect(check()).toBeEnabled();
  });

  test("tells its caller it has stopped", async () => {
    const onBusyChange = jest.fn();
    setRoutes([CHECKED]);
    button({ onBusyChange });

    fireEvent.click(check());
    await flushAsync();

    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  test("hands back to the caller, which is the only way it can report", async () => {
    // There is no router.refresh() fallback any more. Every screen that shows
    // drift holds its data in state, where a router refresh repaints nothing —
    // so a button that quietly took that path on a missing onDone looked like
    // it had worked and had not. onDone is required instead.
    const onDone = jest.fn();
    setRoutes([CHECKED]);
    button({ onDone });

    fireEvent.click(check());
    await flushAsync();

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(routerCalls.refresh).toBe(0);
  });

  test("treats an unreachable database as an answer, not a failure", async () => {
    // "Could not reach it" is a finding about that database and belongs on the
    // screen, which cannot draw it unless this button reports success.
    const onDone = jest.fn();
    setRoutes([UNREACHABLE]);
    button({ onDone });

    fireEvent.click(check());
    await flushAsync();

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/failed|Network error/)).toBeNull();
  });
});

describe("when the caller has a write of its own running", () => {
  test("will not start while the caller says wait", () => {
    button({ disabled: true });
    expect(check()).toBeDisabled();
  });

  test("and sends nothing if it is pressed anyway", async () => {
    // No routes: a request that got out would be rejected and leave a network
    // error on screen, so both halves are checked at once.
    setRoutes([]);
    button({ disabled: true });

    fireEvent.click(check());
    await flushAsync();

    expect(fetchCalls).toHaveLength(0);
    expect(screen.queryByText(/Network error/)).toBeNull();
  });

  test("offers itself again the moment the caller lets go", () => {
    const view = button({ disabled: true });
    view.rerender(
      <RecheckDriftButton trackedSchemaId={SCHEMA_ID} onDone={defaultDone} disabled={false} />
    );
    expect(check()).toBeEnabled();
  });
});

describe("when the check fails", () => {
  test("repeats the reason the server gave", async () => {
    setRoutes([MISSING]);
    button();

    fireEvent.click(check());
    await flushAsync();

    expect(screen.getByText("Tracked schema not found.")).toBeInTheDocument();
  });

  test("and whatever other reason it gives", async () => {
    setRoutes([NO_BASELINE]);
    button();

    fireEvent.click(check());
    await flushAsync();

    expect(
      screen.getByText("This tracked schema has no baseline snapshot to compare against.")
    ).toBeInTheDocument();
  });

  test("says something of its own when the answer carries no reason", async () => {
    setRoutes([{ match: "/api/lineage/drift", method: "POST", status: 500, body: {} }]);
    button();

    fireEvent.click(check());
    await flushAsync();

    expect(screen.getByText("Drift check failed.")).toBeInTheDocument();
  });

  test("refuses a cheerful answer that carries no result", async () => {
    // What an expired session or a proxy looks like from here: 200, and
    // nothing in it. Calling that a successful check would tell the screen to
    // redraw yesterday's answer as though it were today's.
    setRoutes([
      { match: "/api/lineage/drift", method: "POST", body: { trackedSchemaId: SCHEMA_ID } },
    ]);
    const onDone = jest.fn();
    button({ onDone });

    fireEvent.click(check());
    await flushAsync();

    expect(screen.getByText("Drift check failed.")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  test("and one that cannot be read at all", async () => {
    setRoutes([{ match: "/api/lineage/drift", method: "POST", body: null }]);
    button();

    fireEvent.click(check());
    await flushAsync();

    expect(screen.getByText("Drift check failed.")).toBeInTheDocument();
  });

  test("tells nobody the screen needs redrawing", async () => {
    const onDone = jest.fn();
    setRoutes([MISSING]);
    button({ onDone });

    fireEvent.click(check());
    await flushAsync();

    expect(onDone).not.toHaveBeenCalled();
    expect(routerCalls.refresh).toBe(0);
  });

  test("offers itself again", async () => {
    setRoutes([MISSING]);
    button();

    fireEvent.click(check());
    await flushAsync();

    expect(check()).toBeEnabled();
  });

  test("still tells its caller it has stopped", async () => {
    // The deadlock this guards: a failed check that never reported stopping
    // would leave every button in the bar around it disabled until a reload.
    const onBusyChange = jest.fn();
    setRoutes([MISSING]);
    button({ onBusyChange });

    fireEvent.click(check());
    await flushAsync();

    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });
});

describe("when the request never arrives", () => {
  test("says so in its own words", async () => {
    setRoutes([{ match: "/api/lineage/drift", method: "POST", networkError: true }]);
    button();

    fireEvent.click(check());
    await flushAsync();

    expect(screen.getByText("Network error during the drift check.")).toBeInTheDocument();
  });

  test("lets go of the caller's lock and its own", async () => {
    const onBusyChange = jest.fn();
    setRoutes([{ match: "/api/lineage/drift", method: "POST", networkError: true }]);
    button({ onBusyChange });

    fireEvent.click(check());
    await flushAsync();

    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    expect(check()).toBeEnabled();
  });

  test("and leaves the screen alone", async () => {
    const onDone = jest.fn();
    setRoutes([{ match: "/api/lineage/drift", method: "POST", networkError: true }]);
    button({ onDone });

    fireEvent.click(check());
    await flushAsync();

    expect(onDone).not.toHaveBeenCalled();
    expect(routerCalls.refresh).toBe(0);
  });
});

describe("trying again", () => {
  test("clears the last complaint", async () => {
    setRoutes([MISSING]);
    button();

    fireEvent.click(check());
    await flushAsync();
    expect(screen.getByText("Tracked schema not found.")).toBeInTheDocument();

    setRoutes([CHECKED]);
    fireEvent.click(check());
    await flushAsync();

    expect(screen.queryByText("Tracked schema not found.")).toBeNull();
  });

  test("and runs the check a second time", async () => {
    setRoutes([CHECKED]);
    button();

    fireEvent.click(check());
    await flushAsync();
    fireEvent.click(check());
    await flushAsync();

    expect(fetchCalls).toHaveLength(2);
    // Twice, not once: a second check that runs but never reports leaves the
    // screen showing the first answer.
    expect(defaultDone).toHaveBeenCalledTimes(2);
    expect(routerCalls.refresh).toBe(0);
  });
});
