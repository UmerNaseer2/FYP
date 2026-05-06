import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

export async function POST(request: NextRequest) {
  let testPool: Pool | null = null;

  try {
    const {
      host,
      port,
      type,
      username,
      password,
      database_name,
      connection_string,
    } = await request.json();

    // only support PostgreSQL
    if (type !== "PostgreSQL") {
      return NextResponse.json(
        { error: "Only PostgreSQL is supported now." },
        { status: 400 }
      );
    }

    // decide connection method
    if (connection_string && connection_string.trim() !== "") {
      // use connection string
      testPool = new Pool({
        connectionString: connection_string.trim(),
        connectionTimeoutMillis: 10000, // 10 seconds
      });
    } else {
      // use manual fields
      if (!host || !port || !username || !password) {
        return NextResponse.json(
          { error: "Host, port, username, and password are required." },
          { status: 400 }
        );
      }

      testPool = new Pool({
        host: host || "localhost",
        port: Number(port) || 5432,
        database: database_name || "postgres",
        user: username || "postgres",
        password: password,
        connectionTimeoutMillis: 10000, // 10 seconds
      });
    }

    // test query
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
          "Connection failed. Check host, port, username, password, or database name.",
      },
      { status: 500 }
    );
  } finally {
    if (testPool) {
      await testPool.end();
    }
  }
}