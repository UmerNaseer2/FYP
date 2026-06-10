import { NextRequest, NextResponse } from 'next/server';
import { auth } from "@/auth";
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function POST(request: NextRequest) {
  // Check if user is logged in
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  
  // Only admin can register scripts
  if (session.user.role !== 'admin') {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { script_name, version, sql_content, description } = body;

    if (!script_name || !version || !sql_content) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const result = await pool.query(
      `INSERT INTO scripts (script_name, version, sql_content, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, script_name, version, sql_content, description, created_at`,
      [script_name, version, sql_content, description || null]
    );

    return NextResponse.json({ success: true, script: result.rows[0] });
  } catch (error: any) {
    console.error('Register error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Failed to register script' },
      { status: 500 }
    );
  }
}