/** @jest-environment jsdom */

/**
 * Phone and desktop: the page that explains the three ways into Schema Studio.
 *
 * Most of it is words and links, so the checks are that the links go to the
 * real pages inside the organization, and that the one live list on it (the
 * linked computers) says the truth in each state: loading, read, empty,
 * failed, and not allowed.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import DevicesPage from "@/app/[org]/(studio)/devices/page";
import { BLURB_MAX_WORDS } from "@/lib/help";
import { devicesHelp } from "@/lib/help/devices";
import { fetchCalls, render, resetPageState, setCustomRole, setRoutes, setUser } from "./helpers/render-page";
import { installDesktopBridge, removeDesktopBridge } from "./helpers/desktop-bridge";

const COMPUTERS = "/api/connections/computers";

function computer(over: Partial<Record<string, unknown>> & { id: number; name: string }) {
  return { owner: "Someone Else", mine: false, online: false, lastSeenAt: null, connections: [], ...over };
}

function openTab(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

beforeEach(() => {
  resetPageState();
  setRoutes([{ match: COMPUTERS, body: { computers: [] } }]);
});
afterEach(() => {
  removeDesktopBridge();
  cleanup();
});

describe("the page itself", () => {
  it("shows its name and its one line from the help file", () => {
    render(<DevicesPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Phone and desktop");
    expect(screen.getByText(devicesHelp.blurb)).toBeInTheDocument();
    expect(devicesHelp.blurb.split(/\s+/).length).toBeLessThanOrEqual(BLURB_MAX_WORDS);
  });

  it("opens on the phone app and says which tab is chosen", () => {
    render(<DevicesPage />);
    const tabs = within(screen.getByRole("group", { name: "Ways in" }));
    expect(tabs.getByRole("button", { name: "Phone app" })).toHaveAttribute("aria-pressed", "true");
    expect(tabs.getByRole("button", { name: "Desktop app" })).toHaveAttribute("aria-pressed", "false");

    openTab("Sync");
    expect(tabs.getByRole("button", { name: "Sync" })).toHaveAttribute("aria-pressed", "true");
    expect(tabs.getByRole("button", { name: "Phone app" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { name: "Who wins" })).toBeInTheDocument();
  });
});

describe("the phone app tab", () => {
  it("links to the real phone app, inside the organization", () => {
    render(<DevicesPage />);
    expect(screen.getByRole("link", { name: "Open the phone app" })).toHaveAttribute("href", "/test-org/phone");
  });

  it("says the phone never holds a password", () => {
    render(<DevicesPage />);
    expect(screen.getByText(/It never holds a database password/)).toBeInTheDocument();
  });

  it("does not read the linked computers until the desktop tab is opened", () => {
    render(<DevicesPage />);
    expect(fetchCalls.some((call) => call.url.includes(COMPUTERS))).toBe(false);
  });
});

describe("the desktop app tab, on the website", () => {
  it("lists each linked computer with its owner and whether it is on", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    setRoutes([
      {
        match: COMPUTERS,
        body: {
          computers: [
            computer({
              id: 1,
              name: "Ada's laptop",
              mine: true,
              online: true,
              connections: [{ id: 9, name: "Local shop", environment: "dev" }],
            }),
            computer({ id: 2, name: "Build box", owner: "Grace Hopper", lastSeenAt: threeHoursAgo }),
          ],
        },
      },
    ]);
    render(<DevicesPage />);
    openTab("Desktop app");

    const list = within(await screen.findByRole("list", { name: "Linked computers" }));
    const rows = list.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Ada's laptop");
    expect(rows[0]).toHaveTextContent("Yours");
    expect(rows[0]).toHaveTextContent("1 connection of its own");
    expect(rows[0]).toHaveTextContent("Online");
    expect(rows[1]).toHaveTextContent("Build box");
    expect(rows[1]).toHaveTextContent("Grace Hopper");
    expect(rows[1]).toHaveTextContent("keeps no connections of its own");
    expect(rows[1]).toHaveTextContent("Offline");
    expect(rows[1]).toHaveTextContent("last seen 3h ago");
    // Unlinking lives on Connections, so the page points there.
    expect(screen.getByRole("link", { name: "Connections" })).toHaveAttribute("href", "/test-org/connections");
  });

  it("says so when no computer is linked, and links to the page that links one", async () => {
    render(<DevicesPage />);
    openTab("Desktop app");
    expect(await screen.findByText(/No computer is linked to Test Org yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Link a computer" })).toHaveAttribute(
      "href",
      "/test-org/link-computer"
    );
    expect(screen.getByText(/Only link a computer you are sitting at/)).toBeInTheDocument();
  });

  it("shows the site's own words when the read fails, and reads again on Try again", async () => {
    setRoutes([{ match: COMPUTERS, status: 500, body: { error: "Could not list the linked computers." } }]);
    render(<DevicesPage />);
    openTab("Desktop app");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not list the linked computers.");
    // A failed read is not "none linked".
    expect(screen.queryByText(/No computer is linked/)).not.toBeInTheDocument();

    setRoutes([{ match: COMPUTERS, body: { computers: [computer({ id: 1, name: "Ada's laptop" })] } }]);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Ada's laptop")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("tells a role that may not read connections why the list is missing, and does not ask for it", async () => {
    setCustomRole("helper", "Helper", ["drift:read"]);
    render(<DevicesPage />);
    openTab("Desktop app");

    expect(await screen.findByRole("note")).toHaveTextContent(/Your role cannot see the linked computers/);
    expect(fetchCalls.some((call) => call.url.includes(COMPUTERS))).toBe(false);
    // The steps and the link are still there: linking has its own check.
    expect(screen.getByRole("link", { name: "Link a computer" })).toBeInTheDocument();
  });
});

describe("the desktop app tab, inside the desktop app", () => {
  it("says this computer is not linked, and opens Settings", async () => {
    const bridge = installDesktopBridge();
    render(<DevicesPage />);
    openTab("Desktop app");

    expect(await screen.findByText(/This computer is not linked to a website/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(bridge.openSettings).toHaveBeenCalledTimes(1);
    // The website's list is not asked for from inside the app.
    expect(fetchCalls.some((call) => call.url.includes(COMPUTERS))).toBe(false);
    expect(screen.queryByRole("link", { name: "Link a computer" })).not.toBeInTheDocument();
  });

  it("names the organization it is linked to, and says when the website cannot be reached", async () => {
    const bridge = installDesktopBridge();
    bridge.syncStatus.mockResolvedValue({
      linked: true,
      origin: "https://studio.example",
      orgName: "Acme",
      online: false,
      lastSyncedAt: null,
      changedAt: null,
    });
    render(<DevicesPage />);
    openTab("Desktop app");

    expect(await screen.findByText("Linked to Acme")).toBeInTheDocument();
    expect(screen.getByText(/cannot be reached right now/)).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("says so when it cannot tell whether the computer is linked", async () => {
    const bridge = installDesktopBridge();
    bridge.syncStatus.mockRejectedValue(new Error("no answer"));
    render(<DevicesPage />);
    openTab("Desktop app");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Could not read whether this computer is linked/)
    );
  });
});

describe("the sync tab", () => {
  it("states the three rules for which copy wins", () => {
    setUser("viewer");
    render(<DevicesPage />);
    openTab("Sync");
    expect(screen.getByText("The website is the master.")).toBeInTheDocument();
    expect(screen.getByText("Cloud connections lock offline.")).toBeInTheDocument();
    expect(screen.getByText("Local passwords stay home.")).toBeInTheDocument();
  });
});
