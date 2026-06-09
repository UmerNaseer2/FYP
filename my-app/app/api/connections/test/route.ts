import { NextRequest, NextResponse } from "next/server";
import { runConnectionTest } from "@/lib/connection-config";

/** Test an unsaved connection from the add/edit drawer (fields or URI + SSL). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const type = String(body.type ?? "PostgreSQL");
    if (type !== "PostgreSQL") {
      return NextResponse.json(
        { ok: false, error: "Only PostgreSQL is supported right now.", sslRequired: false, detail: "" },
        { status: 400 }
      );
    }

    const result = await runConnectionTest({
      host: body.host,
      port: body.port,
      database: body.database_name,
      user: body.username,
      password: body.password,
      connectionString: body.connection_string,
      ssl: Boolean(body.ssl),
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
