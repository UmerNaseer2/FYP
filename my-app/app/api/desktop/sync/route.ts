import { NextRequest, NextResponse } from "next/server";
import { findDefaultOrganization } from "@/lib/orgs-db";
import {
  MOST_SYNCED,
  SYNC_HEADER,
  adoptOwnConnection,
  applySiteCopies,
  exportOwnConnection,
  listOwnConnections,
  readSiteCopy,
  syncTokenMatches,
  type SiteCopy,
} from "@/lib/desktop-sync";

/**
 * The desktop app's main process keeping this computer in step with the
 * website it is linked to (docs/two-way-sync-plan.md). Not a page's route:
 * it answers 404 to anything without the main process's own token, and on a
 * website, where there is no such token, to everything (lib/desktop-sync.ts).
 *
 * One POST, four actions:
 *   apply   { connections }            the website's list; copies made to match
 *   local   {}                         this computer's own connections, names only, with drift results
 *   export  { id }                     one of them in full, to send to the website
 *   adopt   { id, siteId, siteVersion } it became that website connection
 */

function notHere(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

function bad(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export async function POST(request: NextRequest) {
  if (!syncTokenMatches(request.headers.get(SYNC_HEADER))) return notHere();
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("Expected a JSON body.");
  const asked = body as Record<string, unknown>;

  const org = await findDefaultOrganization();
  if (!org) return NextResponse.json({ error: "This computer has no organization yet." }, { status: 503 });

  try {
    switch (asked.action) {
      case "apply": {
        if (!Array.isArray(asked.connections) || asked.connections.length > MOST_SYNCED) {
          return bad("Expected a list of connections.");
        }
        const copies: SiteCopy[] = [];
        let unreadable = 0;
        for (const item of asked.connections) {
          const copy = readSiteCopy(item);
          if (copy) copies.push(copy);
          else unreadable += 1;
        }
        const done = await applySiteCopies(org.id, copies);
        const skipped = done.skipped + unreadable;
        if (skipped > 0) console.warn(`Left out ${skipped} of the website's connections that this computer could not use.`);
        return NextResponse.json({ kept: done.kept, skipped });
      }
      case "local":
        return NextResponse.json({ connections: await listOwnConnections(org.id) });
      case "export": {
        const id = positive(asked.id);
        if (id === null) return bad("Expected a connection number.");
        const connection = await exportOwnConnection(org.id, id);
        if (!connection) return NextResponse.json({ error: "Connection not found on this computer." }, { status: 404 });
        return NextResponse.json({ connection });
      }
      case "adopt": {
        const id = positive(asked.id);
        const siteId = positive(asked.siteId);
        const siteVersion = positive(asked.siteVersion);
        if (id === null || siteId === null || siteVersion === null) return bad("Expected three numbers.");
        return NextResponse.json({ adopted: await adoptOwnConnection(org.id, id, siteId, siteVersion) });
      }
      default:
        return bad("Unknown action.");
    }
  } catch (error) {
    console.error("Desktop sync failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Could not update this computer's connections." }, { status: 500 });
  }
}
