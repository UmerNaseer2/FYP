/** @jest-environment jsdom */

/**
 * The logo reveal: the mark builds itself in the middle of the screen, then
 * flies to the top of the sidebar.
 *
 * jsdom has no Element.animate and no layout, so the flight itself is not
 * here. What is here is the part that can leave somebody stuck: when it plays,
 * that it always ends (on its own, on a click, on Esc, when the page goes
 * away), and that the page never stays hidden behind it.
 *
 * What is NOT here:
 *  - How it looks: app/globals.css (.boot and the bt-* rules).
 *  - The account menu's "Replay intro": tests/component-account-menu.test.tsx.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

import LogoIntro from "@/components/studio/LogoIntro";
import {
  INTRO_HEAD_SCRIPT,
  INTRO_SEEN_KEY,
  replayIntro,
  resetIntro,
  takeIntroTurn,
} from "@/lib/intro";

const html = document.documentElement;
const overlay = () => screen.queryByTestId("logo-intro");

/** What the head script in app/layout.tsx does before the page is drawn. */
function runHeadScript() {
  new Function(INTRO_HEAD_SCRIPT)();
}

let reducedMotion = false;

beforeEach(() => {
  jest.useFakeTimers();
  sessionStorage.clear();
  html.removeAttribute("data-intro");
  reducedMotion = false;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce") && reducedMotion,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  jest.useRealTimers();
});

describe("the head script", () => {
  test("marks a fresh tab as waiting for the intro", () => {
    runHeadScript();
    expect(html).toHaveAttribute("data-intro", "pending");
  });

  test("leaves a tab that has seen it alone", () => {
    sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    runHeadScript();
    expect(html).not.toHaveAttribute("data-intro");
  });
});

describe("taking a turn", () => {
  test("only when the head script asked for one, and then never again in this tab", () => {
    expect(takeIntroTurn()).toBe(false);
    runHeadScript();
    expect(takeIntroTurn()).toBe(true);
    expect(sessionStorage.getItem(INTRO_SEEN_KEY)).toBe("1");
    html.removeAttribute("data-intro");
    runHeadScript();
    expect(takeIntroTurn()).toBe(false);
  });

  test("signing in again forgets it was seen", () => {
    sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    resetIntro();
    runHeadScript();
    expect(html).toHaveAttribute("data-intro", "pending");
  });
});

describe("playing it", () => {
  test("plays nothing on a page that was not waiting for it", () => {
    render(<LogoIntro />);
    expect(overlay()).toBeNull();
  });

  test("plays when the page was waiting, and shows the studio under it", () => {
    runHeadScript();
    render(<LogoIntro />);
    expect(overlay()).toBeInTheDocument();
    expect(overlay()).toHaveAccessibleName("Schema Studio is opening");
    // "pending" hides the studio. Once the overlay is up it must not.
    expect(html).toHaveAttribute("data-intro", "playing");
  });

  test("ends on its own after the hold", () => {
    runHeadScript();
    render(<LogoIntro />);
    act(() => {
      jest.advanceTimersByTime(2399);
    });
    expect(overlay()).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(overlay()).toBeNull();
  });

  test("holds for less than a second with reduced motion", () => {
    reducedMotion = true;
    runHeadScript();
    render(<LogoIntro />);
    act(() => {
      jest.advanceTimersByTime(900);
    });
    expect(overlay()).toBeNull();
  });

  test("a click skips it", () => {
    runHeadScript();
    render(<LogoIntro />);
    fireEvent.click(overlay()!);
    expect(overlay()).toBeNull();
  });

  test("Esc skips it", () => {
    runHeadScript();
    render(<LogoIntro />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(overlay()).toBeNull();
  });

  test("takes its mark off the page shortly after it ends", () => {
    runHeadScript();
    render(<LogoIntro />);
    fireEvent.click(overlay()!);
    expect(html).toHaveAttribute("data-intro");
    act(() => {
      jest.advanceTimersByTime(900);
    });
    expect(html).not.toHaveAttribute("data-intro");
  });

  test("never leaves the studio hidden when the page goes away mid-intro", () => {
    runHeadScript();
    const { unmount } = render(<LogoIntro />);
    unmount();
    expect(html).not.toHaveAttribute("data-intro");
  });
});

describe("playing it again", () => {
  test('"Replay intro" plays it in a tab that has already seen it', () => {
    sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    render(<LogoIntro />);
    expect(overlay()).toBeNull();
    act(() => {
      replayIntro();
    });
    expect(overlay()).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(overlay()).toBeNull();
  });
});
