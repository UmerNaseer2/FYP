import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

export async function POST(request: NextRequest) {
  let testPool: Pool | null = null;

  try {
    const { host, port, type, username, password, database } =
      await request.json();

    if (type !== "PostgreSQL") {
      return NextResponse.json(
        { error: "Only PostgreSQL test is supported now." },
        { status: 400 }
      );
    }

    if (!host || !port || !username || !password) {
      return NextResponse.json(
        { error: "Host, port, username, and password are required." },
        { status: 400 }
      );
    }

    testPool = new Pool({
      host,
      port: Number(port),
      database: database || "postgres",
      user: username,
      password,
      connectionTimeoutMillis: 5000,
    });

    await testPool.query("SELECT NOW()");

    return NextResponse.json({
      success: true,
      message: "Connection successful.",
    });
  } catch (error) {
    console.error("Test connection error:", error);
    return NextResponse.json(
      { error: "Connection failed. Check your details." },
      { status: 500 }
    );
  } finally {
    if (testPool) {
      await testPool.end();
    }
  }
}