/**
 * @jest-environment jsdom
 */
// The phone's Compare tab. It compares on this site's connections or on a computer
// the person linked, and the second way works by leaving questions for the computer,
// so most of this looks at that: which questions go, what shows while an answer is on
// its way, what a late answer does, and that no server text with a host reaches the screen.
import "@testing-library/jest-dom";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Computer, JobAnswer } from "@/lib/agent-rules";
import type { ChangeLine, CompareSummary, TargetSummary } from "@/lib/phone-compare";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  render,
  resetPageState,
  setCustomRole,
  setRoutes,
  setSearchParams,
  setUser,
  type FetchRoute,
} from "./helpers/render-page";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import PhonePage from "@/app/[org]/phone/page";

const WHEN = "2026-01-01T09:00:00.000Z";
const FAKE_HOST = "db.private.example.test";
const OFF_SENTENCE = "That computer is off or asleep. Open Schema Studio on it and try again.";
const OFFLINE = "Could not reach the server. Check this device's connection and try again.";
const NO_SCHEMAS = "Could not read the schemas on that connection.";
const PRIVACY = /Questions and answers pass through this site/;
// One poll's wait on the real clock, and some room for a busy machine.
const AFTER_A_POLL = { timeout: 4000 };

const LAPTOP: Computer = {
  id: 4,
  name: "Work laptop",
  online: true,
  lastSeenAt: WHEN,
  connections: [
    { id: 1, name: "Bookshop dev" },
    { id: 2, name: "Bookshop plain" },
  ],
};

const ON_SITE = [
  { id: 21, name: "Site dev", database: "shop" },
  { id: 22, name: "Site prod", database: "shop" },
];

function target(over: Partial<TargetSummary> = {}): TargetSummary {
  return {
    connectionId: 2,
    name: "Bookshop plain",
    schema: "archive",
    status: "compared",
    error: null,
    changes: 0,
    breaking: 0,
    manual: 0,
    lines: [],
    moreLines: 0,
    history: null,
    ...over,
  };
}

function summary(...targets: TargetSummary[]): CompareSummary {
  return {
    source: { connectionId: 1, name: "Bookshop dev", schema: "shop", error: null },
    targets: targets.length === 0 ? [target()] : targets,
  };
}

const COMPARE_JOB = 9;

/** The site's half of a computer: a question's id tells which connection it asked about. */
function computerRoutes(answer: JobAnswer = { status: "done", result: summary() }): FetchRoute[] {
  return [
    {
      match: /\/api\/computers\/jobs$/,
      method: "POST",
      status: 201,
      body: (_url: string, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body));
        return { id: sent.method === "compare.run" ? COMPARE_JOB : 100 + sent.params.connectionId };
      },
    },
    { match: /\/jobs\/101$/, body: { status: "done", result: { schemas: ["shop"] } } },
    { match: /\/jobs\/102$/, body: { status: "done", result: { schemas: ["shop", "archive"] } } },
    { match: new RegExp(`/jobs/${COMPARE_JOB}$`), body: answer },
  ];
}

function siteRoutes(): FetchRoute[] {
  return [
    { match: "connectionId=21", body: { schemas: ["shop"] } },
    { match: "connectionId=22", body: { schemas: ["shop", "archive"] } },
  ];
}

function usual(extra: FetchRoute[] = [], computers: Computer[] = [LAPTOP]): FetchRoute[] {
  return [
    ...extra,
    { match: "only=counts", body: { counts: { waiting: 0, answered: 0 } } },
    { match: /\/api\/computers$/, body: { computers } },
    { match: "/api/connections/phone", body: { connections: ON_SITE } },
  ];
}

function bar() {
  return within(screen.getByRole("navigation", { name: "Phone app" }));
}

function compareButton() {
  // The bar along the bottom has a Compare of its own.
  return within(screen.getByRole("main")).getByRole("button", { name: /^Compar/ });
}

async function choose(name: string, option: string) {
  const box = await screen.findByRole("combobox", { name });
  await waitFor(() => expect(box).toBeEnabled(), AFTER_A_POLL);
  fireEvent.click(box);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

async function chooseSides(source: string, target: string) {
  await choose("Source connection", source);
  await choose("Source schema", "shop");
  await choose("Target connection", target);
  await choose("Target schema", "archive");
}

async function openTab() {
  setSearchParams("tab=compare");
  render(<PhonePage />);
  await screen.findByRole("combobox", { name: "Compare on" });
}

function called(url: string | RegExp, method = "GET") {
  return fetchCalls.filter(
    (call) =>
      call.method === method && (typeof url === "string" ? call.url.includes(url) : url.test(call.url))
  );
}

function questions() {
  return called(/\/api\/computers\/jobs$/, "POST").map((call) => JSON.parse(String(call.body)));
}

beforeEach(() => {
  resetPageState();
  setUser("admin");
});

afterEach(cleanup);

describe("who gets the tab", () => {
  test("someone who may compare finds it between Approvals and Alerts", async () => {
    setRoutes(usual());
    await openTab();
    const names = bar()
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual(["Drift", "History", "Approvals", "Compare", "Alerts"]);
    expect(bar().getByRole("button", { name: "Compare" })).toHaveAttribute("aria-current", "page");
  });

  test("someone who may only compare still has it, without the drift tabs", async () => {
    setCustomRole("checker", "Checker", ["compare:read"]);
    setRoutes(usual());
    await openTab();
    const names = bar()
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual(["Approvals", "Compare", "Alerts"]);
  });

  test("someone who may not has no such tab, even by its address, and nothing is asked", async () => {
    setCustomRole("clerk", "Clerk", []);
    setRoutes([
      { match: "only=counts", body: { counts: { waiting: 0, answered: 0 } } },
      {
        match: /\/api\/requests$/,
        body: {
          mine: [],
          inbox: [],
          runsToApprove: [],
          runsToRun: [],
          myRuns: [],
          canAnswer: false,
          lastSeenAt: null,
          counts: { waiting: 0, answered: 0 },
        },
      },
    ]);
    setSearchParams("tab=compare");
    render(<PhonePage />);
    await screen.findByRole("navigation", { name: "Phone app" });
    expect(bar().queryByRole("button", { name: "Compare" })).not.toBeInTheDocument();
    expect(bar().getByRole("button", { name: "Approvals" })).toHaveAttribute("aria-current", "page");
    expect(called("/api/computers")).toEqual([]);
    expect(called("/api/connections/phone")).toEqual([]);
  });
});

describe("comparing on this site", () => {
  test("uses the site's own route, says how to link a computer, and leaves no question", async () => {
    setRoutes(
      usual([...siteRoutes(), { match: "/api/compare/phone", method: "POST", body: summary() }], [])
    );
    await openTab();
    expect(screen.getByText(/open Schema Studio there, go to Settings and link it/)).toBeInTheDocument();
    expect(screen.queryByText(PRIVACY)).not.toBeInTheDocument();

    await chooseSides("Site dev", "Site prod");
    fireEvent.click(compareButton());

    expect(await screen.findByText("No differences")).toBeInTheDocument();
    expect(JSON.parse(String(called("/api/compare/phone", "POST")[0].body))).toEqual({
      source: { connectionId: 21, schema: "shop" },
      targets: [{ connectionId: 22, schema: "archive" }],
    });
    expect(questions()).toEqual([]);
  });

  test("the button waits for all four choices", async () => {
    setRoutes(usual(siteRoutes()));
    await openTab();
    expect(compareButton()).toBeDisabled();
    await choose("Source connection", "Site dev");
    await choose("Source schema", "shop");
    await choose("Target connection", "Site prod");
    expect(compareButton()).toBeDisabled();
    await choose("Target schema", "archive");
    expect(compareButton()).toBeEnabled();
  });

  test("a schema can only be chosen once its connection is", async () => {
    setRoutes(usual(siteRoutes()));
    await openTab();
    expect(screen.getByRole("combobox", { name: "Source schema" })).toBeDisabled();
    expect(called("/api/lineage/schemas")).toEqual([]);
  });

  test("says so when the site has no saved connections", async () => {
    setRoutes([{ match: "/api/connections/phone", body: { connections: [] } }, ...usual()]);
    await openTab();
    expect(screen.getByText("This site has no saved connections yet.")).toBeInTheDocument();
  });

  test("a failure's own text, which could name a host, stays off the screen", async () => {
    setRoutes(
      usual([
        {
          match: "connectionId=21",
          status: 502,
          body: { error: `could not connect to ${FAKE_HOST}` },
        },
      ])
    );
    await openTab();
    await choose("Source connection", "Site dev");
    expect(await screen.findByText(NO_SCHEMAS)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(FAKE_HOST);
  });

  test("a schema list that failed can be read again", async () => {
    setRoutes(usual([{ match: "connectionId=21", status: 500, body: {} }]));
    await openTab();
    await choose("Source connection", "Site dev");
    await screen.findByText(NO_SCHEMAS);
    setRoutes(usual(siteRoutes()));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await choose("Source schema", "shop");
    expect(screen.queryByText(NO_SCHEMAS)).not.toBeInTheDocument();
  });

  test("a failed compare says so and can be tried again", async () => {
    setRoutes(
      usual([...siteRoutes(), { match: "/api/compare/phone", method: "POST", status: 500, body: {} }])
    );
    await openTab();
    await chooseSides("Site dev", "Site prod");
    fireEvent.click(compareButton());
    expect(await screen.findByText("Could not compare those schemas.")).toBeInTheDocument();
    expect(compareButton()).toBeEnabled();
    expect(compareButton()).toHaveTextContent("Compare");
  });

  test("a lost signal says so", async () => {
    setRoutes(
      usual([...siteRoutes(), { match: "/api/compare/phone", method: "POST", networkError: true }])
    );
    await openTab();
    await chooseSides("Site dev", "Site prod");
    fireEvent.click(compareButton());
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
  });
});

describe("comparing on a computer", () => {
  async function pickLaptop() {
    await openTab();
    await choose("Compare on", "Work laptop");
  }

  test("asks only the computer, with both kinds of question, and shows what comes back", async () => {
    setRoutes(usual(computerRoutes()));
    await pickLaptop();
    await chooseSides("Bookshop dev", "Bookshop plain");
    fireEvent.click(compareButton());

    expect(await screen.findByText("No differences", {}, AFTER_A_POLL)).toBeInTheDocument();
    expect(questions()).toEqual([
      { computerId: 4, method: "schemas.list", params: { connectionId: 1 } },
      { computerId: 4, method: "schemas.list", params: { connectionId: 2 } },
      {
        computerId: 4,
        method: "compare.run",
        params: {
          source: { connectionId: 1, schema: "shop" },
          targets: [{ connectionId: 2, schema: "archive" }],
        },
      },
    ]);
    expect(called("/api/compare/phone", "POST")).toEqual([]);
    expect(called("/api/lineage/schemas")).toEqual([]);
  });

  test("a lost computer can be unlinked from here, after saying so twice", async () => {
    const unlinked = { match: /\/api\/computers\/4$/, method: "DELETE", body: { ok: true } };
    setRoutes(usual([unlinked]));
    await pickLaptop();
    fireEvent.click(screen.getByRole("button", { name: "Unlink this computer" }));
    expect(called(/\/api\/computers\/4$/, "DELETE")).toEqual([]);
    expect(screen.getByText(/Unlink Work laptop\? It stops answering/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep it linked" }));
    expect(called(/\/api\/computers\/4$/, "DELETE")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Unlink this computer" }));
    // The list the site gives once it is gone.
    setRoutes(usual([unlinked], []));
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Compare on" })).toHaveTextContent("This site's connections")
    );
    expect(called(/\/api\/computers\/4$/, "DELETE")).toHaveLength(1);
    expect(await screen.findByText(/link it under Web site/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unlink this computer" })).not.toBeInTheDocument();
  });

  test("unlinking takes that computer's last answer off the screen", async () => {
    const unlinked = { match: /\/api\/computers\/4$/, method: "DELETE", body: { ok: true } };
    setRoutes(usual([unlinked, ...computerRoutes()]));
    await pickLaptop();
    await chooseSides("Bookshop dev", "Bookshop plain");
    fireEvent.click(compareButton());
    await screen.findByText("No differences", {}, AFTER_A_POLL);

    fireEvent.click(screen.getByRole("button", { name: "Unlink this computer" }));
    setRoutes(usual([unlinked], []));
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));

    expect(await screen.findByText(/link it under Web site/)).toBeInTheDocument();
    expect(screen.queryByText("No differences")).not.toBeInTheDocument();
  });

  test("a failed unlink says why, in the site's words only when they are safe", async () => {
    setRoutes(
      usual([
        {
          match: /\/api\/computers\/4$/,
          method: "DELETE",
          status: 500,
          body: { error: `pg failed on ${FAKE_HOST}` },
        },
      ])
    );
    await pickLaptop();
    fireEvent.click(screen.getByRole("button", { name: "Unlink this computer" }));
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(await screen.findByText("Could not unlink that computer.")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(FAKE_HOST))).not.toBeInTheDocument();
    // Still there, and still a place to compare.
    expect(screen.getByRole("combobox", { name: "Compare on" })).toHaveTextContent("Work laptop");
    expect(screen.getByRole("button", { name: "Keep it linked" })).toBeEnabled();
  });

  test("says what passes through the site, only when a computer is chosen", async () => {
    setRoutes(usual(computerRoutes()));
    await openTab();
    expect(screen.queryByText(PRIVACY)).not.toBeInTheDocument();
    await choose("Compare on", "Work laptop");
    expect(screen.getByText(PRIVACY)).toHaveTextContent("never SQL, hosts, database names or rows");
  });

  test("says it is waiting, keeps asking, then shows the answer", async () => {
    setRoutes(usual(computerRoutes({ status: "waiting" })));
    await pickLaptop();
    await chooseSides("Bookshop dev", "Bookshop plain");
    fireEvent.click(compareButton());

    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent("Asking Work laptop.");
    expect(note).toHaveTextContent("every 15 seconds");
    expect(compareButton()).toBeDisabled();
    expect(compareButton()).toHaveTextContent("Comparing…");

    setRoutes(usual(computerRoutes()));
    expect(await screen.findByText("No differences", {}, AFTER_A_POLL)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(compareButton()).toBeEnabled();
  });

  test("shows the site's sentence when the computer could not do it", async () => {
    setRoutes(
      usual(computerRoutes({ status: "failed", error: "The computer could not reach that database." }))
    );
    await pickLaptop();
    await chooseSides("Bookshop dev", "Bookshop plain");
    fireEvent.click(compareButton());
    expect(
      await screen.findByText("The computer could not reach that database.", {}, AFTER_A_POLL)
    ).toBeInTheDocument();
    expect(compareButton()).toBeEnabled();
  });

  test("a computer that went off says so, and the schemas can be asked for again", async () => {
    setRoutes(
      usual([{ match: /\/api\/computers\/jobs$/, method: "POST", status: 409, body: { error: OFF_SENTENCE } }])
    );
    await pickLaptop();
    await choose("Source connection", "Bookshop dev");
    expect(await screen.findByText(OFF_SENTENCE)).toBeInTheDocument();

    setRoutes(usual(computerRoutes()));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await choose("Source schema", "shop");
    expect(screen.queryByText(OFF_SENTENCE)).not.toBeInTheDocument();
  });

  test("a question that cannot be left, with no signal, says so", async () => {
    setRoutes(usual([{ match: /\/api\/computers\/jobs$/, method: "POST", networkError: true }]));
    await pickLaptop();
    await choose("Source connection", "Bookshop dev");
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
  });

  test("a failure of the site's own while waiting is only a hiccup, and shows no text of its", async () => {
    setRoutes(
      usual([
        { match: new RegExp(`/jobs/${COMPARE_JOB}$`), status: 500, body: { error: FAKE_HOST } },
        ...computerRoutes(),
      ])
    );
    await pickLaptop();
    await chooseSides("Bookshop dev", "Bookshop plain");
    fireEvent.click(compareButton());
    await waitFor(() => expect(called(`/jobs/${COMPARE_JOB}`).length).toBe(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    setRoutes(usual(computerRoutes()));
    expect(await screen.findByText("No differences", {}, AFTER_A_POLL)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(FAKE_HOST);
  });

  test("a question the site has forgotten stops the wait with its sentence", async () => {
    const gone = "That question is not there any more. Ask again.";
    setRoutes(
      usual([
        { match: new RegExp(`/jobs/${COMPARE_JOB}$`), status: 404, body: { error: gone } },
        ...computerRoutes(),
      ])
    );
    await pickLaptop();
    await chooseSides("Bookshop dev", "Bookshop plain");
    fireEvent.click(compareButton());
    expect(await screen.findByText(gone)).toBeInTheDocument();
  });

  test("changing a choice clears the answer", async () => {
    setRoutes(usual(computerRoutes()));
    await pickLaptop();
    await chooseSides("Bookshop dev", "Bookshop plain");
    fireEvent.click(compareButton());
    await screen.findByText("No differences", {}, AFTER_A_POLL);

    await choose("Target schema", "shop");
    expect(screen.queryByText("No differences")).not.toBeInTheDocument();
  });

  test("an answer that arrives after a choice changed is dropped", async () => {
    setRoutes(usual(computerRoutes()));
    await pickLaptop();
    await chooseSides("Bookshop dev", "Bookshop plain");
    const release = holdNext(`/jobs/${COMPARE_JOB}`, "GET");
    fireEvent.click(compareButton());
    await waitFor(() => expect(called(`/jobs/${COMPARE_JOB}`).length).toBe(1));

    await choose("Target schema", "shop");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(compareButton()).toHaveTextContent("Compare");

    release();
    await flushAsync();
    expect(screen.queryByText("No differences")).not.toBeInTheDocument();
    expect(compareButton()).toBeEnabled();
  });

  test("leaving the tab stops the asking", async () => {
    setRoutes(usual(computerRoutes({ status: "waiting" })));
    await pickLaptop();
    await chooseSides("Bookshop dev", "Bookshop plain");
    fireEvent.click(compareButton());
    await waitFor(() => expect(called(`/jobs/${COMPARE_JOB}`).length).toBe(1));

    fireEvent.click(bar().getByRole("button", { name: "Alerts" }));
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(called(`/jobs/${COMPARE_JOB}`).length).toBe(1);
  }, 8000);

  test("moving to another place clears every choice, and offers that place's connections", async () => {
    setRoutes(usual([...computerRoutes(), ...siteRoutes()]));
    await pickLaptop();
    await choose("Source connection", "Bookshop dev");
    await choose("Source schema", "shop");

    await choose("Compare on", "This site's connections");
    expect(screen.getByRole("combobox", { name: "Source connection" })).toHaveTextContent(
      "Choose a connection"
    );
    expect(screen.getByRole("combobox", { name: "Source schema" })).toBeDisabled();
    fireEvent.click(screen.getByRole("combobox", { name: "Source connection" }));
    expect(screen.getByRole("option", { name: "Site dev" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Bookshop dev" })).not.toBeInTheDocument();
  });

  test("another source connection clears its schema, which may not be there", async () => {
    setRoutes(usual(computerRoutes()));
    await pickLaptop();
    await choose("Source connection", "Bookshop dev");
    await choose("Source schema", "shop");
    expect(screen.getByRole("combobox", { name: "Source schema" })).toHaveTextContent("shop");

    await choose("Source connection", "Bookshop plain");
    await screen.findByRole("combobox", { name: "Source schema" });
    expect(screen.getByRole("combobox", { name: "Source schema" })).not.toHaveTextContent("shop");
  });

  test("moving to a place that has the same ids still clears the choices", async () => {
    setRoutes(
      usual([
        ...computerRoutes(),
        {
          match: "/api/connections/phone",
          body: { connections: [{ id: 1, name: "Same id", database: "shop" }] },
        },
      ])
    );
    await pickLaptop();
    await choose("Source connection", "Bookshop dev");
    await choose("Source schema", "shop");

    await choose("Compare on", "This site's connections");
    expect(screen.getByRole("combobox", { name: "Source connection" })).toHaveTextContent(
      "Choose a connection"
    );
    expect(called("/api/lineage/schemas")).toEqual([]);
  });

  test("a computer unlinked meanwhile leaves no choice behind, even with the same id on the site", async () => {
    setRoutes(
      usual([
        ...computerRoutes(),
        {
          match: "/api/connections/phone",
          body: { connections: [{ id: 1, name: "Same id", database: "shop" }] },
        },
      ])
    );
    await pickLaptop();
    await choose("Source connection", "Bookshop dev");
    await choose("Source schema", "shop");

    setRoutes(
      usual(
        [
          {
            match: "/api/connections/phone",
            body: { connections: [{ id: 1, name: "Same id", database: "shop" }] },
          },
        ],
        []
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Compare on" })).toHaveTextContent(
        "This site's connections"
      )
    );
    expect(screen.getByRole("combobox", { name: "Source connection" })).toHaveTextContent(
      "Choose a connection"
    );
    expect(called("/api/lineage/schemas")).toEqual([]);
  });

  test("a computer with nothing shared says where to share", async () => {
    setRoutes(usual([], [{ ...LAPTOP, connections: [] }]));
    await pickLaptop();
    expect(screen.getByText(/Nothing is shared from this computer yet/)).toBeInTheDocument();
  });

  test("a computer that is off is marked in the list, and says when it was last heard from", async () => {
    setRoutes(usual([], [{ ...LAPTOP, online: false }]));
    await openTab();
    await choose("Compare on", "Work laptop (off or asleep)");
    expect(screen.getByText(/Work laptop is off or asleep\. It last checked in/)).toBeInTheDocument();
  });

  test("a computer that never checked in says that instead", async () => {
    setRoutes(usual([], [{ ...LAPTOP, online: false, lastSeenAt: null }]));
    await openTab();
    await choose("Compare on", "Work laptop (off or asleep)");
    expect(screen.getByText(/It has not checked in yet\./)).toBeInTheDocument();
  });

  test("a list of computers that could not be read says so, and the site can still be used", async () => {
    setRoutes(usual([{ match: /\/api\/computers$/, status: 500, body: {} }, ...siteRoutes()]));
    await openTab();
    expect(screen.getByText("Could not list your computers.")).toBeInTheDocument();
    await choose("Source connection", "Site dev");
    await choose("Source schema", "shop");
  });
});

describe("what a comparison shows", () => {
  async function showOnSite(result: CompareSummary) {
    setRoutes(usual([...siteRoutes(), { match: "/api/compare/phone", method: "POST", body: result }]));
    await openTab();
    await chooseSides("Site dev", "Site prod");
    fireEvent.click(compareButton());
    await screen.findByText(/Compared with/);
  }

  const LINE: ChangeLine = {
    category: "Column",
    table: "orders",
    object: "total",
    change: "dropped",
    severity: "breaking",
    detail: "Was numeric",
    manual: true,
  };

  test.each([
    [{ status: "compared", changes: 0 }, "No differences"],
    [{ status: "compared", changes: 1 }, "1 difference"],
    [{ status: "compared", changes: 3 }, "3 differences"],
    [{ status: "same-as-source" }, "Same as the source"],
    [{ status: "unreachable" }, "Could not connect"],
    [{ status: "schema-missing" }, "No such schema"],
    [{ status: "duplicate" }, "Compared already"],
    [{ status: "no-connection" }, "Connection not found"],
    [{ status: "failed" }, "Could not compare"],
  ] as [Partial<TargetSummary>, string][])("%j reads %s", async (over, words) => {
    await showOnSite(summary(target(over)));
    expect(screen.getByText(words)).toBeInTheDocument();
  });

  test("names both sides, and the target's own trouble", async () => {
    await showOnSite(summary(target({ status: "unreachable", error: "The connection was refused." })));
    expect(screen.getByText("Compared with Bookshop dev, shop")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bookshop plain" })).toBeInTheDocument();
    expect(screen.getByText("The connection was refused.")).toBeInTheDocument();
  });

  test("shows the source's trouble as an error", async () => {
    await showOnSite({
      source: { ...summary().source, error: "The source could not be read." },
      targets: [target()],
    });
    expect(screen.getByRole("alert")).toHaveTextContent("The source could not be read.");
  });

  test("shows each change with its name, table, detail and how serious it is", async () => {
    await showOnSite(
      summary(
        target({
          changes: 2,
          breaking: 1,
          manual: 1,
          lines: [
            LINE,
            { ...LINE, table: "", object: "orders_idx", change: "rename-suggested", severity: "info", detail: "", manual: false },
          ],
        })
      )
    );
    const first = screen.getByText("orders.total").closest("li") as HTMLElement;
    expect(first).toHaveTextContent("Dropped Column orders.total");
    expect(first).toHaveTextContent("Was numeric");
    expect(within(first).getByText("Breaking")).toBeInTheDocument();
    expect(within(first).getByText("Finish by hand")).toBeInTheDocument();

    const second = screen.getByText("orders_idx").closest("li") as HTMLElement;
    expect(second).toHaveTextContent("Possible rename Column orders_idx");
    expect(within(second).getByText("Info")).toBeInTheDocument();
    expect(within(second).queryByText("Finish by hand")).not.toBeInTheDocument();
  });

  test("counts what is serious only when there is something to count", async () => {
    await showOnSite(summary(target({ changes: 4, breaking: 1, manual: 2 })));
    expect(screen.getByText("1 breaking change, 2 to finish by hand")).toBeInTheDocument();
    cleanup();
    resetPageState();
    setUser("admin");
    await showOnSite(summary(target({ changes: 4 })));
    expect(screen.queryByText(/breaking change/)).not.toBeInTheDocument();
  });

  test("changes left out point to the full site when compared on the site", async () => {
    await showOnSite(summary(target({ changes: 21, moreLines: 1, lines: [LINE] })));
    expect(
      screen.getByText("And 1 more change. See them all on the full site's Compare page.")
    ).toBeInTheDocument();
  });

  test("changes left out point to the computer when compared on one", async () => {
    setRoutes(
      usual(
        computerRoutes({
          status: "done",
          result: summary(target({ changes: 22, moreLines: 2, lines: [LINE] })),
        })
      )
    );
    await openTab();
    await choose("Compare on", "Work laptop");
    await chooseSides("Bookshop dev", "Bookshop plain");
    fireEvent.click(compareButton());
    expect(
      await screen.findByText(
        "And 2 more changes. See them all in Schema Studio on the computer.",
        {},
        AFTER_A_POLL
      )
    ).toBeInTheDocument();
  });

  test("shows the target's history line when there is one", async () => {
    await showOnSite(summary(target({ history: "Last compared on Tuesday." })));
    expect(screen.getByText("Last compared on Tuesday.")).toBeInTheDocument();
  });
});
