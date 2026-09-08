import { NextRequest, NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth-guard";
import { runConnectionTest } from "@/lib/connection-config";
import {
  parsePort,
  sslModeFromLegacyBoolean,
  toSslMode,
  type SslMode,
} from "@/lib/connection-validate";

/** Test an unsaved connection from the add/edit drawer (fields or URI + SSL). */
export async function POST(request: NextRequest) {
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  try {
    const body = await request.json();

    const type = String(body.type ?? "PostgreSQL");
    if (type !== "PostgreSQL") {
      return NextResponse.json(
        { ok: false, error: "Only PostgreSQL is supported right now.", sslRequired: false, detail: "" },
        { status: 400 }
      );
    }

    // A port outside 1–65535 makes the driver throw something opaque
    // ("Invalid URL", "port should be >= 0"). Name the real problem instead.
    const portGiven =
      body.port !== null && body.port !== undefined && String(body.port).trim() !== "";
    if (portGiven && parsePort(body.port) === null) {
      return NextResponse.json(
        {
          ok: false,
          error: "Port must be a whole number between 1 and 65535.",
          sslRequired: false,
          detail: "",
        },
        { status: 400 }
      );
    }

    const sslMode: SslMode =
      body.ssl_mode !== undefined && body.ssl_mode !== null && body.ssl_mode !== ""
        ? toSslMode(body.ssl_mode)
        : sslModeFromLegacyBoolean(body.ssl);

    const result = await runConnectionTest({
      host: body.host,
      port: body.port,
      database: body.database_name,
      user: body.username,
      password: body.password,
      connectionString: body.connection_string,
      ssl: Boolean(body.ssl),
      sslMode,
    });

    // Always 200: the drawer reads `ok` and renders the matching banner.
    return NextResponse.json(result);
  } catch (error) {
    console.error("Test connection route error:", error);
    return NextResponse.json(
      { ok: false, error: "Could not run the test.", sslRequired: false, detail: "" },
      { status: 200 }
    );
  }
}
