/** @jest-environment jsdom */

/**
 * The "View as" picker on the studio rail (components/studio/ViewAsSwitcher).
 *
 * While authentication is off there is nobody signed in, and the server acts
 * as a full admin. This picker is how a tester sees the app the way a viewer,
 * an editor or a role an admin made sees it instead: picking a role asks
 * /api/me/view-as to leave a cookie the server reads on every request, and
 * then reloads the page so every screen is drawn again as that role.
 *
 * It runs over the real useUser here, because the picker has to agree with the
 * rest of the page. What it shows as picked is the role the page is actually
 * drawn as, which is what /api/me said, so the picker can never read "Admin"
 * while the screens around it are a viewer's, or the other way round.
 *
 * What is checked:
 *  - The choices: Admin first, then the roles the server lists, without Admin
 *    twice, and without anything in the list that is not a role.
 *  - The role the page is drawn as is always one of the choices, and picked,
 *    even when the list could not be loaded.
 *  - While the page is still asking who it is, the picker says so and cannot
 *    be used.
 *  - Picking a role sends it to the server, holds the picker while it answers,
 *    and reloads the page once the server says yes.
 *  - A refusal or a failure says why, puts the picker back on the role the page
 *    is drawn as, lets the person try again, and does not reload.
 *  - Admin is always on offer, even when neither the list nor the role could
 *    be loaded, so someone viewing as a role can go back as soon as the server
 *    can switch them.
 *  - The list is loaded again when the Roles tab says it made or deleted a
 *    role, so a role made a minute ago can be picked without a reload. Only
 *    the newest answer counts, and a problem with the list never hides why a
 *    switch failed.
 *
 * jsdom does not navigate, and it makes location.reload read-only, so the
 * reload cannot be replaced with a stand-in. Asking jsdom to reload reports
 * "Not implemented: navigation" to the console instead, and that report is how
 * these tests see a reload. Anything else on the console fails the test.
 *
 * What is NOT here:
 *  - The route behind the picker, and the cookie it leaves:
 *    tests/view-as-routes.test.ts.
 *  - What the page lets the role do once it has reloaded:
 *    tests/use-user.test.tsx, and the per-screen suites.
 *  - Where the rail puts the picker, and that the narrow rail leaves it off:
 *    tests/component-studio-sidebar.test.tsx.
 *  - That only the bypass gets a picker at all: tests/component-studio-shell.test.tsx.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ViewAsSwitcher, announceRolesChanged } from "@/components/studio/ViewAsSwitcher";
import { resetUserCache } from "@/hooks/useUser";
import { VIEW_AS_COOKIE } from "@/lib/auth-mode";

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: "unauthenticated" }),
}));

// The picker only exists while authentication is off, so every test here is on
// that side of the switch. lib/auth-mode decides it once, from the
// environment, when it loads, and next/jest leaves it off.
jest.mock("../lib/auth-mode", () => ({
  ...jest.requireActual("../lib/auth-mode"),
  BYPASS_AUTH: true,
}));

/** The roles the server lists, in its order. Admin is one of them. */
const ROLES = [
  { name: "viewer", label: "Viewer" },
  { name: "editor", label: "Editor" },
  { name: "admin", label: "Admin" },
  { name: "qa-lead", label: "QA Lead" },
];

/** Every choice, as [value, what it says], when the list has loaded. */
const ALL_CHOICES = [
  ["admin", "Admin (everything)"],
  ["viewer", "Viewer"],
  ["editor", "Editor"],
  ["qa-lead", "QA Lead"],
];

/** What /api/me answers while the page is viewed as "QA Lead". */
const QA_LEAD_ME = {
  role: "qa-lead",
  roleLabel: "QA Lead",
  permissions: ["dashboard:read", "connections:read"],
  bypass: true,
  viewingAs: "qa-lead",
  org: { slug: "default", name: "Default" },
};

// The picker's own words, and the routes' (tests/view-as-routes.test.ts pins
// those from the server's side).
const LOAD_FAILED = "Could not load the roles. Try again in a moment.";
const SAVE_FAILED = "Could not switch roles. Try again in a moment.";
const LIST_DB_DOWN =
  "Could not load the roles, because the app's database did not answer. " +
  "Try again in a moment.";
const ME_DB_DOWN =
  "Could not check what your role can do, because the app's database did not answer. " +
  "Try again in a moment.";
const SWITCH_DB_DOWN =
  "Could not switch roles, because the app's database did not answer. " +
  "Try again in a moment.";
const ROLE_GONE =
  "That role does not exist any more. Reload the page to see the roles there are now.";

/** A body that is not JSON at all, like an HTML error page from a proxy. */
const NOT_JSON = Symbol("not JSON");

type Answer = { status: number; body: unknown };
type Reply = Answer | Promise<Answer> | "unreachable";

/** One request, as the server would see it. */
type Sent = { method: string; url: string; cache?: string; headers?: unknown; body?: unknown };

/** What each "METHOD /path" answers. A promise is a reply the test holds back. */
let replies: Record<string, Reply> = {};
let sent: Sent[] = [];

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const method = init?.method ?? "GET";
  const url = String(input);
  sent.push({
    method,
    url,
    cache: init?.cache,
    headers: init?.headers,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  });
  const reply = replies[`${method} ${url}`];
  if (reply === undefined) throw new Error(`Nothing in this test answers ${method} ${url}.`);
  if (reply === "unreachable") throw new TypeError("Failed to fetch");
  const { status, body } = await reply;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === NOT_JSON) throw new SyntaxError("Unexpected token '<'");
      return body;
    },
  };
}

/** A reply that waits until the test lets it go. */
function heldReply() {
  let release!: (answer: Answer) => void;
  const promise = new Promise<Answer>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

let consoleError: jest.SpyInstance;

/** Whether this console call is jsdom saying the page asked to reload. */
function isReload([first]: unknown[]) {
  const text = String((first as { message?: unknown } | null)?.message ?? first);
  return text.includes("Not implemented: navigation");
}

/** How many times the page has asked the browser to reload. */
const reloads = () => consoleError.mock.calls.filter(isReload).length;

const realFetch = globalThis.fetch;

beforeEach(() => {
  document.cookie = `${VIEW_AS_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  resetUserCache();
  sent = [];
  replies = {
    "GET /api/me/view-as": { status: 200, body: { viewingAs: null, roles: ROLES } },
    "POST /api/me/view-as": { status: 200, body: { viewingAs: null, roleLabel: "Admin" } },
  };
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Anything else on the console is a real problem: React warning about a
  // role listed twice, say, or about an update nobody waited for.
  const others = consoleError.mock.calls.filter((call) => !isReload(call));
  consoleError.mockRestore();
  globalThis.fetch = realFetch;
  expect(others).toEqual([]);
});

/** Leave the cookie a pick leaves, as if the page had reloaded after one. */
function viewingAs(role: string) {
  document.cookie = `${VIEW_AS_COOKIE}=${role}; path=/`;
}

const picker = () => screen.getByLabelText("View as") as HTMLSelectElement;

/** The choices on offer, as [value, what it says]. */
const choices = () =>
  Array.from(picker().options).map((option) => [option.value, option.textContent]);

/** The line under the picker that says what went wrong, if there is one. */
const problem = () => screen.queryByRole("status")?.textContent ?? null;

/** Pick a role, the way someone does with the mouse. */
function pick(role: string) {
  fireEvent.change(picker(), { target: { value: role } });
}

/** How many times the picker has asked for the list. */
const listLoads = () =>
  sent.filter((request) => request.method === "GET" && request.url === "/api/me/view-as").length;

describe("with nothing picked yet", () => {
  test("offers Admin first, then the roles there are, without Admin twice", async () => {
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));
    expect([picker().value, picker().disabled, problem()]).toEqual(["admin", false, null]);
  });

  test("asks for the list fresh every time, and asks nobody who the page is", async () => {
    // Fresh because a role deleted a minute ago must not be offered. And no
    // /api/me: with no cookie, the page is the full admin without asking.
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));
    expect(sent).toEqual([{ method: "GET", url: "/api/me/view-as", cache: "no-store" }]);
  });

  test("leaves out anything in the list that is not a role", async () => {
    replies["GET /api/me/view-as"] = {
      status: 200,
      body: { roles: [{ name: "viewer", label: "Viewer" }, { name: "x" }, { name: 5, label: "Five" }, null, "editor"] },
    };
    render(<ViewAsSwitcher />);
    await waitFor(() =>
      expect(choices()).toEqual([
        ["admin", "Admin (everything)"],
        ["viewer", "Viewer"],
      ])
    );
  });
});

describe("while viewing the app as a role", () => {
  test("says it is checking, and cannot be used, until the page knows who it is", async () => {
    // Picking now would be picking against an answer nobody has yet.
    viewingAs("qa-lead");
    const me = heldReply();
    replies["GET /api/me"] = me.promise;
    render(<ViewAsSwitcher />);
    expect([choices(), picker().disabled]).toEqual([[["", "Checking…"]], true]);

    await act(async () => me.release({ status: 200, body: QA_LEAD_ME }));
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));
    expect([picker().value, picker().disabled]).toEqual(["qa-lead", false]);
  });

  test("shows that role as picked, and lists it once", async () => {
    viewingAs("qa-lead");
    replies["GET /api/me"] = { status: 200, body: QA_LEAD_ME };
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(picker().value).toBe("qa-lead"));
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));
  });

  test("still shows that role, by its name, when the list could not be loaded", async () => {
    // Without it the picker would read "Admin" on a page drawn as QA Lead.
    viewingAs("qa-lead");
    replies["GET /api/me"] = { status: 200, body: QA_LEAD_ME };
    replies["GET /api/me/view-as"] = "unreachable";
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(problem()).toBe(LOAD_FAILED));
    expect([choices(), picker().value]).toEqual([
      [
        ["admin", "Admin (everything)"],
        ["qa-lead", "QA Lead"],
      ],
      "qa-lead",
    ]);
  });

  test("says Admin once the role it named has been deleted", async () => {
    // The server is the full admin again then, and /api/me says so.
    viewingAs("gone-role");
    replies["GET /api/me"] = {
      status: 200,
      body: { ...QA_LEAD_ME, role: "admin", roleLabel: "Admin", viewingAs: null },
    };
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));
    expect(picker().value).toBe("admin");
  });
});

describe("when the list cannot be loaded", () => {
  test.each<[string, Reply, string]>([
    ["the database did not answer", { status: 503, body: { error: LIST_DB_DOWN } }, LIST_DB_DOWN],
    ["the answer is not JSON", { status: 500, body: NOT_JSON }, LOAD_FAILED],
    ["the answer has no list in it", { status: 200, body: { viewingAs: null } }, LOAD_FAILED],
    ["the server cannot be reached", "unreachable", LOAD_FAILED],
  ])("says so when %s, and still offers Admin", async (_case, reply, says) => {
    replies["GET /api/me/view-as"] = reply;
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(problem()).toBe(says));
    expect([choices(), picker().value, picker().disabled]).toEqual([
      [["admin", "Admin (everything)"]],
      "admin",
      false,
    ]);
  });

  test("still offers Admin to someone viewing as a role while the database is down", async () => {
    // /api/me cannot read the role either, so the page holds nothing and calls
    // the role by its key. Admin stays on offer: the server switches back as
    // soon as its database answers (until then it says to try again, see
    // tests/view-as-routes.test.ts), and here it does.
    viewingAs("qa-lead");
    replies["GET /api/me"] = { status: 503, body: { error: ME_DB_DOWN } };
    replies["GET /api/me/view-as"] = { status: 503, body: { error: LIST_DB_DOWN } };
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(problem()).toBe(LIST_DB_DOWN));
    expect([choices(), picker().value]).toEqual([
      [
        ["admin", "Admin (everything)"],
        ["qa-lead", "qa-lead"],
      ],
      "qa-lead",
    ]);

    pick("admin");
    await waitFor(() => expect(reloads()).toBe(1));
    expect(sent[sent.length - 1]).toEqual({
      method: "POST",
      url: "/api/me/view-as",
      headers: { "Content-Type": "application/json" },
      body: { role: "admin" },
    });
  });
  test("says why a switch failed, rather than the older problem with the list", async () => {
    // A network blip: the list did not load, and then the switch did not go
    // through either. The switch is what the person just tried.
    viewingAs("qa-lead");
    replies["GET /api/me"] = { status: 200, body: QA_LEAD_ME };
    replies["GET /api/me/view-as"] = "unreachable";
    replies["POST /api/me/view-as"] = "unreachable";
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(problem()).toBe(LOAD_FAILED));

    pick("admin");
    await waitFor(() => expect(problem()).toBe(SAVE_FAILED));
    expect([picker().value, picker().disabled, reloads()]).toEqual(["qa-lead", false, 0]);
  });
});

describe("picking a role", () => {
  test("sends it to the server and holds the picker until it answers", async () => {
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));
    const answer = heldReply();
    replies["POST /api/me/view-as"] = answer.promise;

    pick("qa-lead");
    expect([picker().value, picker().disabled, reloads()]).toEqual(["qa-lead", true, 0]);
    expect(sent[sent.length - 1]).toEqual({
      method: "POST",
      url: "/api/me/view-as",
      headers: { "Content-Type": "application/json" },
      body: { role: "qa-lead" },
    });

    await act(async () =>
      answer.release({ status: 200, body: { viewingAs: "qa-lead", roleLabel: "QA Lead" } })
    );
    await waitFor(() => expect(reloads()).toBe(1));
  });

  test("stays held while the page reloads, so nobody picks twice", async () => {
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));
    pick("editor");
    await waitFor(() => expect(reloads()).toBe(1));
    expect([picker().value, picker().disabled]).toEqual(["editor", true]);
  });

  test("says why the server said no, and goes back to the role the page is drawn as", async () => {
    viewingAs("qa-lead");
    replies["GET /api/me"] = { status: 200, body: QA_LEAD_ME };
    replies["POST /api/me/view-as"] = { status: 503, body: { error: SWITCH_DB_DOWN } };
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));

    pick("viewer");
    await waitFor(() => expect(problem()).toBe(SWITCH_DB_DOWN));
    expect([picker().value, picker().disabled, reloads()]).toEqual(["qa-lead", false, 0]);
  });

  test.each<[string, Reply]>([
    ["is not JSON", { status: 500, body: NOT_JSON }],
    ["gives no reason", { status: 503, body: {} }],
    ["cannot be reached", "unreachable"],
  ])("says it could not switch when the server %s", async (_case, reply) => {
    replies["POST /api/me/view-as"] = reply;
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));

    pick("viewer");
    await waitFor(() => expect(problem()).toBe(SAVE_FAILED));
    expect([picker().value, picker().disabled, reloads()]).toEqual(["admin", false, 0]);
  });

  test("lets someone try again, and clears the old problem as they do", async () => {
    // The role was deleted in another tab. Picking another one is the way out.
    replies["POST /api/me/view-as"] = { status: 400, body: { error: ROLE_GONE } };
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));
    pick("qa-lead");
    await waitFor(() => expect(problem()).toBe(ROLE_GONE));

    replies["POST /api/me/view-as"] = { status: 200, body: { viewingAs: "viewer", roleLabel: "Viewer" } };
    pick("viewer");
    expect(problem()).toBeNull();
    await waitFor(() => expect(reloads()).toBe(1));
  });
});

describe("when the Roles tab makes or deletes a role", () => {
  /** The list the server has once Release Manager is made and QA Lead deleted. */
  const CHANGED = [
    { name: "viewer", label: "Viewer" },
    { name: "editor", label: "Editor" },
    { name: "admin", label: "Admin" },
    { name: "release-manager", label: "Release Manager" },
  ];
  const CHANGED_CHOICES = [
    ["admin", "Admin (everything)"],
    ["viewer", "Viewer"],
    ["editor", "Editor"],
    ["release-manager", "Release Manager"],
  ];

  test("loads the list again, so the new role is offered and the deleted one is not", async () => {
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));

    replies["GET /api/me/view-as"] = { status: 200, body: { viewingAs: null, roles: CHANGED } };
    act(() => announceRolesChanged());
    await waitFor(() => expect(choices()).toEqual(CHANGED_CHOICES));
    expect([listLoads(), picker().value, problem()]).toEqual([2, "admin", null]);
  });

  test("keeps the newest list when an older answer arrives after it", async () => {
    const first = heldReply();
    replies["GET /api/me/view-as"] = first.promise;
    render(<ViewAsSwitcher />);

    // The first load is still on its way when a role is made.
    replies["GET /api/me/view-as"] = { status: 200, body: { viewingAs: null, roles: CHANGED } };
    act(() => announceRolesChanged());
    await waitFor(() => expect(choices()).toEqual(CHANGED_CHOICES));

    await act(async () => {
      first.release({ status: 200, body: { viewingAs: null, roles: ROLES } });
      // Long enough for every step of the older load to have run.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect([choices(), problem()]).toEqual([CHANGED_CHOICES, null]);
  });

  test("clears the problem once the list does load", async () => {
    replies["GET /api/me/view-as"] = "unreachable";
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(problem()).toBe(LOAD_FAILED));

    replies["GET /api/me/view-as"] = { status: 200, body: { viewingAs: null, roles: CHANGED } };
    act(() => announceRolesChanged());
    await waitFor(() => expect(choices()).toEqual(CHANGED_CHOICES));
    expect(problem()).toBeNull();
  });

  test("keeps the list it has, and says so, when loading it again fails", async () => {
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));

    replies["GET /api/me/view-as"] = { status: 503, body: { error: LIST_DB_DOWN } };
    act(() => announceRolesChanged());
    await waitFor(() => expect(problem()).toBe(LIST_DB_DOWN));
    expect([choices(), picker().disabled]).toEqual([ALL_CHOICES, false]);
  });

  test("still says why a switch failed after the list loads again", async () => {
    // The list loading is not news about the switch, which still did not happen.
    replies["POST /api/me/view-as"] = { status: 503, body: { error: SWITCH_DB_DOWN } };
    render(<ViewAsSwitcher />);
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));
    pick("viewer");
    await waitFor(() => expect(problem()).toBe(SWITCH_DB_DOWN));

    replies["GET /api/me/view-as"] = { status: 200, body: { viewingAs: null, roles: CHANGED } };
    act(() => announceRolesChanged());
    await waitFor(() => expect(choices()).toEqual(CHANGED_CHOICES));
    expect(problem()).toBe(SWITCH_DB_DOWN);
  });

  test("stops listening once the picker is gone", async () => {
    const { unmount } = render(<ViewAsSwitcher />);
    await waitFor(() => expect(choices()).toEqual(ALL_CHOICES));
    unmount();

    announceRolesChanged();
    expect(listLoads()).toBe(1);
  });
});
