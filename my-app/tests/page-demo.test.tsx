/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";

import DemoPage from "@/app/demo/page";

// The page sits in the onboarding frame, which can hold Sign out. Nobody is
// signed in here, so it never shows, but the module still loads.
jest.mock("../lib/sign-out", () => ({ signOutEverywhere: jest.fn(() => Promise.resolve()) }));

// The page the FYP poster's QR code opens. Anyone can reach it without signing
// in (lib/public-paths.ts), so it may only show words and a way home.

afterEach(cleanup);

describe("the demo page", () => {
  it("says the demo is on its way", () => {
    render(<DemoPage />);
    expect(screen.getByRole("heading", { name: "The live demo is coming soon" })).toBeInTheDocument();
    expect(screen.getByText(/nothing to sign in to/)).toBeInTheDocument();
  });

  it("offers the home page and nothing behind sign-in", () => {
    render(<DemoPage />);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/"]);
    expect(links[0]).toHaveTextContent("Go to the home page");
  });

  it("asks the server for nothing", () => {
    const fetchSpy = jest.fn();
    const before = global.fetch;
    global.fetch = fetchSpy as unknown as typeof fetch;
    try {
      render(<DemoPage />);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = before;
    }
  });
});
