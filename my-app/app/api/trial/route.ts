// POST /api/trial: the three cards of the landing page's role picker
// (components/landing/TrialRolePicker.tsx), and the account menu's "Switch to
// Trial Editor" items inside the trial (components/studio/AccountMenu.tsx).
// Signs the visitor in as that trial account (lib/trial-sandbox.ts makes the
// trial ready first) and sends them on: from the landing page to the studio,
// which offers the tour; from a role switch back to the page it was pressed
// on, as the new account, with no tour offer.
//
// A plain form post, not a server action, on purpose: the browser then loads
// the studio as a whole new page, so the page asks who is signed in afresh. A
// server action moves on without reloading, and the page kept the "nobody is
// signed in" it had on the landing page and went to /login.
//
// Open to anyone (lib/public-paths.ts), since nobody is signed in yet. It only
// ever signs in one of the three trial accounts, and only for a form posted
// from this site's own pages.

import { NextResponse, type NextRequest } from "next/server";
import { signIn } from "@/auth";
import { TRIAL_ORG_SLUG, toTrialRole, trialEnabled, type TrialRole } from "@/lib/trial-rules";

/** A 303, so the browser follows with a GET. */
function goTo(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url), 303);
}

/**
 * A page of the trial organization, such as /trial/compare. Letters, digits,
 * "-" and "_" only, so a role switch can never be sent to another site,
 * another organization, a query string or "..".
 */
const TRIAL_PAGE = new RegExp(`^/${TRIAL_ORG_SLUG}(?:/[A-Za-z0-9_-]+)*/?$`);
const TRIAL_ADMIN_PAGE = new RegExp(`^/${TRIAL_ORG_SLUG}/admin(?:/|$)`);

/**
 * Where a role switch lands: the page it was pressed on, or the trial's home
 * when that page is not a trial page or the new role cannot open it (only the
 * Admin opens Admin).
 */
function afterSwitch(page: string, role: TrialRole): string {
  const home = `/${TRIAL_ORG_SLUG}`;
  if (page.length > 200 || !TRIAL_PAGE.test(page)) return home;
  return role !== "admin" && TRIAL_ADMIN_PAGE.test(page) ? home : page;
}

/** True when the form was posted from a page on this same site. */
function fromThisSite(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!trialEnabled()) return goTo(request, "/");
  if (!fromThisSite(request)) {
    return NextResponse.json({ error: "Start the trial from the landing page." }, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  const role = toTrialRole(form?.get("role"));
  if (!role) return goTo(request, "/");
  // Only the account menu's role switch sends the page it was pressed on.
  const switchedOn = form?.get("next");

  try {
    const next = await signIn("trial", { role, redirect: false });
    if (typeof next === "string" && next.includes("error=")) throw new Error("The trial sign-in was refused.");
  } catch (error) {
    console.error("Could not start the trial:", error instanceof Error ? error.message : "unknown error");
    return goTo(request, "/login?error=TrialUnavailable");
  }
  if (typeof switchedOn === "string") return goTo(request, afterSwitch(switchedOn, role));
  // ?tour=trial: AppTour offers the tour once the studio opens (lib/tour.ts).
  return goTo(request, "/studio?tour=trial");
}
