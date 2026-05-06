import { NextRequest, NextResponse } from "next/server";
import pool from "../../../lib/db";

async function createConnectionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS connections (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      type TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export async function GET() {
  try {
    await createConnectionsTable();

    const result = await pool.query(
      `SELECT id, name, host, port, type, username
       FROM connections
       ORDER BY id DESC`
    );

    return NextResponse.json(result.rows);
  } catch (error) {
    console.error("GET connections error:", error);
    return NextResponse.json(
      { error: "Failed to load connections." },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await createConnectionsTable();

    const { name, host, port, type, username, password } =
      await request.json();

    if (!name || !host || !port || !type || !username || !password) {
      return NextResponse.json(
        { error: "All fields are required." },
        { status: 400 }
      );
    }

    const result = await pool.query(
      `INSERT INTO connections (name, host, port, type, username, password)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, host, port, type, username`,
      [name, host, Number(port), type, username, password]
    );

    return NextResponse.json(result.rows[0], { status: 201 });
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

    const { id, name, host, port, type, username, password } =
      await request.json();

    if (!id || !name || !host || !port || !type || !username || !password) {
      return NextResponse.json(
        { error: "All fields are required." },
        { status: 400 }
      );
    }

    const result = await pool.query(
      `UPDATE connections
       SET name = $1,
           host = $2,
           port = $3,
           type = $4,
           username = $5,
           password = $6
       WHERE id = $7
       RETURNING id, name, host, port, type, username`,
      [name, host, Number(port), type, username, password, id]
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

    const { id } = await request.json();

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