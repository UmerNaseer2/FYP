/**
 * The rules for a new organization's name and address (lib/new-organization.ts),
 * which the onboarding form and POST /api/organizations both use, so a
 * mistake gets the same words wherever it is caught.
 *
 * The address rules must agree with ORG_SLUG_PATTERN, which the database's
 * CHECK constraint is built from: the form must never call an address fine
 * that the database then turns down, or the other way round.
 */

import {
  ORG_NAME_MAX_LENGTH,
  ORG_SLUG_MAX_LENGTH,
  cleanOrgName,
  orgNameProblem,
  orgSlugProblem,
  suggestSlug,
} from "@/lib/new-organization";
import { ORG_SLUG_PATTERN, isOrgSlug } from "@/lib/org-slug";

const SHAPE =
  "An address is 3 to 40 lowercase letters, digits and dashes, " +
  "and starts and ends with a letter or digit.";

describe("a name", () => {
  test("is stored trimmed, with every run of spaces made one", () => {
    expect(cleanOrgName("  Acme \t\n  Data   Team ")).toBe("Acme Data Team");
    expect(cleanOrgName("   ")).toBe("");
  });

  test("takes any name that can be shown, up to the limit", () => {
    expect(orgNameProblem("Acme")).toBeNull();
    expect(orgNameProblem("Café Ñandú & Søn, Ltd.")).toBeNull();
    expect(orgNameProblem("x".repeat(ORG_NAME_MAX_LENGTH))).toBeNull();
  });

  test("needs something in it", () => {
    expect(orgNameProblem("")).toBe("Give the organization a name.");
    expect(orgNameProblem(cleanOrgName(" \t "))).toBe("Give the organization a name.");
  });

  test("turns down one past the limit", () => {
    expect(orgNameProblem("x".repeat(ORG_NAME_MAX_LENGTH + 1))).toBe(
      "Keep the name to 60 characters or fewer."
    );
  });

  test.each([
    ["a control character", "Acme\u0007"],
    ["a character that turns the text around", "Acme ‮txt.exe"],
    ["an isolate that hides the direction", "Acme ⁧Corp⁩"],
  ])("turns down %s, which would let a name read one way and be stored another", (_, name) => {
    expect(orgNameProblem(name)).toBe(
      "The name has a character that cannot be shown. Type it again."
    );
  });
});

describe("an address", () => {
  test("takes lowercase letters, digits and dashes", () => {
    expect(orgSlugProblem("acme")).toBeNull();
    expect(orgSlugProblem("acme-data-2")).toBeNull();
    expect(orgSlugProblem("abc")).toBeNull();
  });

  test("needs something in it", () => {
    expect(orgSlugProblem("")).toBe("Give the organization an address.");
  });

  test.each([
    ["too short", "ab"],
    ["too long", "a".repeat(ORG_SLUG_MAX_LENGTH + 1)],
    ["in capitals", "Acme"],
    ["starting with a dash", "-acme"],
    ["ending with a dash", "acme-"],
    ["with a space", "acme data"],
    ["with an accent", "café"],
  ])("turns down one %s, in words that say what an address is", (_, slug) => {
    expect(orgSlugProblem(slug)).toBe(SHAPE);
  });

  test.each(["login", "studio", "onboarding", "invite", "api"])(
    "turns down %s, which the app uses itself",
    (slug) => {
      expect(orgSlugProblem(slug)).toBe("That address is used by the app itself. Pick another.");
    }
  );

  test("agrees with the database's rule on how long an address can be", () => {
    // The CHECK constraint is built from ORG_SLUG_PATTERN. The limit the form
    // and the message use is a number of its own, so it is held to that rule.
    const longest = "a".repeat(ORG_SLUG_MAX_LENGTH);
    expect(new RegExp(ORG_SLUG_PATTERN).test(longest)).toBe(true);
    expect(new RegExp(ORG_SLUG_PATTERN).test(`${longest}a`)).toBe(false);
    expect(new RegExp(ORG_SLUG_PATTERN).test("abc")).toBe(true);
    expect(new RegExp(ORG_SLUG_PATTERN).test("ab")).toBe(false);
  });

  test("is fine exactly when isOrgSlug, the database side's check, says it is", () => {
    for (const slug of ["acme", "ab", "login", "Acme", "a".repeat(40), "a".repeat(41), "a--b"]) {
      expect(orgSlugProblem(slug) === null).toBe(isOrgSlug(slug));
    }
  });
});

describe("the address offered for a name", () => {
  test.each([
    ["Acme", "acme"],
    ["Acme Café Ltd.", "acme-cafe-ltd"],
    ["Ops & QA", "ops-qa"],
    ["  --Data Team--  ", "data-team"],
    ["ÅNGSTRÖM Labs", "angstrom-labs"],
    ["ﬁnance", "finance"],
    ["Team 42", "team-42"],
  ])("makes %j into %j", (name, slug) => {
    expect(suggestSlug(name)).toBe(slug);
  });

  test("keeps to the longest address, without a dash left at the end", () => {
    // Cut at 40 characters, this one would end on the dash before "end".
    const name = `${"a".repeat(ORG_SLUG_MAX_LENGTH - 1)} end`;
    expect(suggestSlug(name)).toBe("a".repeat(ORG_SLUG_MAX_LENGTH - 1));
    expect(suggestSlug("word ".repeat(20)).length).toBeLessThanOrEqual(ORG_SLUG_MAX_LENGTH);
  });

  test("offers nothing for a name with no letters it can use, and the rules say so", () => {
    expect(suggestSlug("日本")).toBe("");
    expect(orgSlugProblem(suggestSlug("日本"))).toBe("Give the organization an address.");
  });

  test("can offer an address the rules still turn down, and they say why", () => {
    expect(orgSlugProblem(suggestSlug("QA"))).toBe(SHAPE);
    expect(orgSlugProblem(suggestSlug("Login"))).toBe(
      "That address is used by the app itself. Pick another."
    );
  });
});
