import { NextRequest, NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/auth-guard";
import { createOrganization, listMemberships, listOrganizations } from "@/lib/orgs-db";
import { cleanOrgName, orgNameProblem, orgSlugProblem } from "@/lib/new-organization";

/**
 * The caller's organizations, and a way to make a new one.
 *
 * This is the one route about a person's organizations as a whole rather than
 * about one of them, so it opens with requireSignedIn, which asks who someone
 * is and nothing about any organization. Everything else opens with a gate
 * that checks membership of the organization in the address. Here there is no
 * organization to be a member of yet: someone who has just signed up belongs
 * to none, and this is how they make their first.
 *
 * GET lists the organizations the caller belongs to, for the studio's
 * organization switcher and the onboarding page. With the bypass there is no
 * one signed in, and the demo user is an Admin everywhere, so it lists every
 * organization. `canCreate` says whether POST would be allowed, so neither
 * screen offers a button that can only be refused.
 *
 * POST makes an organization with the caller as its Admin
 * (lib/orgs-db.ts createOrganization). It is refused in two places:
 *
 * - The desktop app, which keeps one organization of its own that nobody
 *   sees. A second one would have nowhere to show.
 * - The bypass, where nobody is signed in. An organization needs a person to
 *   be its first Admin, and the demo user is not one.
 *
 * A taken address is a 409, which does tell the caller that an organization
 * with that address exists. There is no way around that without making
 * addresses something other than names people pick, and the address of an
 * organization is in every link to it anyway.
 */
export async function GET() {
  const gate = await requireSignedIn();
  if (!gate.ok) return gate.response;

  const { caller } = gate;
  try {
    const organizations = caller.bypass
      ? await listOrganizations()
      : await listMemberships(caller.profileId);
    return NextResponse.json({
      organizations: organizations.map(({ slug, name }) => ({ slug, name })),
      canCreate: !caller.bypass && !onDesktop(),
    });
  } catch (error) {
    console.error("Failed to list organizations:", error);
    return unavailable("Could not read your organizations.");
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireSignedIn();
  if (!gate.ok) return gate.response;

  const { caller } = gate;
  if (onDesktop()) {
    return NextResponse.json(
      { error: "The desktop app keeps a single organization of its own." },
      { status: 403 }
    );
  }
  if (caller.bypass) {
    return NextResponse.json(
      {
        error:
          "Making an organization needs a real sign-in. The demo has its organizations already.",
      },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const fields = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;

  // Each refusal names the field it is about, so the form can put the message
  // under the box that needs changing.
  const name = cleanOrgName(typeof fields.name === "string" ? fields.name : "");
  const nameProblem = orgNameProblem(name);
  if (nameProblem) {
    return NextResponse.json({ error: nameProblem, field: "name" }, { status: 400 });
  }
  const slug = typeof fields.slug === "string" ? fields.slug.trim() : "";
  const slugProblem = orgSlugProblem(slug);
  if (slugProblem) {
    return NextResponse.json({ error: slugProblem, field: "slug" }, { status: 400 });
  }

  try {
    const created = await createOrganization(caller.profileId, { slug, name });
    if (created.kind === "taken") {
      return NextResponse.json(
        { error: "That address is taken. Pick another.", field: "slug" },
        { status: 409 }
      );
    }
    if (created.kind === "no-profile") {
      // The profile was deleted after this person signed in. Signing in again
      // makes them a new one.
      return NextResponse.json({ error: "Sign in again to continue." }, { status: 401 });
    }
    const { organization } = created;
    return NextResponse.json(
      { organization: { slug: organization.slug, name: organization.name } },
      { status: 201 }
    );
  } catch (error) {
    console.error("Failed to make an organization:", error);
    return unavailable("Could not make the organization.");
  }
}

/** The desktop app starts this server with SCHEMA_STUDIO_DESKTOP=1 (see auth.config.ts). */
function onDesktop(): boolean {
  return process.env.SCHEMA_STUDIO_DESKTOP === "1";
}

/** A 503 for a database that did not answer, with the reason kept to the log. */
function unavailable(what: string): NextResponse {
  return NextResponse.json(
    { error: `${what} The app's database may be unreachable. Try again in a moment.` },
    { status: 503 }
  );
}
