/** @jest-environment jsdom */

/**
 * The combobox every picker in the app is built from.
 *
 * It is a select-only combobox written by hand rather than a <select>, because
 * the screens need labels that differ from values, a mono variant for
 * identifiers, and a listbox that can be styled. Writing one by hand means
 * owning the parts a <select> gives away free: the keyboard, the open/closed
 * state, and the hidden input that lets a plain <form> still submit without JS.
 *
 * Two of those are load-bearing well beyond this file. The Compare screen is a
 * GET form whose pickers ARE the query string, so a hidden input that lags
 * behind what the trigger shows submits a comparison nobody asked for. And the
 * trigger shows a label while the form sends a value, so a picker that showed
 * the value — or fell back to the placeholder when a value went missing from
 * the list — would read as "nothing chosen" over a schema that is very much
 * chosen.
 *
 * What is NOT here:
 *  - That focus stays on the trigger while the list is open, which is what
 *    makes aria-activedescendant the right pattern. jsdom has no focus ring and
 *    fireEvent does not move focus, so a test here would asserting nothing.
 *    The active option's id is checked instead, which is the half that can
 *    actually go wrong in the markup.
 *  - scrollIntoView keeping the active option visible. jsdom has no layout, so
 *    the call is stubbed in tests/helpers/jsdom-gaps.ts and there is nothing to
 *    observe.
 *  - Typeahead (jumping to an option by typing its first letters). The
 *    component does not implement it; a test would be describing a feature that
 *    is not there.
 *  - The two `if (disabled) return` guards inside the component. Nothing can
 *    reach them: React does not deliver events to a button carrying the
 *    disabled attribute, so the attribute stops everything first. Removing
 *    either guard leaves the suite green, and removing the attribute does not
 *    — which is the honest reading of the test below. The guards are not dead
 *    weight, though: a later switch to aria-disabled (what you use when a
 *    disabled control still needs to be focusable) would keep the trigger
 *    live, and they are what would stop it then.
 *  - The variant and mono classes, which are appearance. The one class asserted
 *    below is the placeholder's, because it is the only one that changes what
 *    the text MEANS.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { Select } from "@/components/ui/Select";

const FRUIT = [
  { value: "a", label: "Apple" },
  { value: "b", label: "Banana" },
  { value: "c", label: "Cherry" },
];

const trigger = () => screen.getByRole("combobox");
const optionNamed = (name: string) => screen.getByRole("option", { name });

afterEach(() => cleanup());

describe("opening and closing", () => {
  it("starts closed and says so", () => {
    render(<Select value="a" options={FRUIT} ariaLabel="Fruit" />);

    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // aria-controls is dropped rather than left pointing at an element that is
    // not in the document, which a screen reader would follow to nothing.
    expect(trigger()).not.toHaveAttribute("aria-controls");
  });

  it("opens on a click and points at the list it opened", () => {
    render(<Select value="a" options={FRUIT} ariaLabel="Fruit" />);

    fireEvent.click(trigger());
    const list = screen.getByRole("listbox");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(trigger()).toHaveAttribute("aria-controls", list.id);
    expect(within(list).getAllByRole("option")).toHaveLength(3);
  });

  it("closes on a second click", () => {
    render(<Select value="a" options={FRUIT} ariaLabel="Fruit" />);

    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes on Escape without picking anything", () => {
    const picked: string[] = [];
    render(<Select value="a" options={FRUIT} ariaLabel="Fruit" onChange={(v) => picked.push(v)} />);

    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(trigger(), { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // Escape is the way out for someone who opened the wrong picker. Committing
    // whatever happened to be under the cursor would make it the way in.
    expect(picked).toEqual([]);
  });

  it("closes on Tab, and lets the focus move on", () => {
    render(<Select value="a" options={FRUIT} ariaLabel="Fruit" />);

    fireEvent.click(trigger());
    const tab = fireEvent.keyDown(trigger(), { key: "Tab" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // Every other key in the open list is preventDefault'ed. Tab must not be,
    // or the list closes and the focus stays put — a trap with no keyboard way
    // out of it.
    expect(tab).toBe(true);
  });

  it("closes when a pointer goes down outside it", () => {
    render(
      <>
        <Select value="a" options={FRUIT} ariaLabel="Fruit" />
        <button type="button">Somewhere else</button>
      </>
    );

    fireEvent.click(trigger());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Somewhere else" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("stays open for a pointer inside it", () => {
    // The pick itself is a pointerdown inside the list. Closing on that would
    // unmount the option before the click that commits it ever lands.
    render(<Select value="a" options={FRUIT} ariaLabel="Fruit" />);

    fireEvent.click(trigger());
    fireEvent.pointerDown(optionNamed("Banana"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("will not open at all while disabled", () => {
    // What holds this shut is the attribute, not the guards inside the
    // handlers — see the header. So the attribute is what is asserted.
    render(<Select value="a" options={FRUIT} ariaLabel="Fruit" disabled />);

    expect(trigger()).toBeDisabled();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("the keyboard", () => {
  it("opens on any of the four keys that mean open", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", " "]) {
      render(<Select value="a" options={FRUIT} ariaLabel="Fruit" />);
      fireEvent.keyDown(trigger(), { key });
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      cleanup();
    }
  });

  it("starts from the option already chosen, not from the top", () => {
    // Arrowing down from a mid-list selection has to reach the NEXT option. A
    // list that always opened on index 0 would move the picker two steps back
    // on every keyboard pick.
    render(<Select value="b" options={FRUIT} ariaLabel="Fruit" />);

    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(trigger()).toHaveAttribute("aria-activedescendant", optionNamed("Banana").id);

    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(trigger()).toHaveAttribute("aria-activedescendant", optionNamed("Cherry").id);
  });

  it("stops at both ends instead of wrapping", () => {
    render(<Select value="a" options={FRUIT} ariaLabel="Fruit" />);
    fireEvent.click(trigger());

    fireEvent.keyDown(trigger(), { key: "ArrowUp" });
    expect(trigger()).toHaveAttribute("aria-activedescendant", optionNamed("Apple").id);

    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(trigger()).toHaveAttribute("aria-activedescendant", optionNamed("Cherry").id);
  });

  it("jumps to either end on Home and End", () => {
    render(<Select value="a" options={FRUIT} ariaLabel="Fruit" />);
    fireEvent.click(trigger());

    fireEvent.keyDown(trigger(), { key: "End" });
    expect(trigger()).toHaveAttribute("aria-activedescendant", optionNamed("Cherry").id);

    fireEvent.keyDown(trigger(), { key: "Home" });
    expect(trigger()).toHaveAttribute("aria-activedescendant", optionNamed("Apple").id);
  });

  it("opens where it is without moving off it", () => {
    // The ArrowDown that opens the list does not also step down it. Someone
    // pressing it to see their options would otherwise land one past the
    // option they already had, and Enter would change a choice they only
    // meant to look at.
    const picked: string[] = [];
    render(<Select value="b" options={FRUIT} ariaLabel="Fruit" onChange={(v) => picked.push(v)} />);

    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(picked).toEqual(["b"]);
  });

  it("commits the active option on Enter", () => {
    const picked: string[] = [];
    render(<Select value="a" options={FRUIT} ariaLabel="Fruit" onChange={(v) => picked.push(v)} />);

    fireEvent.keyDown(trigger(), { key: "ArrowDown" }); // opens, on Apple
    fireEvent.keyDown(trigger(), { key: "ArrowDown" }); // now moves, to Banana
    fireEvent.keyDown(trigger(), { key: "Enter" });

    expect(picked).toEqual(["b"]);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("commits it on Space too", () => {
    // Space opens a closed list and commits an open one. Both are what a
    // <select> does, and this is the picker people reach for by keyboard.
    const picked: string[] = [];
    render(<Select value="a" options={FRUIT} ariaLabel="Fruit" onChange={(v) => picked.push(v)} />);

    fireEvent.keyDown(trigger(), { key: " " });
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(trigger(), { key: " " });

    expect(picked).toEqual(["b"]);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("ignores a key that means nothing here", () => {
    render(<Select value="a" options={FRUIT} ariaLabel="Fruit" />);
    fireEvent.click(trigger());

    fireEvent.keyDown(trigger(), { key: "x" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-activedescendant", optionNamed("Apple").id);
  });
});

describe("what the trigger shows", () => {
  it("shows the label while the form sends the value", () => {
    render(<Select name="fruit" value="b" options={FRUIT} ariaLabel="Fruit" />);

    expect(trigger()).toHaveTextContent("Banana");
    expect(document.querySelector('input[name="fruit"]')).toHaveValue("b");
  });

  it("shows a value that is not in the list rather than the placeholder", () => {
    // A schema that has been dropped from the target, or a connection whose
    // list has not loaded yet. Falling back to "Select…" would read as nothing
    // chosen over a choice that is very much still in the query string.
    render(
      <Select value="shop_dev" options={FRUIT} ariaLabel="Fruit" placeholder="Pick a fruit" />
    );

    expect(trigger()).toHaveTextContent("shop_dev");
    expect(trigger().querySelector(".ds-select__placeholder")).toBeNull();
  });

  it("shows the placeholder only when nothing is chosen at all", () => {
    render(<Select value="" options={FRUIT} ariaLabel="Fruit" placeholder="Pick a fruit" />);

    expect(trigger()).toHaveTextContent("Pick a fruit");
    expect(trigger().querySelector(".ds-select__placeholder")).not.toBeNull();
  });

  it("falls back to its own wording when there is no placeholder either", () => {
    render(<Select value="" options={FRUIT} ariaLabel="Fruit" />);

    expect(trigger()).toHaveTextContent("Select…");
  });
});

describe("the value it holds", () => {
  it("reports a pick and closes", () => {
    const picked: string[] = [];
    render(<Select value="a" options={FRUIT} ariaLabel="Fruit" onChange={(v) => picked.push(v)} />);

    fireEvent.click(trigger());
    fireEvent.click(optionNamed("Cherry"));

    expect(picked).toEqual(["c"]);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveTextContent("Cherry");
  });

  it("moves the hidden input the moment the pick happens", () => {
    // The Compare screen submits a plain GET form, so this input is what the
    // comparison actually runs on. If it waited for the parent to send a new
    // `value` prop back down, a submit in between would compare the old pair
    // while the screen showed the new one.
    render(<Select name="fruit" value="a" options={FRUIT} ariaLabel="Fruit" />);

    fireEvent.click(trigger());
    fireEvent.click(optionNamed("Banana"));
    expect(document.querySelector('input[name="fruit"]')).toHaveValue("b");
  });

  it("has no hidden input when it is not part of a form", () => {
    const { container } = render(<Select value="a" options={FRUIT} ariaLabel="Fruit" />);

    // An unnamed hidden input would be submitted by a surrounding form under
    // whatever name a later edit gave it, which is how a picker starts sending
    // a field nobody meant to send.
    expect(container.querySelector('input[type="hidden"]')).toBeNull();
  });

  it("takes a new value from the parent", () => {
    // The parent is the source of truth after a server round trip: Compare
    // re-renders from the screen it got back, and a picker holding its own
    // stale pick would disagree with the comparison shown beside it.
    const { rerender } = render(<Select value="a" options={FRUIT} ariaLabel="Fruit" />);
    expect(trigger()).toHaveTextContent("Apple");

    rerender(<Select value="c" options={FRUIT} ariaLabel="Fruit" />);
    expect(trigger()).toHaveTextContent("Cherry");
  });

  it("keeps a pick through a re-render that sends the same value back", () => {
    // The parent re-renders for reasons that have nothing to do with this
    // picker — a spinner, a sibling field, a poll coming back. The re-seed
    // effect is keyed on the value prop, so an unchanged one must leave the
    // pick alone. Snapping back to the parent's value on every parent render
    // would undo the choice a moment after it was made.
    const { rerender } = render(<Select value="a" options={FRUIT} ariaLabel="Fruit" />);

    fireEvent.click(trigger());
    fireEvent.click(optionNamed("Cherry"));
    rerender(<Select value="a" options={FRUIT} ariaLabel="Fruit" />);

    expect(trigger()).toHaveTextContent("Cherry");
  });

  it("ticks the chosen option and only that one", () => {
    render(<Select value="b" options={FRUIT} ariaLabel="Fruit" />);
    fireEvent.click(trigger());

    expect(optionNamed("Banana")).toHaveAttribute("aria-selected", "true");
    expect(optionNamed("Apple")).toHaveAttribute("aria-selected", "false");
    expect(optionNamed("Cherry")).toHaveAttribute("aria-selected", "false");
  });
});

describe("an empty list", () => {
  it("says there are none instead of showing an empty box", () => {
    render(<Select value="" options={[]} ariaLabel="Fruit" />);
    fireEvent.click(trigger());

    expect(screen.getByText("No options")).toBeInTheDocument();
    // Not an option: it is a sentence about the list, and a screen reader
    // counting it as one would announce a choice that cannot be made.
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("commits nothing when Enter lands on it", () => {
    const picked: string[] = [];
    render(<Select value="" options={[]} ariaLabel="Fruit" onChange={(v) => picked.push(v)} />);

    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(() => fireEvent.keyDown(trigger(), { key: "Enter" })).not.toThrow();
    expect(picked).toEqual([]);
  });
});
