// admin-invites-route: the API behind the invitations on the Users tab
// (app/api/admin/invites/route.ts).
//
// The rules about invitations themselves (who counts as a member already, a
// second invitation to one address, the hash kept in place of the token) live
// in lib/invites-db.ts and are tested against a real database in
// tests/invites-db.test.ts. Here lib/invites-db is replaced, so these tests
// cover only what the route adds on top:
//
//   - GET asks for Users: Read, and POST and DELETE for Users: Create, before
//     anything else, and a refusal goes back exactly as the gate made it.
//   - Nobody can invite on the desktop or with sign-in switched off. GET says
//     so with canInvite and lists nothing; POST and DELETE refuse before they
//     read the body.
//   - A body of the wrong shape is turned down in words a person can act on,
//     naming the field where there is one, and nothing is passed on. The
//     address is passed on cleaned.
//   - A link is made for the days asked and nothing else: a role in the body
//     cannot make it more than a Viewer's.
//   - Every call names the gate's organization, and is credited to the
//     caller's profile and address. Nothing in the body can change either.
//   - Each refusal from lib/invites-db reaches the screen with its own status
//     and words. A database that is down reads as "try again", with the
//     reason kept to the log.
import { NextRequest, NextResponse } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { bypassAdminPrincipal, principalFor, TEST_ORG } from "./helpers/principals";

let mockGate: Gate;
/** The keys each call to requirePermission asked for, in order. */
let mockAskedFor: string[][] = [];

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async (...keys: string[]) => {
    mockAskedFor.push(keys);
    return mockGate;
  },
}));

// Each one is reached through mockInvitesDb when called, not when this factory
// runs, because the factory runs before the line that creates mockInvitesDb.
const mockInvitesDb = {
  cancelInvite: jest.fn(),
  createEmailInvite: jest.fn(),
  createLinkInvite: jest.fn(),
  listPendingInvites: jest.fn(),
};
jest.mock("../lib/invites-db", () => ({
  cancelInvite: (...args: unknown[]) => mockInvitesDb.cancelInvite(...args),
  createEmailInvite: (...args: unknown[]) => mockInvitesDb.createEmailInvite(...args),
  createLinkInvite: (...args: unknown[]) => mockInvitesDb.createLinkInvite(...args),
  listPendingInvites: (...args: unknown[]) => mockInvitesDb.listPendingInvites(...args),
}));

import { DELETE, GET, POST } from "@/app/api/admin/invites/route";

const ADMIN = principalFor("admin", { email: "umer@x", name: "Umer" });
const TRY_AGAIN = " The app's database may be unreachable. Try again in a moment.";
const DESKTOP_REFUSAL =
  "Invitations are for the web app. The desktop app keeps a single organization of its own.";
const DEMO_REFUSAL =
  "Inviting someone needs a real sign-in. In the demo nobody signs in, so nobody could take an invitation.";
const NOT_JSON = "Expected a JSON body.";

/** A token of the shape lib/invites-db makes. Only POST's answer ever carries one. */
const TOKEN = "A".repeat(43);

const ANN_INVITE = {
  id: 12,
  kind: "email",
  email: "ann@example.com",
  role: "editor",
  roleLabel: "Editor",
  invitedBy: ADMIN.email,
  createdAt: "2026-10-26T01:00:00.000Z",
  expiresAt: "2026-11-02T01:00:00.000Z",
};
const LINK_INVITE = {
  ...ANN_INVITE,
  id: 13,
  kind: "link",
  email: null,
  role: "viewer",
  roleLabel: "Viewer",
  expiresAt: "2026-11-25T01:00:00.000Z",
};

const DESKTOP = process.env.SCHEMA_STUDIO_DESKTOP;

beforeEach(() => {
  mockGate = { ok: true, principal: ADMIN };
  mockAskedFor = [];
  delete process.env.SCHEMA_STUDIO_DESKTOP;
  for (const fn of Object.values(mockInvitesDb)) fn.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
  if (DESKTOP === undefined) delete process.env.SCHEMA_STUDIO_DESKTOP;
  else process.env.SCHEMA_STUDIO_DESKTOP = DESKTOP;
});

const HANDLERS = { POST, DELETE };
type Write = keyof typeof HANDLERS;

/** A request with this exact body text, the way a browser would send it. */
function send(method: Write, body: string): NextRequest {
  return new NextRequest("http://localhost/api/admin/invites", {
    method,
    body,
    headers: { "content-type": "application/json" },
  });
}

const json = (method: Write, value: unknown) => send(method, JSON.stringify(value));

async function answer(response: Response): Promise<[number, unknown]> {
  return [response.status, await response.json()];
}

function nothingWasPassedOn() {
  for (const [name, fn] of Object.entries(mockInvitesDb)) {
    expect([name, fn.mock.calls]).toEqual([name, []]);
  }
}

/** Keep the route's own console.error out of the test output, and count it. */
function quietErrors() {
  return jest.spyOn(console, "error").mockImplementation(() => {});
}

describe("asking first", () => {
  const refusal = () =>
    NextResponse.json(
      { error: "Your role (Editor) can't manage users. Only admins can." },
      { status: 403 }
    );

  test("GET asks for users:read, and a refusal goes back as it came", async () => {
    const refused = refusal();
    mockGate = { ok: false, response: refused };

    expect(await GET()).toBe(refused);
    expect(mockAskedFor).toEqual([["users:read"]]);
    nothingWasPassedOn();
  });

  test.each([
    ["POST", { kind: "link", days: 7 }],
    ["DELETE", { id: 12 }],
  ] as const)(
    "%s asks for users:create before it reads the body, and a refusal goes back as it came",
    async (method, body) => {
      const refused = refusal();
      mockGate = { ok: false, response: refused };
      const request = json(method, body);

      expect(await HANDLERS[method](request)).toBe(refused);
      expect(mockAskedFor).toEqual([["users:create"]]);
      expect(request.bodyUsed).toBe(false);
      nothingWasPassedOn();
    }
  );
});

describe("where nobody can invite", () => {
  const PLACES = [
    ["on the desktop", () => (process.env.SCHEMA_STUDIO_DESKTOP = "1"), DESKTOP_REFUSAL],
    [
      "with sign-in switched off",
      () => (mockGate = { ok: true, principal: bypassAdminPrincipal() }),
      DEMO_REFUSAL,
    ],
    [
      "on the desktop, even with sign-in switched off as well",
      () => {
        process.env.SCHEMA_STUDIO_DESKTOP = "1";
        mockGate = { ok: true, principal: bypassAdminPrincipal() };
      },
      DESKTOP_REFUSAL,
    ],
  ] as const;

  test.each(PLACES)("GET %s lists nothing and says canInvite is false", async (_, setUp) => {
    setUp();
    expect(await answer(await GET())).toEqual([200, { invites: [], canInvite: false }]);
    nothingWasPassedOn();
  });

  test.each(PLACES)(
    "POST and DELETE %s are refused before the body is read",
    async (_, setUp, message) => {
      setUp();
      for (const [method, body] of [
        ["POST", { kind: "email", email: "ann@example.com", role: "editor" }],
        ["POST", { kind: "link", days: 7 }],
        ["DELETE", { id: 12 }],
      ] as const) {
        const request = json(method, body);
        expect(await answer(await HANDLERS[method](request))).toEqual([403, { error: message }]);
        expect(request.bodyUsed).toBe(false);
      }
      nothingWasPassedOn();
    }
  );
});

describe("GET: the invitations still waiting", () => {
  test("lists the gate's organization's invitations, and says canInvite is true", async () => {
    mockInvitesDb.listPendingInvites.mockResolvedValue([LINK_INVITE, ANN_INVITE]);

    expect(await answer(await GET())).toEqual([
      200,
      { invites: [LINK_INVITE, ANN_INVITE], canInvite: true },
    ]);
    expect(mockInvitesDb.listPendingInvites.mock.calls).toEqual([[TEST_ORG.id]]);
  });

  test("says the database may be down when the list cannot be read", async () => {
    const logged = quietErrors();
    mockInvitesDb.listPendingInvites.mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:5433")
    );

    expect(await answer(await GET())).toEqual([
      503,
      { error: `Could not read the invitations.${TRY_AGAIN}` },
    ]);
    // The reason goes to the server's log, not to the screen.
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe("POST: the body", () => {
  const SAY_WHAT = 'Say what to make: "email" for an invitation to an address, or "link".';

  test.each([
    ["text that is not JSON", "kind=link", 400, { error: NOT_JSON }],
    ["no body at all", "", 400, { error: NOT_JSON }],
    ["null", "null", 400, { error: SAY_WHAT }],
    ["a list", JSON.stringify([{ kind: "link", days: 7 }]), 400, { error: SAY_WHAT }],
    ["no kind", JSON.stringify({ days: 7 }), 400, { error: SAY_WHAT }],
    ["a kind it does not make", JSON.stringify({ kind: "sms", days: 7 }), 400, { error: SAY_WHAT }],
  ])("%s is turned down, and nothing is passed on", async (_, body, status, expected) => {
    expect(await answer(await POST(send("POST", body)))).toEqual([status, expected]);
    nothingWasPassedOn();
  });
});

describe("POST: an invitation to an address", () => {
  const TYPE_IT = "Type the email address of the person to invite.";
  const NOT_AN_ADDRESS = "That is not an email address. It should look like name@example.com.";
  const CHOOSE_ROLE = "Choose a role for this person.";

  test.each([
    ["no address", { role: "editor" }, TYPE_IT, "email"],
    ["an address that is not a string", { email: 42, role: "editor" }, TYPE_IT, "email"],
    ["only spaces", { email: "   ", role: "editor" }, TYPE_IT, "email"],
    ["something that is not an address", { email: "ann", role: "editor" }, NOT_AN_ADDRESS, "email"],
    ["no role", { email: "ann@example.com" }, CHOOSE_ROLE, "role"],
    ["an empty role", { email: "ann@example.com", role: "" }, CHOOSE_ROLE, "role"],
    ["a role that is not a string", { email: "ann@example.com", role: ["admin"] }, CHOOSE_ROLE, "role"],
    ["a role too long to be one", { email: "ann@example.com", role: "r".repeat(65) }, CHOOSE_ROLE, "role"],
    // The address comes first, so a form with both wrong is sent to the box
    // at the top.
    ["neither", { email: "ann" }, NOT_AN_ADDRESS, "email"],
  ])("%s is turned down under its field, and nothing is passed on", async (_, fields, error, field) => {
    expect(await answer(await POST(json("POST", { kind: "email", ...fields })))).toEqual([
      400,
      { error, field },
    ]);
    nothingWasPassedOn();
  });

  test("is made in the gate's organization, cleaned, credited to the caller, and answered with its token", async () => {
    mockInvitesDb.createEmailInvite.mockResolvedValue({
      kind: "made",
      invite: ANN_INVITE,
      token: TOKEN,
    });

    expect(
      await answer(
        await POST(
          json("POST", {
            kind: "email",
            email: "  Ann@Example.COM ",
            role: "editor",
            // None of these are the body's to say.
            orgId: 99,
            invitedBy: 1,
            actor: "someone@else",
          })
        )
      )
    ).toEqual([201, { invite: ANN_INVITE, token: TOKEN }]);
    expect(mockInvitesDb.createEmailInvite.mock.calls).toEqual([
      [
        TEST_ORG.id,
        { email: "ann@example.com", role: "editor", invitedBy: ADMIN.profileId, actor: ADMIN.email },
      ],
    ]);
  });

  test("passes on a role of the longest length a role can have, for the roles table to judge", async () => {
    const role = "r".repeat(64);
    mockInvitesDb.createEmailInvite.mockResolvedValue({ kind: "no-role" });

    const [status] = await answer(
      await POST(json("POST", { kind: "email", email: "ann@example.com", role }))
    );
    expect(status).toBe(400);
    expect(mockInvitesDb.createEmailInvite.mock.calls[0][1]).toMatchObject({ role });
  });

  test.each([
    [
      "no-role",
      400,
      {
        error:
          'There is no role called "qa-lead". It may have just been deleted: ' +
          "reload the page to see the roles there are now.",
        field: "role",
      },
    ],
    [
      "member",
      409,
      { error: "Someone with that address is a member here already.", field: "email" },
    ],
    [
      "just-invited",
      409,
      {
        error:
          "Someone else invited that address a moment ago. Reload the page to see their invitation.",
        field: "email",
      },
    ],
  ])("a %s refusal reaches the screen in its own words", async (kind, status, expected) => {
    mockInvitesDb.createEmailInvite.mockResolvedValue({ kind });

    expect(
      await answer(
        await POST(json("POST", { kind: "email", email: "ann@example.com", role: "qa-lead" }))
      )
    ).toEqual([status, expected]);
  });

  test("says the database may be down when the invitation cannot be made", async () => {
    const logged = quietErrors();
    mockInvitesDb.createEmailInvite.mockRejectedValue(new Error("connect ECONNREFUSED"));

    expect(
      await answer(
        await POST(json("POST", { kind: "email", email: "ann@example.com", role: "editor" }))
      )
    ).toEqual([503, { error: `Could not make the invitation.${TRY_AGAIN}` }]);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe("POST: an invitation link", () => {
  const HOW_LONG = "Choose how long the link lasts: 1, 7 or 30 days.";

  test.each([
    ["no length", {}],
    ["a length of days it does not offer", { days: 2 }],
    ["a part of a day", { days: 7.5 }],
    ["a length written as text", { days: "7" }],
  ])("%s is turned down under its field, and nothing is passed on", async (_, fields) => {
    expect(await answer(await POST(json("POST", { kind: "link", ...fields })))).toEqual([
      400,
      { error: HOW_LONG, field: "days" },
    ]);
    nothingWasPassedOn();
  });

  test.each([1, 7, 30])(
    "is made for %i days in the gate's organization, credited to the caller, and answered with its token",
    async (days) => {
      mockInvitesDb.createLinkInvite.mockResolvedValue({ invite: LINK_INVITE, token: TOKEN });

      expect(
        await answer(
          await POST(
            // A role or an address in the body is not the link's: every link
            // is for Viewers, and for nobody in particular.
            json("POST", { kind: "link", days, role: "admin", email: "ann@example.com", orgId: 99 })
          )
        )
      ).toEqual([201, { invite: LINK_INVITE, token: TOKEN }]);
      expect(mockInvitesDb.createLinkInvite.mock.calls).toEqual([
        [TEST_ORG.id, { days, invitedBy: ADMIN.profileId, actor: ADMIN.email }],
      ]);
      expect(mockInvitesDb.createEmailInvite).not.toHaveBeenCalled();
    }
  );

  test("says the database may be down when the link cannot be made", async () => {
    const logged = quietErrors();
    mockInvitesDb.createLinkInvite.mockRejectedValue(new Error("connect ECONNREFUSED"));

    expect(await answer(await POST(json("POST", { kind: "link", days: 7 })))).toEqual([
      503,
      { error: `Could not make the invitation link.${TRY_AGAIN}` },
    ]);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE: cancelling an invitation", () => {
  const NO_ID = "A valid invitation id is required.";

  test.each([
    ["text that is not JSON", "id=12", NOT_JSON],
    ["no id", JSON.stringify({}), NO_ID],
    ["null", "null", NO_ID],
    ["an id that is not a number", JSON.stringify({ id: "twelve" }), NO_ID],
    ["a part of a number", JSON.stringify({ id: 1.5 }), NO_ID],
    ["zero", JSON.stringify({ id: 0 }), NO_ID],
    ["a number below zero", JSON.stringify({ id: -12 }), NO_ID],
  ])("%s is turned down, and nothing is passed on", async (_, body, error) => {
    expect(await answer(await DELETE(send("DELETE", body)))).toEqual([400, { error }]);
    nothingWasPassedOn();
  });

  test("cancels it in the gate's organization, credited to the caller", async () => {
    mockInvitesDb.cancelInvite.mockResolvedValue({ kind: "cancelled" });

    expect(await answer(await DELETE(json("DELETE", { id: 12, orgId: 99 })))).toEqual([
      200,
      { cancelled: true },
    ]);
    expect(mockInvitesDb.cancelInvite.mock.calls).toEqual([[TEST_ORG.id, 12, ADMIN.email]]);
  });

  test("one that is not waiting any more is a 404 that says to reload", async () => {
    mockInvitesDb.cancelInvite.mockResolvedValue({ kind: "not-found" });

    expect(await answer(await DELETE(json("DELETE", { id: 12 })))).toEqual([
      404,
      {
        error:
          "That invitation is not waiting any more. It may have just been taken or cancelled: " +
          "reload the page to see the invitations there are now.",
      },
    ]);
  });

  test("says the database may be down when the invitation cannot be cancelled", async () => {
    const logged = quietErrors();
    mockInvitesDb.cancelInvite.mockRejectedValue(new Error("connect ECONNREFUSED"));

    expect(await answer(await DELETE(json("DELETE", { id: 12 })))).toEqual([
      503,
      { error: `Could not cancel the invitation.${TRY_AGAIN}` },
    ]);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
