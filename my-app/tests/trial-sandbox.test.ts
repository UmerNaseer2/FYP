// The shared trial organization: its rules (lib/trial-rules.ts), its demo
// databases' SQL (lib/trial-seed.ts), the parts of lib/trial-sandbox.ts that
// need no database, and the routes that turn trial accounts away.
//
// Building the organization itself needs a real database, and was checked by
// hand on a throwaway cluster.

import { NextRequest } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { principalFor } from "./helpers/principals";

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
  syncMetadataTables: jest.fn(),
}));
jest.mock("../lib/db/bootstrap", () => ({ seedBuiltInRoles: jest.fn() }));

let mockGate: Gate;
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => mockGate,
  requireMember: async () => mockGate,
}));

jest.mock("../lib/agent-db", () => ({ approveLink: jest.fn(), denyLink: jest.fn(), readLink: jest.fn() }));
jest.mock("../lib/push-db", () => ({
  deletePushSubscription: jest.fn(),
  rememberSiteOrigin: jest.fn(),
  savePushSubscription: jest.fn(),
}));
jest.mock("../lib/push-send", () => ({ pushPublicKey: jest.fn() }));
jest.mock("../lib/trial-sandbox", () => ({
  ...jest.requireActual("../lib/trial-sandbox"),
  resetTrial: jest.fn(),
}));

import * as agentDb from "../lib/agent-db";
import {
  TRIAL_BLOCKED_PERMISSIONS,
  TRIAL_PEOPLE,
  TRIAL_REFUSAL,
  isTrialEmail,
  isTrialOrg,
  toTrialRole,
  trialEnabled,
  trialPermissions,
} from "../lib/trial-rules";
import { trialSeedSql } from "../lib/trial-seed";
import { resetTrial, trialDatabases, trialSignIn } from "../lib/trial-sandbox";
import { orgSlugProblem } from "../lib/new-organization";
import { ALL_PERMISSIONS } from "../lib/permissions";
import { canAnswerRequests, grantProblem } from "../lib/access-requests";
import { POST as approveLink } from "../app/api/computers/link/route";
import { POST as savePush } from "../app/api/phone/push/route";
import { POST as resetTrialRoute } from "../app/api/trial/reset/route";

const SITE = "studio.example.test";
const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  jest.clearAllMocks();
});

function trialOn() {
  process.env.TRIAL_SANDBOX = "on";
  delete process.env.SCHEMA_STUDIO_DESKTOP;
}

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`https://${SITE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: SITE, origin: `https://${SITE}` },
    body: JSON.stringify(body),
  });
}

function inTrial(role: "admin" | "editor" | "viewer"): Gate {
  const base = principalFor(role);
  return { ok: true, principal: { ...base, orgSlug: "trial", orgName: "Schema Studio Trial", orgIsDefault: false } };
}

describe("the trial's rules", () => {
  it("is on only with TRIAL_SANDBOX=on, and never in the desktop app", () => {
    delete process.env.TRIAL_SANDBOX;
    expect(trialEnabled()).toBe(false);
    trialOn();
    expect(trialEnabled()).toBe(true);
    process.env.SCHEMA_STUDIO_DESKTOP = "1";
    expect(trialEnabled()).toBe(false);
  });

  it("treats an organization called trial as the trial only while the trial is on", () => {
    delete process.env.TRIAL_SANDBOX;
    expect(isTrialOrg("trial")).toBe(false);
    trialOn();
    expect(isTrialOrg("trial")).toBe(true);
    expect(isTrialOrg("trial-co")).toBe(false);
    expect(isTrialOrg(null)).toBe(false);
  });

  it("takes only the three roles", () => {
    expect(toTrialRole("admin")).toBe("admin");
    expect(toTrialRole("viewer")).toBe("viewer");
    expect(toTrialRole("owner")).toBeNull();
    expect(toTrialRole(["admin"])).toBeNull();
    expect(toTrialRole(null)).toBeNull();
  });

  it("knows the trial accounts by their address, and no one else", () => {
    expect(isTrialEmail(TRIAL_PEOPLE.editor.email)).toBe(true);
    expect(isTrialEmail(TRIAL_PEOPLE.admin.email.toUpperCase())).toBe(true);
    expect(isTrialEmail("someone@trial.schema-studio.invalid.example.com")).toBe(false);
    expect(isTrialEmail("trial.schema-studio.invalid@example.com")).toBe(false);
    expect(isTrialEmail(undefined)).toBe(false);
  });

  it("takes the blocked permissions away from even an Admin, and leaves the rest", () => {
    const left = trialPermissions(ALL_PERMISSIONS);
    for (const key of TRIAL_BLOCKED_PERMISSIONS) expect(left).not.toContain(key);
    expect(left).toEqual(expect.arrayContaining(["deploy:run", "approvals:create", "connections:read", "drift:run"]));
    expect(left).toHaveLength(ALL_PERMISSIONS.length - TRIAL_BLOCKED_PERMISSIONS.size);
  });

  it("lets the Trial Admin answer requests and allow somebody for a day, though roles are locked", () => {
    const admin = { ...principalFor("admin"), permissions: trialPermissions(ALL_PERMISSIONS) };
    expect(canAnswerRequests(admin)).toBe(true);
    expect(grantProblem(admin, "deploy:run")).toBeNull();
    // Nothing the trial switches off can be lent either.
    expect(grantProblem(admin, "connections:create")).toMatch(/cannot do that yourself/);
    const editor = principalFor("editor");
    expect(canAnswerRequests({ ...editor, permissions: trialPermissions(editor.permissions) })).toBe(false);
  });

  it("keeps the trial's address from anyone making an organization", () => {
    expect(orgSlugProblem("trial")).toMatch(/kept for the trial/);
    expect(orgSlugProblem("trial-run")).toBeNull();
  });
});

describe("the Reset trial button", () => {
  beforeEach(trialOn);

  it("lets the Trial Admin save a GitHub token", () => {
    expect(TRIAL_BLOCKED_PERMISSIONS.has("github:update")).toBe(false);
  });

  it("resets the trial for the Trial Admin", async () => {
    mockGate = inTrial("admin");
    const response = await resetTrialRoute();
    expect(response.status).toBe(200);
    expect(resetTrial).toHaveBeenCalledTimes(1);
  });

  it("is the Trial Admin's alone", async () => {
    mockGate = inTrial("editor");
    const response = await resetTrialRoute();
    expect(response.status).toBe(403);
    expect(resetTrial).not.toHaveBeenCalled();
  });

  it("never touches an organization that is not the trial", async () => {
    mockGate = { ok: true, principal: principalFor("admin") };
    const response = await resetTrialRoute();
    expect(response.status).toBe(404);
    expect(resetTrial).not.toHaveBeenCalled();
  });

  it("says so when the reset fails, and leaves out why", async () => {
    mockGate = inTrial("admin");
    jest.mocked(resetTrial).mockRejectedValueOnce(new Error("secret detail"));
    const quiet = jest.spyOn(console, "error").mockImplementation(() => {});
    const response = await resetTrialRoute();
    quiet.mockRestore();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret detail");
  });
});

describe("the demo databases", () => {
  it("are none without TRIAL_DATABASE_URL, or with one that is not a postgres URL", () => {
    const quiet = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(trialDatabases(undefined)).toBeNull();
    expect(trialDatabases("not a url")).toBeNull();
    expect(trialDatabases("mysql://u:p@h/db")).toBeNull();
    quiet.mockRestore();
  });

  it("are the three trial databases on the server the URL names, whatever database it names", () => {
    const dbs = trialDatabases("postgresql://trial_sandbox:p%40ss@db.example.com/neondb?sslmode=require");
    expect(dbs?.map((db) => db.database)).toEqual(["trial_prod", "trial_staging", "trial_dev"]);
    expect(dbs?.[0]).toMatchObject({
      host: "db.example.com",
      port: 5432,
      user: "trial_sandbox",
      password: "p@ss",
      sslMode: "require",
    });
    expect(trialDatabases("postgres://u:p@127.0.0.1:55432/x?sslmode=disable")?.[2]).toMatchObject({
      port: 55432,
      sslMode: "disable",
    });
  });

  it("differ from stage to stage, so Compare has something to show", () => {
    const prod = trialSeedSql("prod");
    const staging = trialSeedSql("staging");
    const dev = trialSeedSql("dev");
    expect(prod).toContain("books_title_idx");
    expect(staging).not.toContain("books_title_idx");
    expect(prod).toContain("email varchar(100)");
    expect(staging).toContain("email varchar(255)");
    expect(staging).toContain("author varchar(100)");
    expect(dev).toContain("CREATE TABLE public.reviews");
    expect(dev).toContain("CREATE TYPE public.order_status");
    expect(dev).toMatch(/\bname varchar\(100\)/);
    expect(prod).toContain("full_name varchar(100)");
  });
});

describe("signing in to the trial", () => {
  it("lets nobody in while the trial is off, or as anyone but the three", async () => {
    delete process.env.TRIAL_SANDBOX;
    expect(await trialSignIn("admin")).toBeNull();
    trialOn();
    expect(await trialSignIn("owner")).toBeNull();
    expect(await trialSignIn(undefined)).toBeNull();
  });
});

describe("routes a trial account may not use", () => {
  beforeEach(trialOn);

  it("will not link a computer to the trial, where every visitor could reach it", async () => {
    mockGate = inTrial("admin");
    const response = await approveLink(post("/api/computers/link", { code: "BCDF-GHJK" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(TRIAL_REFUSAL);
    expect(agentDb.approveLink).not.toHaveBeenCalled();
  });

  it("will not send the trial's alerts to a visitor's device", async () => {
    mockGate = inTrial("viewer");
    const response = await savePush(
      post("/api/phone/push", { endpoint: "https://push.example.com/abc", keys: { p256dh: "x", auth: "y" } })
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(TRIAL_REFUSAL);
  });

  it("still links a computer in any other organization", async () => {
    mockGate = { ok: true, principal: principalFor("admin") };
    jest.mocked(agentDb.approveLink).mockResolvedValue(true);
    const response = await approveLink(post("/api/computers/link", { code: "BCDF-GHJK" }));
    expect(response.status).toBe(200);
  });
});
