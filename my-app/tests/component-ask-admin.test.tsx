/**
 * @jest-environment jsdom
 */
// AskAdmin is the way forward from a sentence saying a role can't do something.
// Every page that refuses somebody leans on it. What it says follows the role:
// an Editor (or a custom role) gets the link to Requests, a Viewer gets a plain
// sentence and nothing to press, and an Admin is never told to ask an admin.
import "@testing-library/jest-dom";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { AskAdmin } from "@/components/studio/AskAdmin";
import { seedUserAccess } from "@/hooks/useUser";
import { presetFor } from "@/lib/roles/permissions";
import { render, resetPageState, setCustomRole, setUser, TEST_ORG } from "./helpers/render-page";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
beforeEach(() => {
  resetPageState();
  setUser("editor", ["dashboard:read"]);
});
afterEach(() => cleanup());

describe("the link to ask", () => {
  it("picks the permission on the Requests page of this organization", async () => {
    render(<AskAdmin permission="deploy:run" />);
    expect(await screen.findByRole("link", { name: "Ask an Admin" })).toHaveAttribute(
      "href",
      "/test-org/requests?ask=deploy%3Arun"
    );
  });

  it("goes to the page with nothing picked when no one permission is meant", async () => {
    render(<AskAdmin />);
    expect(await screen.findByRole("link", { name: "Ask an Admin" })).toHaveAttribute(
      "href",
      "/test-org/requests"
    );
  });

  it("says where the ask lands", async () => {
    render(<AskAdmin permission="deploy:run" />);
    await screen.findByRole("link", { name: "Ask an Admin" });
    expect(document.body).toHaveTextContent("Your ask lands in Requests, where any Admin can act on it.");
  });

  it("is only the link in a tight spot", async () => {
    render(<AskAdmin permission="deploy:run" short />);
    await screen.findByRole("link", { name: "Ask an Admin" });
    expect(document.body).not.toHaveTextContent("Your ask lands in Requests");
  });

  it("is offered to a role an admin made, too", async () => {
    setCustomRole("auditor", "Auditor", ["dashboard:read"]);
    render(<AskAdmin permission="deploy:run" />);
    expect(await screen.findByRole("link", { name: "Ask an Admin" })).toBeInTheDocument();
  });

  it("is not offered for something only an Admin can ever do", async () => {
    render(<AskAdmin permission="roles:update" />);
    await waitFor(() =>
      expect(document.body).toHaveTextContent("Only an Admin can do this, so there is nothing to ask for.")
    );
    expect(screen.queryByRole("link")).toBeNull();
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

describe("a Viewer", () => {
  beforeEach(() => setUser("viewer"));

  it("reads what Viewers can do, with nothing to press", async () => {
    render(<AskAdmin permission="deploy:run" />);
    await waitFor(() =>
      expect(document.body).toHaveTextContent(
        "Viewers can look around but not make changes. An Admin can move you to another role."
      )
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reads who decides what Viewers see, for a page they can't open", async () => {
    render(<AskAdmin permission="drift:read" />);
    await waitFor(() => expect(document.body).toHaveTextContent("An Admin decides what Viewers can see."));
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("reads the page's own line when it has a better one", async () => {
    render(<AskAdmin permission="deploy:run" viewerNote="You can see deploys once they run." />);
    await waitFor(() => expect(document.body).toHaveTextContent("You can see deploys once they run."));
    expect(document.body).not.toHaveTextContent("Viewers can look around");
  });
});

describe("an Admin", () => {
  beforeEach(() => setUser("admin"));

  it("is never told to ask an admin, and gets the page where they can turn it on", async () => {
    render(<AskAdmin permission="connections:create" />);
    expect(await screen.findByRole("link", { name: "Open Roles & permissions" })).toHaveAttribute(
      "href",
      "/test-org/admin?tab=roles"
    );
    expect(document.body).toHaveTextContent("You're an Admin, so you can turn it on yourself.");
    expect(document.body).not.toHaveTextContent(/ask an admin/i);
    expect(screen.queryByRole("link", { name: "Ask an Admin" })).toBeNull();
  });
});
