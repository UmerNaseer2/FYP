/**
 * The server half of "Your organizations" (app/onboarding/page.tsx).
 *
 * It decides one thing: it hands over to the client half, telling it
 * whether this is the demo (sign-in switched off).
 *
 * Node, not jsdom, as in tests/page-root.test.ts: the page is called as a
 * function and its answer inspected as a React element. What the client half
 * draws is tests/page-onboarding.test.tsx.
 */
import type { ReactElement } from "react";
import Onboarding, { dynamic } from "@/app/onboarding/page";
import { OnboardingPage } from "@/components/onboarding/OnboardingPage";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.

// redirect() works by throwing, and the stand-in does too, so a case that
// forgot to stop would come back as a page instead of passing by accident.
const mockRedirects: string[] = [];
jest.mock("next/navigation", () => ({
  redirect: (href: string) => {
    mockRedirects.push(href);
    throw new Error("NEXT_REDIRECT");
  },
}));

// next-auth ships as ESM, which Jest cannot load, and signing out is reached
// only through the client half.
jest.mock("../lib/auth/sign-out", () => ({ signOutEverywhere: jest.fn() }));

// Getters, so each case's change is what the page reads.
const mockFlags = { bypass: false };
jest.mock("../lib/auth/mode", () => ({
  get BYPASS_AUTH() {
    return mockFlags.bypass;
  },
}));

beforeEach(() => {
  mockRedirects.length = 0;
  mockFlags.bypass = false;
});

function page(): ReactElement<{ demo: boolean }> {
  return Onboarding() as ReactElement<{ demo: boolean }>;
}

test("on a server with sign-in, hands over to the page, not as the demo", () => {
  const element = page();
  expect(element.type).toBe(OnboardingPage);
  expect(element.props).toEqual({ demo: false });
  expect(mockRedirects).toEqual([]);
});

test("with sign-in switched off, hands over to the page as the demo", () => {
  mockFlags.bypass = true;
  const element = page();
  expect(element.type).toBe(OnboardingPage);
  expect(element.props).toEqual({ demo: true });
});

test("is drawn on every request, so a build machine's answer is never kept", () => {
  expect(dynamic).toBe("force-dynamic");
});
