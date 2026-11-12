import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/agent-auth";
import { replaceAgentConnections } from "@/lib/agent-db";
import {
  MOST_CONNECTIONS,
  MOST_DRIFT_SCHEMAS,
  cleanLabel,
  readDriftSchemas,
  type ComputerConnection,
} from "@/lib/agent-rules";

const LONGEST_CONNECTION_NAME = 200;

const NOT_A_LIST = `Send up to ${MOST_CONNECTIONS} connections, each with an id and a name.`;

/**
 * PUT /api/agent/connections
 * A linked computer lists the connections only it can reach, and which of them
 * its person shared with the phone. Only a number, a name,
 * that flag and the drift results of its watched schemas are copied from each,
 * so a host or a user sent by mistake is simply dropped here. Only shared ones can be asked about (createAgentJob); the rest
 * are shown to their owner on the Connections page.
 */
export async function PUT(request: NextRequest) {
  const gate = await requireAgent(request);
  if (!gate.ok) return gate.response;
  const body = await request.json().catch(() => null);
  const connections = readConnections((body as { connections?: unknown } | null)?.connections);
  if (connections === null) return NextResponse.json({ error: NOT_A_LIST }, { status: 400 });
  try {
    await replaceAgentConnections(gate.agent.id, connections);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Could not save a computer's connections:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not save this computer's connections." }, { status: 500 });
  }
}

function readConnections(value: unknown): ComputerConnection[] | null {
  if (!Array.isArray(value) || value.length > MOST_CONNECTIONS) return null;
  const list: ComputerConnection[] = [];
  const seen = new Set<number>();
  // Drift results are a nice-to-have: past the cap, or unreadable, they are left out rather than the list turned away.
  let room = MOST_DRIFT_SCHEMAS;
  for (const entry of value as { id?: unknown; name?: unknown; shared?: unknown; drift?: unknown }[]) {
    const id = entry?.id;
    const name = cleanLabel(entry?.name, LONGEST_CONNECTION_NAME);
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > 2147483647 || name === "") return null;
    if (seen.has(id)) return null;
    seen.add(id);
    const connection: ComputerConnection = { id, name, shared: entry.shared !== false };
    if (entry.drift !== undefined) {
      connection.drift = readDriftSchemas(entry.drift, room);
      room -= connection.drift.length;
    }
    list.push(connection);
  }
  return list;
}
