import { NextRequest, NextResponse } from "next/server";
import pool from "../../../lib/db";

async function createConnectionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS connections (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      database_name TEXT NOT NULL DEFAULT 'postgres',
      type TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      connection_string TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    ALTER TABLE connections
    ADD COLUMN IF NOT EXISTS database_name TEXT NOT NULL DEFAULT 'postgres',
    ADD COLUMN IF NOT EXISTS connection_string TEXT
  `);
}

export async function GET() {
  try {
    await createConnectionsTable();

    const result = await pool.query(`
      SELECT id, name, host, port, database_name, type, username, connection_string
      FROM connections
      ORDER BY id DESC
    `);

    return NextResponse.json(result.rows);
  } catch (error) {
    console.error("GET connections error:", error);
    return NextResponse.json({ error: "Failed to load connections." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await createConnectionsTable();

    const {
      name,
      host,
      port,
      database_name,
      type,
      username,
      password,
      connection_string,
    } = await request.json();

    if (!name || !host || !port || !database_name || !type || !username || !password) {
      return NextResponse.json({ error: "All fields are required." }, { status: 400 });
    }

    const result = await pool.query(
      `INSERT INTO connections 
       (name, host, port, database_name, type, username, password, connection_string)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, name, host, port, database_name, type, username, connection_string`,
      [
        name,
        host,
        Number(port),
        database_name,
        type,
        username,
        password,
        connection_string || null,
      ]
    );

    return NextResponse.json(result.rows[0], { status: 201 });
  } catch (error) {
    console.error("POST connection error:", error);
    return NextResponse.json({ error: "Failed to save connection." }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    await createConnectionsTable();

    const {
      id,
      name,
      host,
      port,
      database_name,
      type,
      username,
      password,
      connection_string,
    } = await request.json();

    if (!id || !name || !host || !port || !database_name || !type || !username || !password) {
      return NextResponse.json({ error: "All fields are required." }, { status: 400 });
    }

    const result = await pool.query(
      `UPDATE connections
       SET name=$1, host=$2, port=$3, database_name=$4, type=$5,
           username=$6, password=$7, connection_string=$8
       WHERE id=$9
       RETURNING id, name, host, port, database_name, type, username, connection_string`,
      [
        name,
        host,
        Number(port),
        database_name,
        type,
        username,
        password,
        connection_string || null,
        id,
      ]
    );

    return NextResponse.json(result.rows[0]);
  } catch (error) {
    console.error("PUT connection error:", error);
    return NextResponse.json({ error: "Failed to update connection." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await createConnectionsTable();

    const { id } = await request.json();
    await pool.query("DELETE FROM connections WHERE id = $1", [id]);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE connection error:", error);
    return NextResponse.json({ error: "Failed to delete connection." }, { status: 500 });
  }
}