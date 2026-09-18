/** @jest-environment jsdom */

/**
 * The light/dark switch, and the one thing it has to get right.
 *
 * The palette is defined against `<html data-theme>`, so the theme is not a
 * React value that components read — it is an attribute on the document, and
 * the hook's real job is keeping three things saying the same thing: the
 * attribute, the `theme` it hands back for the rail's own wording, and what
 * localStorage will say on the next visit. Any two of those agreeing while the
 * third does not is a user watching the app change colour and change back.
 *
 * The read is deliberately on mount rather than during render: the server
 * always renders "dark", so reading localStorage while rendering would produce
 * markup the server never sent and break hydration. That is why the first paint
 * of a light-theme user is dark, and why the check below for "nothing saved"
 * asserts the attribute is left alone rather than set to "dark" — the root
 * layout has already put it there, and writing it again from here would be the
 * hook claiming a choice nobody made.
 *
 * Both localStorage calls are wrapped in try/catch, which is not defensive
 * padding: Safari in private browsing has a localStorage object that throws on
 * use, and an app that goes blank there rather than simply forgetting your
 * theme is a bad trade.
 *
 * What is NOT here:
 *  - That "light" actually looks different. The palette is CSS and jsdom
 *    applies no stylesheet; what is checked is the attribute the stylesheet
 *    keys off.
 *  - The rail's wording and icon around this value:
 *    tests/component-studio-sidebar.test.tsx.
 *  - The shell wiring the toggle to that rail:
 *    tests/component-studio-shell.test.tsx.
 *  - The export bar borrowing the light palette for the duration of a print,
 *    which writes the same attribute from outside this hook:
 *    tests/component-export-bar.test.tsx.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { useTheme } from "@/hooks/useTheme";

/** The hook has no UI of its own, so give it the smallest one that shows both halves. */
function Probe() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" onClick={toggleTheme}>
      {theme}
    </button>
  );
}

const root = () => document.documentElement;
const shown = () => screen.getByRole("button").textContent;
const toggle = () => fireEvent.click(screen.getByRole("button"));

beforeEach(() => {
  localStorage.clear();
  root().removeAttribute("data-theme");
});

afterEach(() => {
  root().removeAttribute("data-theme");
});

describe("what it finds on the way in", () => {
  test("starts dark, and leaves the document alone, when nothing was ever saved", () => {
    render(<Probe />);
    expect(shown()).toBe("dark");
    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  test("restores a saved light theme onto the document", () => {
    localStorage.setItem("ss-theme", "light");
    render(<Probe />);
    expect(shown()).toBe("light");
    expect(root()).toHaveAttribute("data-theme", "light");
  });

  test("restores a saved dark theme just as deliberately", () => {
    // "dark" is also the starting state, so the value handed back proves
    // nothing here — the attribute is what shows the saved choice was applied
    // rather than merely happening to match.
    localStorage.setItem("ss-theme", "dark");
    render(<Probe />);
    expect(root()).toHaveAttribute("data-theme", "dark");
  });

  test("ignores a saved value that is not a theme", () => {
    // Somebody else's key collision, or a value from a future version of the
    // app. Putting it on <html> would select no palette at all.
    localStorage.setItem("ss-theme", "solarized");
    render(<Probe />);
    expect(shown()).toBe("dark");
    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  test("ignores an empty saved value", () => {
    localStorage.setItem("ss-theme", "");
    render(<Probe />);
    expect(shown()).toBe("dark");
    expect(root().hasAttribute("data-theme")).toBe(false);
  });
});

describe("the toggle", () => {
  test("moves the document and the value it reports together", () => {
    render(<Probe />);
    toggle();
    expect(shown()).toBe("light");
    expect(root()).toHaveAttribute("data-theme", "light");
  });

  test("goes back again", () => {
    render(<Probe />);
    toggle();
    toggle();
    expect(shown()).toBe("dark");
    expect(root()).toHaveAttribute("data-theme", "dark");
  });

  test("remembers the choice under the key the next visit reads", () => {
    render(<Probe />);
    toggle();
    expect(localStorage.getItem("ss-theme")).toBe("light");
    toggle();
    expect(localStorage.getItem("ss-theme")).toBe("dark");
  });
});

describe("a browser that will not store anything", () => {
  // Safari's private mode hands out a localStorage whose methods throw rather
  // than one that is missing, so there is nothing to feature-detect first.
  const realGet = Storage.prototype.getItem;
  const realSet = Storage.prototype.setItem;

  afterEach(() => {
    Storage.prototype.getItem = realGet;
    Storage.prototype.setItem = realSet;
  });

  test("still starts up when the read throws", () => {
    Storage.prototype.getItem = () => {
      throw new DOMException("denied");
    };
    render(<Probe />);
    expect(shown()).toBe("dark");
  });

  test("still changes theme when the write throws", () => {
    // The choice is lost on the next visit, which is the part that genuinely
    // cannot be helped. Losing the current one as well is not.
    Storage.prototype.setItem = () => {
      throw new DOMException("denied");
    };
    render(<Probe />);
    toggle();
    expect(shown()).toBe("light");
    expect(root()).toHaveAttribute("data-theme", "light");
  });
});
