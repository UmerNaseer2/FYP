// POST /api/trial (app/api/trial/route.ts): the landing page's "Try as ..."
// buttons. Signing in itself is NextAuth's, so it is mocked here.

import { NextRequest } from "next/server";

const mockSignIn = jest.fn();
jest.mock("../auth", () => ({ signIn: (...args: unknown[]) => mockSignIn(...args) }));

import { POST } from "../app/api/trial/route";

const SITE = "studio.example.test";
const saved = { ...process.env };

beforeEach(() => {
  process.env.TRIAL_SANDBOX = "on";
  delete process.env.SCHEMA_STUDIO_DESKTOP;
  mockSignIn.mockResolvedValue(`https://${SITE}/studio`);
});

afterEach(() => {
  process.env = { ...saved };
  jest.clearAllMocks();
});

function press(role: string | null, origin: string | null = `https://${SITE}`): NextRequest {
  const form = new FormData();
  if (role !== null) form.set("role", role);
  const headers: Record<string, string> = { host: SITE };
  if (origin) headers.origin = origin;
  return new NextRequest(`https://${SITE}/api/trial`, { method: "POST", headers, body: form });
}

function landsOn(response: Response): string {
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location") ?? "");
  return url.pathname + url.search;
}

describe("POST /api/trial", () => {
  it("signs the visitor in as the account they picked and opens the studio", async () => {
    expect(landsOn(await POST(press("editor")))).toBe("/studio?tour=trial");
    expect(mockSignIn).toHaveBeenCalledWith("trial", { role: "editor", redirect: false });
  });

  it("refuses a form posted from another site, without signing anyone in", async () => {
    for (const origin of ["https://elsewhere.example.com", null, "not a url"]) {
      const response = await POST(press("admin", origin));
      expect(response.status).toBe(403);
    }
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it("sends anything but the three accounts back to the landing page", async () => {
    for (const role of ["owner", "", null]) {
      expect(landsOn(await POST(press(role)))).toBe("/");
    }
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it("does nothing on a server without the trial", async () => {
    delete process.env.TRIAL_SANDBOX;
    expect(landsOn(await POST(press("admin")))).toBe("/");
    process.env.TRIAL_SANDBOX = "on";
    process.env.SCHEMA_STUDIO_DESKTOP = "1";
    expect(landsOn(await POST(press("admin")))).toBe("/");
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it("says the trial is unavailable when signing in fails or is refused", async () => {
    const quiet = jest.spyOn(console, "error").mockImplementation(() => {});
    mockSignIn.mockRejectedValueOnce(new Error("database down"));
    expect(landsOn(await POST(press("viewer")))).toBe("/login?error=TrialUnavailable");
    mockSignIn.mockResolvedValueOnce(`https://${SITE}/login?error=AccessDenied`);
    expect(landsOn(await POST(press("viewer")))).toBe("/login?error=TrialUnavailable");
    quiet.mockRestore();
  });
});
