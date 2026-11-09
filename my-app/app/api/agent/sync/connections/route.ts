import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/agent-auth";
import { agentPrincipal, type Principal } from "@/lib/auth-guard";
import { hasPermission, refusalMessage, type PermissionKey } from "@/lib/permissions";
import { runConnectionTest } from "@/lib/connection-config";
import { createConnection, deleteConnection, updateConnection, type WriteAnswer } from "@/lib/connection-writes";
import { sslModeFromLegacyBoolean, toSslMode } from "@/lib/connection-validate";

/**
 * A linked desktop saving one of the website's connections, as its person.
 *
 * The computer's token says who it is; from there each method checks the same
 * permission the Connections page's route does, against the role that person
 * holds on this website now, and runs the same code (lib/connection-writes.ts).
 * So a desktop can do through the link exactly what its person could do here.
 *
 * POST is how a connection added on a desktop, or sent up from one, lands
 * here. It is tested from this server first: only a database this website can
 * reach belongs to it. One it cannot reach answers `saved: false` with the
 * reason, and stays on the computer (docs/two-way-sync-plan.md, rule 3).
 */

const COULD_NOT_CHECK = "Could not check your role on the website. Try again in a moment.";

type Acting = { ok: true; principal: Principal; body: Record<string, unknown> } | { ok: false; response: NextResponse };

async function acting(request: NextRequest, permission: PermissionKey): Promise<Acting> {
  const gate = await requireAgent(request);
  if (!gate.ok) return gate;
  let principal: Principal | null;
  try {
    principal = await agentPrincipal(gate.agent);
  } catch (error) {
    console.error("Could not read a computer's person:", error instanceof Error ? error.name : "unknown error");
    principal = null;
  }
  if (!principal) return { ok: false, response: NextResponse.json({ error: COULD_NOT_CHECK }, { status: 503 }) };
  if (!hasPermission(principal, permission)) {
    return {
      ok: false,
      response: NextResponse.json({ error: refusalMessage(principal.roleLabel, permission) }, { status: 403 }),
    };
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: NextResponse.json({ error: "Expected a JSON body." }, { status: 400 }) };
  }
  return { ok: true, principal, body: body as Record<string, unknown> };
}

function send(answer: WriteAnswer): NextResponse {
  return NextResponse.json(answer.body, { status: answer.status });
}

export async function POST(request: NextRequest) {
  const asked = await acting(request, "connections:create");
  if (!asked.ok) return asked.response;
  const { body } = asked;
  const sslMode =
    body.ssl_mode !== undefined && body.ssl_mode !== null && body.ssl_mode !== ""
      ? toSslMode(body.ssl_mode)
      : sslModeFromLegacyBoolean(body.ssl);
  const test = await runConnectionTest({
    host: typeof body.host === "string" ? body.host : "",
    port: typeof body.port === "number" || typeof body.port === "string" ? body.port : null,
    database: typeof body.database_name === "string" ? body.database_name : "",
    user: typeof body.username === "string" ? body.username : "",
    password: typeof body.password === "string" ? body.password : "",
    connectionString: typeof body.connection_string === "string" ? body.connection_string : "",
    sslMode,
  });
  if (!test.ok) return NextResponse.json({ saved: false, reason: test.error });
  // What a computer sends up is a cloud connection: it has just been reached
  // from here, and its own local ones never leave it. So it is saved with its
  // password in the shared database even on a copy that keeps local ones.
  const answer = await createConnection(asked.principal, { ...body, local_only: false });
  if (answer.status !== 200) return send(answer);
  return NextResponse.json({ saved: true, connection: answer.body });
}

export async function PUT(request: NextRequest) {
  const asked = await acting(request, "connections:update");
  if (!asked.ok) return asked.response;
  // A change from a computer leaves the connection where its password is.
  const { local_only: _ignored, ...body } = asked.body;
  void _ignored;
  return send(await updateConnection(asked.principal, body));
}

export async function DELETE(request: NextRequest) {
  const asked = await acting(request, "connections:delete");
  if (!asked.ok) return asked.response;
  return send(await deleteConnection(asked.principal, asked.body));
}
