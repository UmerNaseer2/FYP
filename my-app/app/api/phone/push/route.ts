import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/auth-guard";
import { TRIAL_REFUSAL, isTrialOrg } from "@/lib/trial-rules";
import {
  deletePushSubscription,
  pushPublicKey,
  rememberSiteOrigin,
  savePushSubscription,
} from "@/lib/push-db";
import { readPushEndpoint, readPushSubscription } from "@/lib/web-push";

/**
 * Turning phone alerts on and off for the device asking.
 *
 * A device's address and keys go in the body, never the query string, because
 * request paths land in logs, and nothing here hands them back.
 *
 * Anyone in the organization may turn alerts on, and which ones reach them
 * depends on what they may read when each is sent (lib/push-alerts.ts).
 */

const NEEDS_ACCOUNT = "Alerts need a signed-in account.";
const NOT_A_DEVICE = "This browser's alert details could not be read.";

/** The site's address, for push services to contact. Only ever the address this request came to. */
function siteOriginOf(request: NextRequest): string | null {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin === null || host === null) return null;
  try {
    const parsed = new URL(origin);
    return parsed.host === host ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** The public half of the server's push key, which a browser subscribes with. */
export async function GET() {
  const gate = await requireMember();
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({
      publicKey: await pushPublicKey(),
      available: gate.principal.profileId !== null,
    });
  } catch (error) {
    console.error("Could not read the push key:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not read the alert settings." }, { status: 500 });
  }
}

/** Keeps this device for the person signed in. Sent again whenever the app opens, so a lost one comes back. */
export async function POST(request: NextRequest) {
  const gate = await requireMember();
  if (!gate.ok) return gate.response;
  const { profileId } = gate.principal;
  if (profileId === null) return NextResponse.json({ error: NEEDS_ACCOUNT }, { status: 409 });
  // A trial account is shared, so alerts would go to every visitor's device.
  if (isTrialOrg(gate.principal.orgSlug)) return NextResponse.json({ error: TRIAL_REFUSAL }, { status: 403 });

  const body = await request.json().catch(() => null);
  const subscription = readPushSubscription({
    endpoint: body?.endpoint,
    p256dh: body?.keys?.p256dh,
    auth: body?.keys?.auth,
  });
  if (subscription === null) return NextResponse.json({ error: NOT_A_DEVICE }, { status: 400 });

  try {
    await savePushSubscription(profileId, subscription);
    await rememberSiteOrigin(siteOriginOf(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Could not save a device:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not turn alerts on." }, { status: 500 });
  }
}

/** Forgets this device, if it is the person's own. */
export async function DELETE(request: NextRequest) {
  const gate = await requireMember();
  if (!gate.ok) return gate.response;
  const { profileId } = gate.principal;
  if (profileId === null) return NextResponse.json({ error: NEEDS_ACCOUNT }, { status: 409 });

  const body = await request.json().catch(() => null);
  const endpoint = readPushEndpoint(body?.endpoint);
  if (endpoint === null) return NextResponse.json({ error: NOT_A_DEVICE }, { status: 400 });

  try {
    await deletePushSubscription(profileId, endpoint);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Could not forget a device:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not turn alerts off." }, { status: 500 });
  }
}
