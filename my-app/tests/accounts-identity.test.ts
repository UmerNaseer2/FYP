/**
 * identityFrom: how each kind of sign-in is reduced to the account it came
 * from and an address, before lib/accounts-db.ts decides which person that is.
 *
 * Two things here decide who gets in as whom, so each is pinned down:
 *   - The account is the provider's fixed ID (Microsoft's tenant and object
 *     ID, GitHub's numeric user ID), never the address, which people can
 *     change and, outside the home tenant, set to anything.
 *   - An address is marked verified only when it can be trusted: a home-tenant
 *     Microsoft account, Microsoft's xms_edov claim about the `email` claim, or
 *     GitHub's own flag. A new account is made only for a verified address.
 *
 * resolveIdentity, the database half, runs against a real Postgres in
 * tests/org-migration.test.ts. Only its type is needed here, so the pool it
 * would use is replaced: lib/db/sequelize.ts refuses to load without a
 * database address.
 */

import { identityFrom, type SignInParams } from "@/lib/accounts-db";

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {},
  syncMetadataTables: jest.fn(),
}));

const HOME = "11111111-2222-3333-4444-555555555555";
const ELSEWHERE = "99999999-8888-7777-6666-555555555555";
const OBJECT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const realTenant = process.env.AZURE_AD_TENANT_ID;
beforeEach(() => {
  process.env.AZURE_AD_TENANT_ID = HOME;
});
afterAll(() => {
  if (realTenant === undefined) delete process.env.AZURE_AD_TENANT_ID;
  else process.env.AZURE_AD_TENANT_ID = realTenant;
});

/** A browser sign-in with Microsoft, with the ID token's claims as `profile`. */
function microsoft(claims: Record<string, unknown>, name: string | null = "Ada"): SignInParams {
  return {
    user: { id: "random-uuid", email: "ignored@example.com", name },
    account: { provider: "microsoft-entra-id" },
    profile: { tid: HOME, oid: OBJECT_ID, email: "ada@client.example", ...claims },
  };
}

function github(profile: Record<string, unknown>): SignInParams {
  return {
    user: { id: "random-uuid", email: "ignored@example.com", name: "Octo Cat" },
    account: { provider: "github" },
    profile: { id: 583231, email: "octo@example.com", email_verified: true, ...profile },
  };
}

describe("a Microsoft sign-in in the browser", () => {
  test("is the account its tenant and object ID name, trusted in the home tenant", () => {
    expect(identityFrom(microsoft({}))).toEqual({
      provider: "microsoft",
      subject: `${HOME}:${OBJECT_ID}`,
      email: "ada@client.example",
      emailVerified: true,
      name: "Ada",
      homeTenant: true,
    });
  });

  test("lowercases both IDs, and matches the home tenant whatever its case", () => {
    process.env.AZURE_AD_TENANT_ID = ` ${HOME.toUpperCase()} `;
    const who = identityFrom(microsoft({ tid: HOME.toUpperCase(), oid: OBJECT_ID.toUpperCase() }));
    expect(who).toMatchObject({ subject: `${HOME}:${OBJECT_ID}`, homeTenant: true });
  });

  test("never takes the address Auth.js put on the user", () => {
    // Auth.js copies it from the claims, but this reads the claims themselves,
    // so what was checked is what is used.
    expect(identityFrom(microsoft({}))?.email).toBe("ada@client.example");
  });

  test("falls back to the sign-in name for a work account with no mailbox", () => {
    const who = identityFrom(
      microsoft({ email: undefined, preferred_username: "ada@client.example" }),
    );
    expect(who).toMatchObject({ email: "ada@client.example", emailVerified: true });
  });

  test("trusts another organization's address only with xms_edov exactly true", () => {
    const outside = { tid: ELSEWHERE, email: "sam@other.example" };
    expect(identityFrom(microsoft({ ...outside, xms_edov: true }))).toMatchObject({
      subject: `${ELSEWHERE}:${OBJECT_ID}`,
      emailVerified: true,
      homeTenant: false,
    });
    for (const xms_edov of [false, "true", 1, undefined]) {
      expect(identityFrom(microsoft({ ...outside, xms_edov }))).toMatchObject({
        emailVerified: false,
      });
    }
  });

  test("never trusts a sign-in name from another organization, whatever xms_edov says", () => {
    // xms_edov speaks only for the `email` claim. A sign-in name is whatever
    // that organization's admin typed.
    const who = identityFrom(
      microsoft({
        tid: ELSEWHERE,
        email: undefined,
        preferred_username: "umer@client.example",
        xms_edov: true,
      }),
    );
    expect(who).toMatchObject({ email: "umer@client.example", emailVerified: false });
  });

  test("treats a personal Microsoft account as outside the home tenant", () => {
    const personal = "9188040d-6c67-4c5b-b112-36a304b66dad";
    expect(identityFrom(microsoft({ tid: personal, xms_edov: true }))).toMatchObject({
      homeTenant: false,
      emailVerified: true,
    });
  });

  test("is nobody without a tenant, an object ID or an address", () => {
    for (const claims of [
      { tid: undefined },
      { oid: undefined },
      { oid: "  " },
      { email: undefined },
      { email: "not-an-address", preferred_username: "also-not" },
    ]) {
      expect(identityFrom(microsoft(claims))).toBeNull();
    }
  });

  test("never treats the home tenant as unset when AZURE_AD_TENANT_ID is missing", () => {
    delete process.env.AZURE_AD_TENANT_ID;
    expect(identityFrom(microsoft({ tid: "" }))).toBeNull();
    expect(identityFrom(microsoft({}))).toMatchObject({ homeTenant: false, emailVerified: false });
  });

  test("keeps no name it was not given", () => {
    expect(identityFrom(microsoft({}, null))?.name).toBeNull();
    expect(identityFrom(microsoft({}, "  "))?.name).toBeNull();
  });
});

describe("a desktop app sign-in", () => {
  // lib/desktop-sign-in.ts has checked the token and refused any other tenant.
  const desktop = (user: SignInParams["user"]): SignInParams => ({
    user,
    account: { provider: "desktop" },
  });

  test("is the same Microsoft account the browser would name, trusted", () => {
    const who = identityFrom(
      desktop({
        id: `${HOME}:${OBJECT_ID.toUpperCase()}`,
        email: "ada@client.example",
        name: "Ada",
      }),
    );
    expect(who).toEqual({
      provider: "microsoft",
      subject: `${HOME}:${OBJECT_ID}`,
      email: "ada@client.example",
      emailVerified: true,
      name: "Ada",
      homeTenant: true,
    });
  });

  test("is nobody without an account or an address", () => {
    expect(identityFrom(desktop({ id: "", email: "ada@client.example" }))).toBeNull();
    expect(identityFrom(desktop({ id: `${HOME}:${OBJECT_ID}`, email: null }))).toBeNull();
  });
});

describe("a GitHub sign-in", () => {
  test("is the numeric user ID, with GitHub's word on the address", () => {
    expect(identityFrom(github({}))).toEqual({
      provider: "github",
      subject: "583231",
      email: "octo@example.com",
      emailVerified: true,
      name: "Octo Cat",
      homeTenant: false,
    });
  });

  test("believes only a verified flag that is exactly true", () => {
    for (const email_verified of [false, "true", undefined]) {
      expect(identityFrom(github({ email_verified }))?.emailVerified).toBe(false);
    }
  });

  test("is nobody without an ID or an address", () => {
    for (const profile of [{ id: undefined }, { id: { nested: 1 } }, { email: null }]) {
      expect(identityFrom(github(profile))).toBeNull();
    }
  });
});

test("an unknown kind of sign-in is nobody", () => {
  expect(
    identityFrom({ user: { id: "1", email: "a@b.example" }, account: { provider: "email" } }),
  ).toBeNull();
  expect(identityFrom({ user: { id: "1", email: "a@b.example" }, account: null })).toBeNull();
});
