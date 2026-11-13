/** @jest-environment jsdom */

/**
 * The round button at the right of the top bar and the small menu it opens
 * (the Atelier design). Who is signed in, with what role, and what you can
 * do from there: your requests, your activity, your phone and desktop
 * links, replay the intro, sign out.
 *
 * What is NOT here:
 *  - Where the name and the role come from (the session, /api/me). That is
 *    the shell's: tests/component-studio-shell.test.tsx.
 *  - What signing out does. The menu only calls back.
 *  - The intro itself: tests/component-logo-intro.test.tsx.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { AccountMenu } from "@/components/studio/AccountMenu";
import { BUILT_IN_ROLE_INFO } from "@/lib/permissions";
import { REPLAY_INTRO_EVENT } from "@/lib/intro";
import { START_TOUR_EVENT, writeTourMemory } from "@/lib/tour";
import { OrgContext } from "@/hooks/useOrg";

const ADA = { name: "Ada Lovelace", email: "ada@example.com", initials: "AD" };

const onSignOut = jest.fn();

beforeEach(() => {
  onSignOut.mockClear();
});

type Props = Partial<Parameters<typeof AccountMenu>[0]>;

function renderMenu(over: Props = {}) {
  return render(
    <div>
      <p>Somewhere else on the page</p>
      <AccountMenu user={ADA} role="admin" roleLabel="Admin" onSignOut={onSignOut} {...over} />
    </div>
  );
}

const trigger = () => screen.getByRole("button", { name: /^Account menu/ });
const menu = () => screen.queryByRole("menu", { name: "Account" });
const item = (name: string) => screen.getByRole("menuitem", { name });

describe("the button", () => {
  test("says who is signed in, and as what, in its name", () => {
    renderMenu();
    expect(trigger()).toHaveAccessibleName("Account menu, signed in as Ada Lovelace, Admin");
    expect(trigger()).toHaveTextContent("Ada Lovelace · Admin");
  });

  test("leaves the role out while it is not known", () => {
    renderMenu({ role: undefined, roleLabel: undefined });
    expect(trigger()).toHaveAccessibleName("Account menu, signed in as Ada Lovelace");
    expect(trigger()).not.toHaveTextContent("·");
  });

  test("falls back to the role's key when it has no readable name", () => {
    renderMenu({ role: "qa-lead", roleLabel: undefined });
    expect(trigger()).toHaveTextContent("Ada Lovelace · qa-lead");
  });

  test("says it opens a menu, and that the menu is shut", () => {
    renderMenu();
    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(menu()).toBeNull();
  });
});

describe("opening and closing", () => {
  test("a click opens it and puts you on the first item", () => {
    renderMenu({ requestsHref: "/acme/requests" });
    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(menu()).toBeInTheDocument();
    expect(item("Your requests")).toHaveFocus();
  });

  test("Down Arrow on the button opens it too", () => {
    renderMenu();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(menu()).toBeInTheDocument();
    expect(item("Take the tour")).toHaveFocus();
  });

  test("a second click shuts it", () => {
    renderMenu();
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(menu()).toBeNull();
  });

  test("Escape shuts it and puts you back on the button", () => {
    renderMenu();
    fireEvent.click(trigger());
    fireEvent.keyDown(menu()!, { key: "Escape" });
    expect(menu()).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  test("Tab shuts it and lets focus move on", () => {
    renderMenu();
    fireEvent.click(trigger());
    fireEvent.keyDown(menu()!, { key: "Tab" });
    expect(menu()).toBeNull();
  });

  test("a click anywhere else shuts it", () => {
    renderMenu();
    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByText("Somewhere else on the page"));
    expect(menu()).toBeNull();
  });

  test("a click inside it does not", () => {
    renderMenu();
    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByText("ada@example.com"));
    expect(menu()).toBeInTheDocument();
  });
});

describe("moving through it with the keyboard", () => {
  function openWithRequests() {
    renderMenu({ requestsHref: "/acme/requests" });
    fireEvent.click(trigger());
    return menu()!;
  }

  test("Down and Up move one item, and wrap at the ends", () => {
    const m = openWithRequests();
    fireEvent.keyDown(m, { key: "ArrowDown" });
    expect(item("Take the tour")).toHaveFocus();
    fireEvent.keyDown(m, { key: "ArrowDown" });
    expect(item("Replay intro")).toHaveFocus();
    fireEvent.keyDown(m, { key: "ArrowDown" });
    expect(item("Sign out")).toHaveFocus();
    fireEvent.keyDown(m, { key: "ArrowDown" });
    expect(item("Your requests")).toHaveFocus();
    fireEvent.keyDown(m, { key: "ArrowUp" });
    expect(item("Sign out")).toHaveFocus();
  });

  test("Home and End jump to the ends", () => {
    const m = openWithRequests();
    fireEvent.keyDown(m, { key: "End" });
    expect(item("Sign out")).toHaveFocus();
    fireEvent.keyDown(m, { key: "Home" });
    expect(item("Your requests")).toHaveFocus();
  });

  test("keeps every item out of the Tab order, so Tab leaves the menu", () => {
    openWithRequests();
    for (const el of screen.getAllByRole("menuitem")) {
      expect(el).toHaveAttribute("tabindex", "-1");
    }
  });
});

describe("what it shows", () => {
  test("the name, the address and the initials at the top", () => {
    renderMenu();
    fireEvent.click(trigger());
    const m = within(menu()!);
    expect(m.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(m.getByText("ada@example.com")).toBeInTheDocument();
    expect(m.getByText("AD")).toBeInTheDocument();
  });

  test("the role and the organization, with what the role starts out able to do", () => {
    renderMenu({ orgName: "Acme" });
    const line = screen.getByTestId("account-role");
    expect(line).toHaveTextContent("Admin at Acme");
    expect(line).toHaveAttribute("title", BUILT_IN_ROLE_INFO.admin.description);
  });

  test("just the role when there is no organization", () => {
    renderMenu({ role: "viewer", roleLabel: "Viewer" });
    const line = screen.getByTestId("account-role");
    expect(line).toHaveTextContent(/^Viewer$/);
    expect(line).toHaveAttribute("title", BUILT_IN_ROLE_INFO.viewer.description);
  });

  test("an honest tooltip for a role an admin made", () => {
    renderMenu({ role: "qa-lead", roleLabel: "QA Lead" });
    expect(screen.getByTestId("account-role")).toHaveAttribute(
      "title",
      expect.stringContaining("custom role")
    );
  });

  test("no role line at all while the role is not known", () => {
    renderMenu({ role: undefined, roleLabel: undefined });
    expect(screen.queryByTestId("account-role")).toBeNull();
  });

  test("no address line when the session has none", () => {
    renderMenu({ user: { name: "Release bot", email: "", initials: "RB" } });
    fireEvent.click(trigger());
    expect(within(menu()!).queryByText("@", { exact: false })).toBeNull();
  });
});

describe("the items", () => {
  test('"Your requests" goes to the requests page and shuts the menu', () => {
    renderMenu({ requestsHref: "/acme/requests" });
    fireEvent.click(trigger());
    expect(item("Your requests")).toHaveAttribute("href", "/acme/requests");
    fireEvent.click(item("Your requests"));
    expect(menu()).toBeNull();
  });

  test('"Your activity" and "Phone and desktop" go to History and Devices, after "Your requests"', () => {
    renderMenu({ requestsHref: "/acme/requests", activityHref: "/acme/history", devicesHref: "/acme/devices" });
    fireEvent.click(trigger());
    expect(item("Your activity")).toHaveAttribute("href", "/acme/history");
    expect(item("Phone and desktop")).toHaveAttribute("href", "/acme/devices");
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Your requests",
      "Your activity",
      "Phone and desktop",
      "Take the tour",
      "Replay intro",
      "Sign out",
    ]);
    fireEvent.click(item("Phone and desktop"));
    expect(menu()).toBeNull();
  });

  test('"Your activity" and "Phone and desktop" are left out without an address', () => {
    renderMenu({ requestsHref: "/acme/requests" });
    fireEvent.click(trigger());
    expect(screen.queryByRole("menuitem", { name: "Your activity" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Phone and desktop" })).toBeNull();
  });

  test('"Your requests" is left out when there is nowhere to send you', () => {
    renderMenu();
    fireEvent.click(trigger());
    expect(screen.queryByRole("menuitem", { name: "Your requests" })).toBeNull();
  });

  test('"Take the tour" asks the tour to start and shuts the menu', () => {
    const heard = jest.fn();
    window.addEventListener(START_TOUR_EVENT, heard);
    try {
      renderMenu();
      fireEvent.click(trigger());
      fireEvent.click(item("Take the tour"));
      expect(heard).toHaveBeenCalledTimes(1);
      expect(menu()).toBeNull();
    } finally {
      window.removeEventListener(START_TOUR_EVENT, heard);
    }
  });

  test('says "Resume the tour" when it was closed part way, in this organization and role', () => {
    writeTourMemory("acme", "admin", { done: false, resume: 3 });
    try {
      render(
        <OrgContext.Provider value={{ slug: "acme", name: "Acme" }}>
          <AccountMenu user={ADA} role="admin" roleLabel="Admin" onSignOut={onSignOut} />
        </OrgContext.Provider>
      );
      fireEvent.click(trigger());
      expect(item("Resume the tour")).toBeInTheDocument();
    } finally {
      window.localStorage.clear();
    }
  });

  test('"Replay intro" asks the intro to play again', () => {
    const heard = jest.fn();
    window.addEventListener(REPLAY_INTRO_EVENT, heard);
    try {
      renderMenu();
      fireEvent.click(trigger());
      fireEvent.click(item("Replay intro"));
      expect(heard).toHaveBeenCalledTimes(1);
      expect(menu()).toBeNull();
    } finally {
      window.removeEventListener(REPLAY_INTRO_EVENT, heard);
    }
  });

  test('"Sign out" calls back once and shuts the menu', () => {
    renderMenu();
    fireEvent.click(trigger());
    fireEvent.click(item("Sign out"));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });
});
