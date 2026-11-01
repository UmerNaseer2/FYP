import { createHash, timingSafeEqual } from "node:crypto";
import { after, NextResponse } from "next/server";
import { disabledReason, runSchedulerTick } from "@/lib/drift-scheduler";

/**
 * The scheduled call that wakes the drift checker where no timer can.
 *
 * On a serverless host a process lives only while requests come in, so a timer
 * has nothing to run in. Something outside (Supabase's pg_cron, see
 * deploy/SUPABASE-VERCEL.md) calls this once a minute instead.
 *
 * There is no person behind the call, so no session and no role: proxy.ts lets
 * it through (lib/public-paths.ts) and the shared secret below is the whole check.
 *
 * It answers at once and checks afterwards, because the caller does not wait:
 * pg_net gives up after two seconds by default. `after` keeps the function alive
 * until the tick is done, up to maxDuration.
 *
 * Accepted in any mode, because the lease in lib/drift-scheduler makes a timer
 * and a call agree. The answer names no organization and nothing that was checked.
 */

// The most the free plan allows. Needs Fluid Compute, on by default for new projects.
export const maxDuration = 300;

const MIN_SECRET_LENGTH = 32;

// Hashed first: timingSafeEqual wants equal lengths, and the secret's length is not for telling.
function sameSecret(given: string, expected: string): boolean {
  const hash = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(hash(given), hash(expected));
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  // Never compare against a blank or short secret: "Bearer undefined" must not pass.
  if (secret.length < MIN_SECRET_LENGTH) {
    return NextResponse.json({ error: "CRON_SECRET is not set on this server." }, { status: 503 });
  }
  if (!sameSecret(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  }
  if (disabledReason()) return NextResponse.json({ accepted: false });
  after(() => runSchedulerTick());
  return NextResponse.json({ accepted: true }, { status: 202 });
}
