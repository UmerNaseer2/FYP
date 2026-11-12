// POST /api/trial: the landing page's "Try as Admin / Editor / Viewer"
// buttons. Signs the visitor in as that trial account (lib/trial-sandbox.ts
// makes the trial ready first) and sends them on to the studio.
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
import { toTrialRole, trialEnabled } from "@/lib/trial-rules";

/** A 303, so the browser follows with a GET. */
function goTo(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url), 303);
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

  try {
    const next = await signIn("trial", { role, redirect: false });
    if (typeof next === "string" && next.includes("error=")) throw new Error("The trial sign-in was refused.");
  } catch (error) {
    console.error("Could not start the trial:", error instanceof Error ? error.message : "unknown error");
    return goTo(request, "/login?error=TrialUnavailable");
  }
  return goTo(request, "/studio");
}
