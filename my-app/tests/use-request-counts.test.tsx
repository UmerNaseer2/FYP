/**
 * @jest-environment jsdom
 */
// The number beside Requests in the rail. The app sends no email, so this number
// is how someone finds out that something is waiting on them, or that their own
// request was answered. It has to stay current without anyone reloading.
import "@testing-library/jest-dom";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRequestCounts } from "@/hooks/useRequestCounts";
import { REQUESTS_CHANGED_EVENT } from "@/lib/access-requests";
import { fetchCalls, flushAsync, holdNext, resetPageState, setRoutes } from "./helpers/render-page";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

const COUNTS = "/api/requests?only=counts";
const answering = (waiting: number, answered: number) =>
  setRoutes([{ match: COUNTS, body: { counts: { waiting, answered } } }]);
const reads = () => fetchCalls.filter((c) => c.url.includes(COUNTS)).length;
const draw = (enabled = true, pathname = "/acme/studio") =>
  renderHook((props: { enabled: boolean; pathname: string }) =>
    useRequestCounts(props.enabled, props.pathname), { initialProps: { enabled, pathname } });

beforeEach(() => resetPageState());

describe("what the number counts", () => {
  it("adds what is waiting to the answers not yet read", async () => {
    answering(2, 1);
    const { result } = draw();
    await waitFor(() => expect(result.current).toBe(3));
  });

  it("counts either one alone", async () => {
    answering(0, 4);
    const { result } = draw();
    await waitFor(() => expect(result.current).toBe(4));
  });

  it("reads a garbled answer as nothing waiting", async () => {
    setRoutes([{ match: COUNTS, body: { counts: { waiting: "lots" } } }]);
    const { result } = draw();
    await flushAsync();
    expect(reads()).toBe(1);
    expect(result.current).toBe(0);
  });
});

describe("when it is read", () => {
  it("asks nothing while it is switched off", async () => {
    answering(2, 1);
    const { result } = draw(false);
    await flushAsync();
    expect(reads()).toBe(0);
    expect(result.current).toBe(0);
  });

  it("reads again on moving to another page", async () => {
    answering(1, 0);
    const { result, rerender } = draw();
    await waitFor(() => expect(result.current).toBe(1));

    answering(2, 0);
    rerender({ enabled: true, pathname: "/acme/drift" });
    await waitFor(() => expect(result.current).toBe(2));
  });

  it("reads again on coming back to the window", async () => {
    answering(1, 0);
    const { result } = draw();
    await waitFor(() => expect(result.current).toBe(1));

    answering(5, 0);
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current).toBe(5));
  });

  it("reads again when the Requests page says something changed", async () => {
    answering(1, 0);
    const { result } = draw();
    await waitFor(() => expect(result.current).toBe(1));

    answering(0, 0);
    act(() => void window.dispatchEvent(new Event(REQUESTS_CHANGED_EVENT)));
    await waitFor(() => expect(result.current).toBe(0));
  });

  it("stops listening once it is gone", async () => {
    answering(1, 0);
    const { result, unmount } = draw();
    await waitFor(() => expect(result.current).toBe(1));
    unmount();

    const before = reads();
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event(REQUESTS_CHANGED_EVENT));
    await flushAsync();
    expect(reads()).toBe(before);
  });

  it("goes back to nothing the moment it is switched off", async () => {
    answering(3, 0);
    const { result, rerender } = draw();
    await waitFor(() => expect(result.current).toBe(3));

    rerender({ enabled: false, pathname: "/acme/studio" });
    expect(result.current).toBe(0);
  });

  it("does not let a slow old answer replace a newer one", async () => {
    answering(1, 0);
    const release = holdNext(COUNTS);
    const { result, rerender } = draw();

    answering(7, 0);
    rerender({ enabled: true, pathname: "/acme/drift" });
    await waitFor(() => expect(result.current).toBe(7));

    release();
    await flushAsync();
    expect(result.current).toBe(7);
  });
});

describe("when the read fails", () => {
  it("shows nothing for a refusal, because the rail is no place for an error", async () => {
    setRoutes([{ match: COUNTS, status: 500, body: { error: "Could not load requests." } }]);
    const { result } = draw();
    await flushAsync();
    expect(reads()).toBe(1);
    expect(result.current).toBe(0);
  });

  it("shows nothing when the network is down", async () => {
    setRoutes([{ match: COUNTS, networkError: true }]);
    const { result } = draw();
    await flushAsync();
    expect(reads()).toBe(1);
    expect(result.current).toBe(0);
  });

  it("clears the number when a later read fails", async () => {
    answering(4, 0);
    const { result, rerender } = draw();
    await waitFor(() => expect(result.current).toBe(4));

    setRoutes([{ match: COUNTS, networkError: true }]);
    rerender({ enabled: true, pathname: "/acme/drift" });
    await waitFor(() => expect(result.current).toBe(0));
  });
});
