// What every page suite needs to put a screen on a DOM.
//
// The pages under test are all client components that fetch on mount, so three
// things have to be stood in for before one can render at all:
//
//   • next/navigation — useSearchParams, useRouter and usePathname all come
//     from a router that only exists inside a running Next app.
//   • next-auth/react — useSession. next-auth ships as ESM that Jest cannot
//     load, which is the same reason every route test in here replaces it.
//   • fetch — jsdom does not provide one, and a page that reached the network
//     from a test would be a test that passes or fails depending on whether a
//     database happens to be up.
//
// This file is not a test itself: Jest only runs tests/**/*.test.ts(x).

import { act } from "react";

/* ------------------------------------------------------------------ routing */

/** Every push/replace the page asked for, newest last. */
export const routerCalls: { push: string[]; replace: string[]; refresh: number } = {
  push: [],
  replace: [],
  refresh: 0,
};

let searchParams = new URLSearchParams();
let pathname = "/studio";

/** Set the query string the page reads on mount. Call before render. */
export function setSearchParams(query: string) {
  searchParams = new URLSearchParams(query);
}

/** Set the path usePathname reports. Call before render. */
export function setPathname(value: string) {
  pathname = value;
}

/**
 * What a suite hands jest.mock("next/navigation"). The values above are read
 * when a hook is CALLED, not when this object is built, so a test can still
 * change them between renders — which a jest.mock factory could not do on its
 * own, because that factory is hoisted above every import in its file and may
 * not close over anything declared there.
 */
export const navigationStubs = {
  useRouter: () => ({
    push: (href: string) => routerCalls.push.push(href),
    replace: (href: string) => routerCalls.replace.push(href),
    refresh: () => {
      routerCalls.refresh += 1;
    },
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
  useSearchParams: () => searchParams,
  usePathname: () => pathname,
};

/* ------------------------------------------------------------------ session */

export type TestRole = "viewer" | "editor" | "admin";

let session: { user: { email: string; name: string; role: TestRole } } | null = {
  user: { email: "tester@example.com", name: "Tester", role: "admin" },
};
let sessionStatus: "authenticated" | "unauthenticated" | "loading" = "authenticated";

/**
 * Who the page thinks is signed in. Call before render.
 *
 * Worth knowing why this works at all: `lib/auth-mode` reads
 * NEXT_PUBLIC_AUTH_BYPASS once, at module load, and next/jest does not load
 * .env.local under NODE_ENV=test — so in here the variable is unset, which
 * since the allow-list landed means BYPASS_AUTH is false. useUser therefore
 * takes the real session path and these roles are the ones the page sees. With
 * the old default it would have reported an admin bypass whatever this said,
 * and no role gate on any screen could have been tested.
 */
export function setUser(role: TestRole | null) {
  if (role === null) {
    session = null;
    sessionStatus = "unauthenticated";
    return;
  }
  session = { user: { email: `${role}@example.com`, name: `A ${role}`, role } };
  sessionStatus = "authenticated";
}

export const sessionStubs = {
  useSession: () => ({ data: session, status: sessionStatus }),
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
  SessionProvider: ({ children }: { children: unknown }) => children,
};

/* -------------------------------------------------------------------- fetch */

/** One canned answer: the first route whose pattern matches the request wins. */
export type FetchRoute = {
  /** Matched against the request URL, so "/api/connections" matches a query too. */
  match: RegExp | string;
  /**
   * Only answer this method. Omit to answer any of them.
   *
   * Needed more often than it looks: these pages read and write the same path
   * — /api/admin/users is a GET, a PUT and a DELETE — so without this a suite
   * cannot make the write fail while the read still succeeds.
   */
  method?: string;
  /** Defaults to 200. */
  status?: number;
} & (
  | {
      /** Parsed JSON body, or a function of the request for a reply that varies. */
      body: unknown | ((url: string, init?: RequestInit) => unknown);
      networkError?: false;
    }
  /**
   * Reject instead of answering, the way a dropped connection arrives. Written
   * as the other half of a union rather than as one more optional field so that
   * a route with no body at all is a type error unless it is this one: an
   * answer nobody wrote is the sort of empty state a page renders happily while
   * the test proves nothing.
   */
  | { networkError: true; body?: undefined }
);

/** Every request the page made, in order. */
export const fetchCalls: { url: string; method: string; body: string | null }[] = [];

let routes: FetchRoute[] = [];

/** One withheld answer, waiting for the request it belongs to and then for release(). */
type Gate = { token: string; method?: string; claimed: boolean; wait: Promise<void> };
const gates: Gate[] = [];

/**
 * Answer these routes and nothing else. A request no route matches fails the
 * test rather than returning an empty object: a page quietly rendering an
 * empty state because a URL was misspelled here is exactly the kind of test
 * that passes while proving nothing.
 */
export function setRoutes(next: FetchRoute[]) {
  routes = next;
}

/**
 * Withhold the answer to the NEXT request whose URL contains `token` (and whose
 * method matches, if one is given), and return a release() for it.
 *
 * This is what makes a race testable: hold one request, start a second, let the
 * second finish, then release the first and check whose answer is on screen.
 * Without it the two always resolve in the order they were made, and the bug
 * the guard exists for cannot be reproduced at all.
 *
 * One request per call, deliberately. The interesting races here are between a
 * page's own two reads of the SAME url — a poll and the reload after a save —
 * so a hold that covered every matching request would catch the second one too
 * and there would be nothing left to overtake it. Call it twice to hold two.
 */
export function holdNext(token: string, method?: string): () => void {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  gates.push({ token, method, claimed: false, wait });
  return release;
}

function answerFor(url: string, init?: RequestInit) {
  const method = (init?.method ?? "GET").toUpperCase();
  for (const route of routes) {
    const hit =
      typeof route.match === "string" ? url.includes(route.match) : route.match.test(url);
    if (!hit) continue;
    if (route.method && route.method.toUpperCase() !== method) continue;
    if (route.networkError) throw new Error("network");
    const body = typeof route.body === "function" ? route.body(url, init) : route.body;
    return { status: route.status ?? 200, body };
  }
  throw new Error(`No test route answers ${method} ${url}`);
}

function installFetch() {
  fetchCalls.length = 0;
  (globalThis as { fetch: unknown }).fetch = (input: unknown, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });

    // Resolved before the gate is awaited, so a route's `body` function sees
    // the state at the time of the REQUEST — which is the whole point of
    // holding one: the answer must be the old target's answer, not a fresh one
    // computed after the page moved on.
    let answer: { status: number; body: unknown };
    try {
      answer = answerFor(url, init);
    } catch (err) {
      return Promise.reject(err);
    }

    const method = (init?.method ?? "GET").toUpperCase();
    const gate = gates.find(
      (g) =>
        !g.claimed && url.includes(g.token) && (!g.method || g.method.toUpperCase() === method)
    );
    if (gate) gate.claimed = true;
    const ready = gate ? gate.wait : Promise.resolve();

    return ready.then(() => ({
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: () => Promise.resolve(answer.body),
      text: () => Promise.resolve(JSON.stringify(answer.body)),
    }));
  };
}

/**
 * Let every promise chain that has already settled run to the end.
 *
 * For the assertion a race test finishes on, which is that a released stale
 * answer changed NOTHING. There is no new text to wait for, so waitFor has
 * nothing to poll and an immediate assertion would pass before the stale
 * handler had even run. A timeout of 0 is a macrotask, so everything queued
 * behind it — the reply, its .json(), the setState it leads to — is done by the
 * time this returns.
 */
export async function flushAsync() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/* ----------------------------------------------------------------- the setup */

/**
 * Call once at the top of a page suite, OUTSIDE any describe, next to the
 * jest.mock calls it exists to feed:
 *
 *     jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
 *     jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
 *
 * They cannot live in here because jest.mock is hoisted to the top of the file
 * it appears in, so it only ever applies to that file.
 */
export function resetPageState() {
  routerCalls.push.length = 0;
  routerCalls.replace.length = 0;
  routerCalls.refresh = 0;
  searchParams = new URLSearchParams();
  pathname = "/studio";
  setUser("admin");
  routes = [];
  gates.length = 0;
  installFetch();
}
