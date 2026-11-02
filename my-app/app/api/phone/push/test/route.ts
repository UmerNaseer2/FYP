import { NextResponse } from "next/server";
import { requireMember } from "@/lib/auth-guard";
import { orgHref } from "@/lib/org-slug";
import { listOwnSubscriptions } from "@/lib/push-db";
import { sendAlert } from "@/lib/push-send";

/**
 * Sends a test alert to the devices of the person asking, and no one else's,
 * so that they can see in one tap that alerts reach them.
 */
export async function POST() {
  const gate = await requireMember();
  if (!gate.ok) return gate.response;
  const { profileId, orgSlug } = gate.principal;
  if (profileId === null) {
    return NextResponse.json({ error: "Alerts need a signed-in account." }, { status: 409 });
  }
  try {
    const devices = await listOwnSubscriptions(profileId);
    const report = await sendAlert(devices, {
      kind: "test",
      title: "Schema Studio",
      body: "Alerts are working on this device.",
      url: orgHref(orgSlug, "/phone?tab=alerts"),
    });
    return NextResponse.json(report);
  } catch (error) {
    console.error("Could not send a test alert:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not send a test alert." }, { status: 500 });
  }
}
