/** @jest-environment jsdom */

/**
 * The four buttons that relabel one tracked schema's environment.
 *
 * This is the only place in the app where that label can be corrected.
 * Tracking seeds it from the connection and every row that predates the column
 * arrived as "unset", so what these buttons write is what every production
 * warning downstream — on Compare, on Drift, on Deploy — is decided from. A
 * picker that looks like it saved and did not is therefore a picker that turns
 * a live database into one nothing warns about.
 *
 * Which is why most of this file is about the optimistic update. The buttons
 * move before the server has answered, because a four-button toggle that waits
 * for a round trip feels broken — and that means every failure has to put them
 * back. Back to the last value that STUCK, not back to the prop: this thing
 * stays on screen after a successful change, and a second change that fails
 * must not quietly undo the first one as well.
 *
 * The other decision worth pinning is how the rest of the screen finds out. A
 * screen that loads its own data passes onDone and reloads it; a
 * server-rendered one passes nothing and gets router.refresh(). Picking the
 * wrong one leaves the header pill above disagreeing with the buttons below.
 *
 * What is NOT here:
 *  - The route these buttons call. The PATCH in app/api/lineage/route.ts — its
 *    role gate, its refusal of an unknown label, the UPDATE itself — has no
 *    suite of its own. What is checked below is the request this component
 *    sends and what it makes of each shape of answer.
 *  - The page that hosts the picker and reloads itself when it reports back:
 *    tests/page-schema-detail.test.tsx.
 *  - lib/environments. Its functions are covered by tests/deploy-safety.test.ts
 *    under describe("environments"). The four labels and four sentences below
 *    are written out by hand rather than imported, because imported ones would
 *    still pass if every label in that file were renamed to the same word — so
 *    this is now also the only place that wording is checked anywhere.
 *  - That the four buttons read as one segmented control, that the chosen one
 *    is filled in, or that the warning is red. All three are CSS and jsdom
 *    applies no stylesheet, so what is asserted is the class and the role the
 *    component asks for, not what a browser would draw from them.
 *  - The second half of the early return, `|| busy`. Nothing can reach it
 *    through the DOM, because the same flag disables every button and React
 *    does not deliver a click to a disabled one. What is asserted instead is
 *    the disabling, which is the guard a person actually meets.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import { SchemaEnvironmentPicker } from "@/components/studio/SchemaEnvironmentPicker";
import type { Environment } from "@/lib/environments";
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

// The words ENVIRONMENT_META puts on screen, in the order ENVIRONMENTS lists
// them. Written out rather than imported on purpose — see the header.
const LABELS = ["Unlabelled", "Dev", "Staging", "Production"];
const HELP: Record<Environment, string> = {
  unset: "No environment set. Nothing can warn you about this target, so label it.",
  dev: "A development database. Safe to rebuild from scratch.",
  staging: "A pre-production rehearsal. Treat migrations here as a dry run for prod.",
  prod: "Live data. Every destructive change here is announced loudly before it runs.",
};
const WARNING = "Compare, Drift and Deploy will call this out before they touch it.";

// The route answers with the label it wrote — see app/api/lineage/route.ts.
// The component ignores that, but an answer the real route could not produce
// is one more thing to be wrong about later.
const OK: FetchRoute = {
  match: "/api/lineage",
  method: "PATCH",
  body: (url: string, init?: RequestInit) => ({
    success: true,
    environment: JSON.parse(String(init?.body ?? "{}")).environment,
  }),
};

// Two refusals, in the exact words the server sends them. The first is what a
// viewer gets from requireEditor; the second is what happens when the schema
// was untracked in another tab while this page sat open.
const VIEWER: FetchRoute = {
  match: "/api/lineage",
  method: "PATCH",
  status: 403,
  body: { error: 'This action needs the "editor" role or higher. Yours is "viewer".' },
};
const GONE: FetchRoute = {
  match: "/api/lineage",
  method: "PATCH",
  status: 404,
  body: { error: "That schema is not tracked." },
};

beforeEach(() => resetPageState());

function picker(
  over: { environment?: Environment; onDone?: () => void } = {}
) {
  return render(
    <SchemaEnvironmentPicker
      trackedSchemaId={SCHEMA_ID}
      environment={over.environment ?? "dev"}
      onDone={over.onDone}
    />
  );
}

const group = () => screen.getByRole("radiogroup", { name: "Environment" });
const radios = () => screen.getAllByRole("radio");
const radio = (name: string) => screen.getByRole("radio", { name });
const chosen = () =>
  radios()
    .filter((button) => button.getAttribute("aria-checked") === "true")
    .map((button) => button.textContent);
const sent = () => JSON.parse(String(fetchCalls[0].body));

describe("what it puts on screen", () => {
  test("names the setting and says what it is for", () => {
    picker();
    expect(screen.getByText("Environment")).toBeInTheDocument();
    expect(screen.getByText("Drives the production warnings.")).toBeInTheDocument();
  });

  test("offers every environment, in the order the list defines them", () => {
    picker();
    expect(radios().map((button) => button.textContent)).toEqual(LABELS);
  });

  test("puts them in one group rather than leaving four buttons loose", () => {
    // A radiogroup is what tells a screen reader these are alternatives. Four
    // bare buttons would be read as four unrelated actions.
    picker();
    expect(within(group()).getAllByRole("radio")).toHaveLength(LABELS.length);
  });

  test("marks the environment it was given, and only that one", () => {
    picker({ environment: "staging" });
    expect(chosen()).toEqual(["Staging"]);
    expect(radio("Staging").className).toContain("active");
    expect(radio("Dev").className).not.toContain("active");
  });

  test("explains the environment that is showing", () => {
    picker({ environment: "staging" });
    expect(screen.getByText(HELP.staging)).toBeInTheDocument();
    expect(screen.queryByText(HELP.dev)).toBeNull();
  });

  test("starts with nothing to complain about", () => {
    picker();
    expect(screen.queryByText(/Could not change|Network error/)).toBeNull();
  });
});

describe("the production warning", () => {
  test("says what a production label costs", () => {
    picker({ environment: "prod" });
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  test("stays quiet on the other three", () => {
    // Including "unset". An unlabelled schema may well BE production, but this
    // panel reports the label rather than guessing at the database behind it —
    // guessing is what lib/environments does for a suggestion, and only there.
    for (const environment of ["unset", "dev", "staging"] as Environment[]) {
      const view = picker({ environment });
      expect(screen.queryByText(WARNING)).toBeNull();
      view.unmount();
    }
  });
});

describe("choosing another one", () => {
  test("moves the buttons before the server has answered", async () => {
    setRoutes([OK]);
    const release = holdNext("/api/lineage", "PATCH");
    picker();

    fireEvent.click(radio("Staging"));
    expect(chosen()).toEqual(["Staging"]);

    release();
    await flushAsync();
  });

  test("asks the server to change this schema to that environment", async () => {
    setRoutes([OK]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(fetchCalls[0].url).toBe("/api/lineage");
    expect(fetchCalls[0].method).toBe("PATCH");
    expect(sent()).toEqual({ id: SCHEMA_ID, environment: "staging" });
  });

  test("asks once", async () => {
    setRoutes([OK]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(fetchCalls).toHaveLength(1);
  });

  test("explains the new environment straight away", async () => {
    setRoutes([OK]);
    picker();

    fireEvent.click(radio("Staging"));
    expect(screen.getByText(HELP.staging)).toBeInTheDocument();

    await flushAsync();
  });

  test("warns as soon as production is picked, not once the server agrees", async () => {
    // The warning is the whole reason the label exists, so it arrives with the
    // click. Waiting for the round trip would leave a moment where the buttons
    // say production and nothing on screen says what that means.
    setRoutes([OK]);
    const release = holdNext("/api/lineage", "PATCH");
    picker();

    fireEvent.click(radio("Production"));
    expect(screen.getByText(WARNING)).toBeInTheDocument();

    release();
    await flushAsync();
  });

  test("keeps the new one once the server agrees", async () => {
    setRoutes([OK]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(chosen()).toEqual(["Staging"]);
    expect(screen.queryByText(/Could not change|Network error/)).toBeNull();
  });

  test("does nothing at all when you pick the one already picked", async () => {
    // No routes, so a request would be rejected and leave a network error on
    // screen. Both halves are checked: nothing was sent, and nothing went
    // wrong quietly.
    setRoutes([]);
    picker();

    fireEvent.click(radio("Dev"));
    await flushAsync();

    expect(fetchCalls).toHaveLength(0);
    expect(chosen()).toEqual(["Dev"]);
    expect(screen.queryByText(/Network error/)).toBeNull();
  });
});

describe("while the change is in flight", () => {
  test("takes every button out of service", async () => {
    // Not only the one that was clicked. Two changes racing would settle in
    // whichever order the answers came back, and the loser would be written
    // into the database after the winner.
    setRoutes([OK]);
    const release = holdNext("/api/lineage", "PATCH");
    picker();

    fireEvent.click(radio("Staging"));
    for (const button of radios()) expect(button).toBeDisabled();

    release();
    await flushAsync();
  });

  test("puts them back when the answer arrives", async () => {
    setRoutes([OK]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();

    for (const button of radios()) expect(button).toBeEnabled();
  });

  test("puts them back when the answer is a refusal", async () => {
    // The one that matters: a refused change that left the picker disabled
    // would need a page reload before anyone could try again.
    setRoutes([VIEWER]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();

    for (const button of radios()) expect(button).toBeEnabled();
  });
});

describe("when the server refuses", () => {
  test("puts the buttons back where they were", async () => {
    setRoutes([VIEWER]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(chosen()).toEqual(["Dev"]);
    expect(radio("Dev").className).toContain("active");
  });

  test("repeats the reason it was given", async () => {
    setRoutes([VIEWER]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(
      screen.getByText('This action needs the "editor" role or higher. Yours is "viewer".')
    ).toBeInTheDocument();
  });

  test("and whatever other reason it gives", async () => {
    setRoutes([GONE]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(screen.getByText("That schema is not tracked.")).toBeInTheDocument();
  });

  test("says something of its own when the answer carries no reason", async () => {
    setRoutes([{ match: "/api/lineage", method: "PATCH", status: 500, body: {} }]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(screen.getByText("Could not change the environment.")).toBeInTheDocument();
  });

  test("and when the answer cannot be read at all", async () => {
    // A proxy returning an HTML error page, which is what the .catch on the
    // json() is for. Silence here would look exactly like success.
    setRoutes([{ match: "/api/lineage", method: "PATCH", status: 502, body: null }]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(screen.getByText("Could not change the environment.")).toBeInTheDocument();
  });

  test("tells nobody the screen needs catching up", async () => {
    const onDone = jest.fn();
    setRoutes([VIEWER]);
    picker({ onDone });

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(onDone).not.toHaveBeenCalled();
    expect(routerCalls.refresh).toBe(0);
  });

  test("drops the production warning along with the value", async () => {
    setRoutes([VIEWER]);
    picker();

    fireEvent.click(radio("Production"));
    await flushAsync();

    expect(screen.queryByText(WARNING)).toBeNull();
    expect(screen.getByText(HELP.dev)).toBeInTheDocument();
  });

  test("snaps back to the last one that stuck, not to the one it was given", async () => {
    // The reason the component holds `previous` rather than reading the prop:
    // this panel stays on screen after a change, and a later failure must not
    // silently undo the earlier success as well.
    setRoutes([OK]);
    picker({ environment: "unset" });

    fireEvent.click(radio("Staging"));
    await flushAsync();
    expect(chosen()).toEqual(["Staging"]);

    setRoutes([GONE]);
    fireEvent.click(radio("Production"));
    await flushAsync();

    expect(chosen()).toEqual(["Staging"]);
  });
});

describe("when the request never arrives", () => {
  test("says so in its own words", async () => {
    setRoutes([{ match: "/api/lineage", method: "PATCH", networkError: true }]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(
      screen.getByText("Network error while changing the environment.")
    ).toBeInTheDocument();
  });

  test("puts the buttons back where they were", async () => {
    setRoutes([{ match: "/api/lineage", method: "PATCH", networkError: true }]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(chosen()).toEqual(["Dev"]);
    for (const button of radios()) expect(button).toBeEnabled();
  });

  test("and leaves the rest of the screen alone", async () => {
    const onDone = jest.fn();
    setRoutes([{ match: "/api/lineage", method: "PATCH", networkError: true }]);
    picker({ onDone });

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(onDone).not.toHaveBeenCalled();
    expect(routerCalls.refresh).toBe(0);
  });
});

describe("telling the rest of the screen", () => {
  test("hands back to the caller when it was given a way to", async () => {
    const onDone = jest.fn();
    setRoutes([OK]);
    picker({ onDone });

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(routerCalls.refresh).toBe(0);
  });

  test("reloads the server-rendered screen when it was not", async () => {
    // Without this the header pill above and the buttons below disagree until
    // someone reloads the page themselves.
    setRoutes([OK]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();

    expect(routerCalls.refresh).toBe(1);
  });

  test("clears the last complaint when you try again", async () => {
    setRoutes([VIEWER]);
    picker();

    fireEvent.click(radio("Staging"));
    await flushAsync();
    expect(screen.getByText(/role or higher/)).toBeInTheDocument();

    setRoutes([OK]);
    fireEvent.click(radio("Production"));
    await flushAsync();

    expect(screen.queryByText(/role or higher/)).toBeNull();
    expect(chosen()).toEqual(["Production"]);
  });
});
