import { NextResponse } from "next/server";
import pool from "../../../../lib/db";

export async function GET() {
  try {
    const result = await pool.query(
      "SELECT id, script_name, version, sql_content, description, created_at FROM scripts ORDER BY created_at DESC"
    );
    return NextResponse.json({ scripts: result.rows });
  } catch (error: any) {
    console.error("List error:", error.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}