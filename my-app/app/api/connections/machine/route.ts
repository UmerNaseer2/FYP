import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { localMachineName, localStoreConfigured } from "@/lib/local-secrets";

/**
 * The name of the machine this copy runs on, when it keeps local connections'
 * passwords (LOCAL_DATABASE_URL). The Connections form uses it to offer "Only
 * this machine can reach it". Null on a copy with no local store (Vercel, the
 * desktop app, the client's container image), where every connection is saved
 * as before.
 */
export async function GET() {
  const gate = await requirePermission("connections:read", "connections:create", "connections:update");
  if (!gate.ok) return gate.response;
  return NextResponse.json({ name: localStoreConfigured() ? localMachineName() : null });
}
