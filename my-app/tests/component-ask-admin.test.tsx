/**
 * @jest-environment jsdom
 */
// AskAdmin is the way forward from a sentence saying a role can't do something.
// Every page that refuses somebody leans on it, so it has to land on the Requests
// page of this organization with the right thing already picked.
import "@testing-library/jest-dom";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { AskAdmin } from "@/components/studio/AskAdmin";
import { seedUserAccess } from "@/hooks/useUser";
import { presetFor } from "@/lib/permissions";
import { render, resetPageState, setUser, TEST_ORG } from "./helpers/render-page";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
beforeEach(() => {
  resetPageState();
  setUser("viewer");
});
afterEach(() => cleanup());

describe("the link to ask", () => {
  it("picks the permission on the Requests page of this organization", async () => {
    render(<AskAdmin permission="deploy:run" />);
    expect(await screen.findByRole("link", { name: "Ask for it" })).toHaveAttribute(
      "href",
      "/test-org/requests?ask=deploy%3Arun"
    );
  });

  it("goes to the page with nothing picked when no one permission is meant", async () => {
    render(<AskAdmin />);
    expect(await screen.findByRole("link", { name: "Ask for it" })).toHaveAttribute(
      "href",
      "/test-org/requests"
    );
  });

  it("is not offered while viewing the app as another role", async () => {
    // What /api/me says while the switcher on the rail is set to Viewer: the
    // person is really somebody else, so a request would be sent in their name.
    seedUserAccess(200, {
      role: "viewer",
      roleLabel: "Viewer",
      permissions: presetFor("viewer"),
      bypass: true,
      viewingAs: "viewer",
      org: TEST_ORG,
    });
    render(<AskAdmin permission="deploy:run" />);
    await waitFor(() => expect(screen.queryByRole("link")).toBeNull());
  });
});
