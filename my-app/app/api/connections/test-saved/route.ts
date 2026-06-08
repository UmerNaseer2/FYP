import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";
import pool from "../../../../lib/version-db";

export async function POST(request: NextRequest) {
  let testPool: Pool | null = null;

  try {
    const { id } = await request.json();

    if (!id) {
      return NextResponse.json(
        { error: "Connection ID is required." },
        { status: 400 }
      );
    }

    const result = await pool.query(
      `SELECT host, port, database_name, type, username, password, connection_string
       FROM connections
       WHERE id = $1`,
      [id]
    );

    const conn = result.rows[0];

    if (!conn) {
      return NextResponse.json(
        { error: "Connection not found." },
        { status: 404 }
      );
    }

    if (conn.type !== "PostgreSQL") {
      return NextResponse.json(
        { error: "Only PostgreSQL is supported now." },
        { status: 400 }
      );
    }

    if (conn.connection_string && conn.connection_string.trim() !== "") {
      testPool = new Pool({
        connectionString: conn.connection_string.trim(),
        connectionTimeoutMillis: 10000,
      });
    } else {
      testPool = new Pool({
        host: conn.host,
        port: Number(conn.port),
        database: conn.database_name || "postgres",
        user: conn.username,
        password: conn.password,
        connectionTimeoutMillis: 10000,
      });
    }

    await testPool.query("SELECT NOW()");

    return NextResponse.json({
      success: true,
      message: "Connection successful.",
    });
  } catch (error) {
    console.error("Saved test connection error:", error);

    return NextResponse.json(
      { error: "Connection failed. Please check saved details." },
      { status: 500 }
    );
  } finally {
    if (testPool) {
      await testPool.end();
    }
  }
}