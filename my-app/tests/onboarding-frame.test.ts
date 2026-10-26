/**
 * initialOf (components/onboarding/OnboardingFrame.tsx): the letter in the
 * square beside an organization's name, on "Your organizations" and on an
 * invitation. tests/page-onboarding.test.tsx and tests/page-invite.test.tsx
 * cover the pages around it.
 */
import { initialOf } from "@/components/onboarding/OnboardingFrame";

// next-auth ships as ESM, which Jest cannot load, and the frame's Sign out
// button reaches it through here.
jest.mock("../lib/sign-out", () => ({ signOutEverywhere: jest.fn() }));

test.each([
  ["a name", "Acme", "A"],
  ["a name in lower case", "beta ops", "B"],
  ["an accented letter", "émile & co", "É"],
  ["a digit", "42 Labs", "4"],
  // Half of an emoji, which is what name[0] would give, draws as a box.
  ["an emoji", "🚀 Launch", "🚀"],
  ["a name with nothing in it", "", "?"],
])("%s: %j has the initial %j", (_, name, initial) => {
  expect(initialOf(name)).toBe(initial);
});
