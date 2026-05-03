import { NextResponse } from "next/server";
import pool from "../../../../lib/db";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function GET() {
  try {
    const result = await pool.query(
      "SELECT id, script_name, version, sql_content, description, created_at FROM scripts ORDER BY created_at DESC"
    );
    return NextResponse.json({ scripts: result.rows });
  } catch (error: unknown) {
    console.error("List error:", errorMessage(error));
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
