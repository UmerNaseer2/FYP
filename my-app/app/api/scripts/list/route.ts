import { NextResponse } from 'next/server';
import { auth } from "@/auth";
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await pool.query(
      'SELECT id, script_name, version, sql_content, description, created_at FROM scripts ORDER BY created_at DESC'
    );
    return NextResponse.json({ scripts: result.rows });
  } catch (error: any) {
    console.error('List error:', error.message);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}