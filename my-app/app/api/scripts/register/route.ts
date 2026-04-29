import { NextRequest, NextResponse } from "next/server";
import pool from "../../../../lib/db";

export async function POST(request: NextRequest) {
  try {
    const { script_name, version, sql_content, description } = await request.json();

    if (!script_name || !version || !sql_content) {
      return NextResponse.json(
        { error: "script_name, version, and sql_content are required." },
        { status: 400 }
      );
    }

    const result = await pool.query(
      `SELECT * FROM register_script($1, $2, $3, $4)`,
      [script_name, version, sql_content, description || null]
    );

    const newScript = result.rows[0];
    return NextResponse.json({ success: true, script: newScript }, { status: 201 });
  } catch (error: any) {
    console.error("Register error:", error.message);
    if (
      error.message.includes("already exists") ||
      error.message.includes("cannot be empty")
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}