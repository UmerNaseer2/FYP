import { NextRequest, NextResponse } from "next/server";
import pool, { ensureConnectionsTable } from "@/lib/version-db";

// The connections table shape is owned by lib/version-db (ensureConnectionsTable)
// so every reader/writer agrees on its columns, including `ssl`.
const createConnectionsTable = ensureConnectionsTable;

export async function GET() {
  try {
    await createConnectionsTable();

    // Never send secrets to the browser. The password and the connection_string
    // (which embeds the password for URI connections) stay server-side; the UI
    // only needs to know *whether* a connection string is stored, via the
    // has_connection_string flag.
    const result = await pool.query(`
      SELECT id, name, host, port, database_name, type, username,
             (connection_string IS NOT NULL AND connection_string <> '') AS has_connection_string,
             ssl
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
    // Number("") is 0 and Number("abc") is NaN — neither is a valid port, so
    // fall back to 5432 for any non-positive/invalid value.
    const port = Number(body.port) || 5432;
    const database_name = String(body.database_name ?? "postgres").trim();
    const type = String(body.type ?? "PostgreSQL").trim();
    const username = String(body.username ?? "postgres").trim();
    const password = String(body.password ?? "").trim();
    const connection_string = String(body.connection_string ?? "").trim();
    const ssl = Boolean(body.ssl);

    // A connection needs a name plus *some* credential: either a full
    // connection string, or a password for the loose host/user fields.
    if (!name || (!connection_string && !password)) {
      return NextResponse.json(
        { error: "Add a name and either a connection string or a password." },
        { status: 400 }
      );
    }

    const result = await pool.query(
      `
      INSERT INTO connections
      (name, host, port, database_name, type, username, password, connection_string, ssl)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, name, host, port, database_name, type, username,
                (connection_string IS NOT NULL AND connection_string <> '') AS has_connection_string,
                ssl
      `,
      [name, host, port, database_name, type, username, password, connection_string || null, ssl]
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
    // Number("") is 0 and Number("abc") is NaN — neither is a valid port, so
    // fall back to 5432 for any non-positive/invalid value.
    const port = Number(body.port) || 5432;
    const database_name = String(body.database_name ?? "postgres").trim();
    const type = String(body.type ?? "PostgreSQL").trim();
    const username = String(body.username ?? "postgres").trim();
    // Blank password on edit means "keep the stored one" (we never show it).
    const password = String(body.password ?? "").trim();
    // Keep-if-blank rule for the connection string: the browser never receives
    // it back (it embeds the password), so a blank value normally means "leave
    // the stored connection string untouched", not "clear it".
    const connection_string = String(body.connection_string ?? "").trim();
    // …EXCEPT when the editor switched to Fields mode: there the user is
    // redefining the target by loose host/port/user fields, so any stored URI
    // must be cleared — otherwise the old URI would still win over the fields.
    const clearConnectionString = Boolean(body.clear_connection_string);
    const ssl = Boolean(body.ssl);

    if (!id || !name) {
      return NextResponse.json(
        { error: "A connection id and name are required." },
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
          password = CASE WHEN $7 = '' THEN password ELSE $7 END,
          connection_string = CASE
            WHEN $8 THEN NULL
            WHEN $9 = '' THEN connection_string
            ELSE $9
          END,
          ssl = $10
      WHERE id = $11
      RETURNING id, name, host, port, database_name, type, username,
                (connection_string IS NOT NULL AND connection_string <> '') AS has_connection_string,
                ssl
      `,
      [name, host, port, database_name, type, username, password, clearConnectionString, connection_string, ssl, id]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }

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
