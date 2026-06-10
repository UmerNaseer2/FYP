import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/version-db";

async function createConnectionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS connections (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 5432,
      database_name TEXT NOT NULL DEFAULT 'postgres',
      type TEXT NOT NULL DEFAULT 'PostgreSQL',
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      connection_string TEXT,
      db_location TEXT DEFAULT 'local',
      ssl_enabled BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    ALTER TABLE connections
    ADD COLUMN IF NOT EXISTS db_location TEXT DEFAULT 'local',
    ADD COLUMN IF NOT EXISTS ssl_enabled BOOLEAN DEFAULT false
  `);
}

export async function GET() {
  try {
    await createConnectionsTable();

    const result = await pool.query(`
      SELECT id, name, host, port, database_name, type, username,
             connection_string, db_location, ssl_enabled
      FROM connections
      ORDER BY id DESC
    `);

    return NextResponse.json(result.rows);
  } catch (error) {
    console.error("GET connections error:", error);
    return NextResponse.json([], { status: 200 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await createConnectionsTable();

    const body = await request.json();

    const name = String(body.name ?? "").trim();
    const host = String(body.host ?? "localhost").trim();
    const port = Number(body.port ?? 5432);
    const database_name = String(body.database_name ?? "postgres").trim();
    const type = String(body.type ?? "PostgreSQL").trim();
    const username = String(body.username ?? "postgres").trim();
    const password = String(body.password ?? "").trim();
    const connection_string = String(body.connection_string ?? "").trim();
    const db_location = String(body.db_location ?? "local").trim();
    const ssl_enabled = Boolean(body.ssl_enabled);

    if (!name || !host || !port || !database_name || !type || !username || !password) {
      return NextResponse.json(
        { error: "Please fill in all required fields." },
        { status: 400 }
      );
    }

    const result = await pool.query(
      `
      INSERT INTO connections
      (name, host, port, database_name, type, username, password, connection_string, db_location, ssl_enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id, name, host, port, database_name, type, username, connection_string, db_location, ssl_enabled
      `,
      [
        name,
        host,
        port,
        database_name,
        type,
        username,
        password,
        connection_string || null,
        db_location,
        ssl_enabled,
      ]
    );

    return NextResponse.json(result.rows[0]);
  } catch (error) {
    console.error("POST connection error:", error);
    return NextResponse.json(
      { error: "Failed to save connection." },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    await createConnectionsTable();

    const body = await request.json();

    const id = Number(body.id);
    const name = String(body.name ?? "").trim();
    const host = String(body.host ?? "localhost").trim();
    const port = Number(body.port ?? 5432);
    const database_name = String(body.database_name ?? "postgres").trim();
    const type = String(body.type ?? "PostgreSQL").trim();
    const username = String(body.username ?? "postgres").trim();
    const password = String(body.password ?? "").trim();
    const connection_string = String(body.connection_string ?? "").trim();
    const db_location = String(body.db_location ?? "local").trim();
    const ssl_enabled = Boolean(body.ssl_enabled);

    if (!id || !name || !host || !port || !database_name || !type || !username || !password) {
      return NextResponse.json(
        { error: "Please fill in all required fields." },
        { status: 400 }
      );
    }

    const result = await pool.query(
      `
      UPDATE connections
      SET name = $1,
          host = $2,
          port = $3,
          database_name = $4,
          type = $5,
          username = $6,
          password = $7,
          connection_string = $8,
          db_location = $9,
          ssl_enabled = $10
      WHERE id = $11
      RETURNING id, name, host, port, database_name, type, username, connection_string, db_location, ssl_enabled
      `,
      [
        name,
        host,
        port,
        database_name,
        type,
        username,
        password,
        connection_string || null,
        db_location,
        ssl_enabled,
        id,
      ]
    );

    return NextResponse.json(result.rows[0]);
  } catch (error) {
    console.error("PUT connection error:", error);
    return NextResponse.json(
      { error: "Failed to update connection." },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await createConnectionsTable();

    const body = await request.json();
    const id = Number(body.id);

    if (!id) {
      return NextResponse.json(
        { error: "Connection ID is required." },
        { status: 400 }
      );
    }

    await pool.query("DELETE FROM connections WHERE id = $1", [id]);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE connection error:", error);
    return NextResponse.json(
      { error: "Failed to delete connection." },
      { status: 500 }
    );
  }
}