import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

export async function POST(request: NextRequest) {
  let testPool: Pool | null = null;

  try {
    const body = await request.json();

    const type = String(body.type ?? "PostgreSQL");
    const host = String(body.host ?? "localhost").trim();
    const port = Number(body.port ?? 5432);
    const database = String(body.database_name ?? "postgres").trim();
    const username = String(body.username ?? "postgres").trim();
    const password = String(body.password ?? "").trim();
    const connectionString = String(body.connection_string ?? "").trim();
    const ssl_enabled = Boolean(body.ssl_enabled);

    if (type !== "PostgreSQL") {
      return NextResponse.json(
        { error: "Only PostgreSQL is supported now." },
        { status: 400 }
      );
    }

    testPool = new Pool(
      connectionString
        ? {
            connectionString,
            ssl: ssl_enabled ? { rejectUnauthorized: false } : false,
            connectionTimeoutMillis: 10000,
          }
        : {
            host,
            port,
            database,
            user: username,
            password,
            ssl: ssl_enabled ? { rejectUnauthorized: false } : false,
            connectionTimeoutMillis: 10000,
          }
    );

    await testPool.query("SELECT NOW()");

    return NextResponse.json({
      success: true,
      message: "Connection successful.",
    });
  } catch (error) {
    console.error("Test connection error:", error);

    return NextResponse.json(
      {
        error:
          "Connection failed. Please check host, port, database name, username, password, and SSL.",
      },
      { status: 500 }
    );
  } finally {
    if (testPool) {
      await testPool.end();
    }
  }
}