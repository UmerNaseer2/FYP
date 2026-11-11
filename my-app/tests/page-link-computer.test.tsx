/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  fetchCalls,
  render,
  resetPageState,
  setPathname,
  setRoutes,
  setSearchParams,
  setUser,
  type FetchRoute,
} from "./helpers/render-page";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import LinkComputerPage from "@/app/[org]/link-computer/page";
import { HELP_TOPICS } from "@/lib/help";

const ORGS: FetchRoute = {
  match: "/api/organizations",
  body: { organizations: [], canCreate: false },
};

/** Three minutes ago: links last ten. */
const OPENED_AT = new Date(Date.now() - 3 * 60_000).toISOString();

function computerAsking(name = "Ada's laptop"): FetchRoute {
  return { match: "/api/computers/link", body: { computerName: name, openedAt: OPENED_AT } };
}

/** Type the code the way the person reads it off their computer. */
async function typeCode(code = "BCDF-GHJK") {
  fireEvent.change(await screen.findByLabelText("Code shown on the computer"), { target: { value: code } });
}

function sentBody(method: string) {
  const sent = fetchCalls.find((entry) => entry.url.includes("/api/computers/link") && entry.method === method);
  return sent === undefined ? undefined : JSON.parse(String(sent.body));
}

afterEach(cleanup);

beforeEach(() => {
  resetPageState();
  setUser("editor");
  setRoutes([computerAsking(), ORGS]);
});

describe("the link page", () => {
  it("shows the page's name, its one line from the help file, and a Help button", async () => {
    setPathname("/test-org/link-computer");
    render(<LinkComputerPage />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Link a computer");
    expect(screen.getByText(HELP_TOPICS["/link-computer"].blurb)).toBeInTheDocument();
    // There is no shell on this page, so it brings the Help panel itself.
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(await screen.findByText(HELP_TOPICS["/link-computer"].purpose)).toBeInTheDocument();
  });

  it("warns before anything else", async () => {
    render(<LinkComputerPage />);
    expect(await screen.findByText(/Only link a computer you are sitting at/)).toBeInTheDocument();
  });

  it("says plainly that the computer gets the organization's connections and their passwords", async () => {
    render(<LinkComputerPage />);
    expect(
      await screen.findByText(/Linking lets that computer open .* saved connections, including their\s+passwords/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Never type a code that someone sent you/)).toBeInTheDocument();
  });

  it("does not take the code from the link, so a link someone sent cannot fill it in", async () => {
    setSearchParams("code=bcdf-ghjk");
    render(<LinkComputerPage />);
    const box = await screen.findByLabelText("Code shown on the computer");
    await waitFor(() => expect(fetchCalls.some((entry) => entry.url === "/api/organizations")).toBe(true));
    expect(box).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Link this computer" })).not.toBeInTheDocument();
    expect(fetchCalls.some((entry) => entry.url.includes("/api/computers/link"))).toBe(false);
  });

  it("names the computer for a typed code, and says when it asked", async () => {
    render(<LinkComputerPage />);
    await typeCode("bcdf-ghjk");
    expect(await screen.findByText(/Link Ada's laptop to/)).toBeInTheDocument();
    expect(fetchCalls.some((entry) => entry.url.includes("code=BCDFGHJK"))).toBe(true);
    expect(screen.getByText(/This computer asked to be linked at .* \(3m ago\)/)).toBeInTheDocument();
  });

  it("asks nothing and offers nothing until a whole code is typed", async () => {
    render(<LinkComputerPage />);
    const box = await screen.findByLabelText("Code shown on the computer");
    fireEvent.change(box, { target: { value: "BCDF" } });
    expect(screen.queryByRole("button", { name: "Link this computer" })).not.toBeInTheDocument();
    expect(fetchCalls.some((entry) => entry.url.includes("/api/computers/link"))).toBe(false);

    fireEvent.change(box, { target: { value: "BCDF GHJK" } });
    expect(await screen.findByRole("button", { name: "Link this computer" })).toBeInTheDocument();
  });

  it("links the computer on a yes, and says to go back to it", async () => {
    render(<LinkComputerPage />);
    await typeCode();
    fireEvent.click(await screen.findByRole("button", { name: "Link this computer" }));
    expect(await screen.findByText("Linked")).toBeInTheDocument();
    expect(sentBody("POST")).toEqual({ code: "BCDFGHJK" });
    expect(screen.getByText(/go back to Schema Studio on the computer/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link this computer" })).not.toBeInTheDocument();
  });

  it("turns the computer away on a no", async () => {
    render(<LinkComputerPage />);
    await typeCode();
    fireEvent.click(await screen.findByRole("button", { name: "Not mine" }));
    expect(await screen.findByText("Nothing was linked")).toBeInTheDocument();
    expect(sentBody("DELETE")).toEqual({ code: "BCDFGHJK" });
    expect(sentBody("POST")).toBeUndefined();
  });

  it("shows the site's sentence for a code that ran out, and offers nothing", async () => {
    const sentence = "That code has expired or is not right. Start again on the computer.";
    setRoutes([{ match: "/api/computers/link", status: 404, body: { error: sentence } }, ORGS]);
    render(<LinkComputerPage />);
    await typeCode();
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link this computer" })).not.toBeInTheDocument();
  });

  it("keeps the choice open when linking fails", async () => {
    render(<LinkComputerPage />);
    await typeCode();
    const yes = await screen.findByRole("button", { name: "Link this computer" });
    const sentence = "That code has expired or is not right. Start again on the computer.";
    setRoutes([
      { match: "/api/computers/link", method: "POST", status: 404, body: { error: sentence } },
      computerAsking(),
      ORGS,
    ]);
    fireEvent.click(yes);
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.queryByText("Linked")).not.toBeInTheDocument();
  });

  it("offers the person's other organizations only when there are some", async () => {
    setRoutes([
      computerAsking(),
      {
        match: "/api/organizations",
        body: {
          organizations: [
            { id: 1, slug: "test-org", name: "Test Org", role: "editor", roleLabel: "Editor", personal: false, isDefault: true },
            { id: 2, slug: "other", name: "Other", role: "admin", roleLabel: "Admin", personal: false, isDefault: false },
          ],
          canCreate: false,
        },
      },
    ]);
    render(<LinkComputerPage />);
    await waitFor(() => expect(screen.getByText("Organization")).toBeInTheDocument());
  });
});
