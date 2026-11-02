/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  fetchCalls,
  render,
  resetPageState,
  setRoutes,
  setSearchParams,
  setUser,
  type FetchRoute,
} from "./helpers/render-page";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import LinkComputerPage from "@/app/[org]/link-computer/page";

const ORGS: FetchRoute = {
  match: "/api/organizations",
  body: { organizations: [], canCreate: false },
};

function computerAsking(name = "Ada's laptop"): FetchRoute {
  return { match: "/api/computers/link", body: { computerName: name } };
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
  it("warns before anything else", async () => {
    render(<LinkComputerPage />);
    expect(await screen.findByText(/Only link a computer you are sitting at/)).toBeInTheDocument();
  });

  it("starts from the code the computer put in its link, and names the computer", async () => {
    setSearchParams("code=bcdf-ghjk");
    render(<LinkComputerPage />);
    expect(await screen.findByText(/Link Ada's laptop to/)).toBeInTheDocument();
    expect(screen.getByLabelText("Code shown on the computer")).toHaveValue("BCDF-GHJK");
    expect(fetchCalls.some((entry) => entry.url.includes("code=BCDFGHJK"))).toBe(true);
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
    setSearchParams("code=BCDF-GHJK");
    render(<LinkComputerPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Link this computer" }));
    expect(await screen.findByText("Linked")).toBeInTheDocument();
    expect(sentBody("POST")).toEqual({ code: "BCDFGHJK" });
    expect(screen.getByText(/go back to Schema Studio on the computer/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link this computer" })).not.toBeInTheDocument();
  });

  it("turns the computer away on a no", async () => {
    setSearchParams("code=BCDF-GHJK");
    render(<LinkComputerPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Not mine" }));
    expect(await screen.findByText("Nothing was linked")).toBeInTheDocument();
    expect(sentBody("DELETE")).toEqual({ code: "BCDFGHJK" });
    expect(sentBody("POST")).toBeUndefined();
  });

  it("shows the site's sentence for a code that ran out, and offers nothing", async () => {
    const sentence = "That code has expired or is not right. Start again on the computer.";
    setRoutes([{ match: "/api/computers/link", status: 404, body: { error: sentence } }, ORGS]);
    setSearchParams("code=BCDF-GHJK");
    render(<LinkComputerPage />);
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link this computer" })).not.toBeInTheDocument();
  });

  it("keeps the choice open when linking fails", async () => {
    setSearchParams("code=BCDF-GHJK");
    render(<LinkComputerPage />);
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
