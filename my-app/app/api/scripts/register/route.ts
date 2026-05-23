import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // Log that the API was called
    console.log('API /api/scripts/list was called');
    
    // Dynamic import to avoid build issues
    const { Pool } = await import('pg');
    
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_URL_A;
    console.log('Connection string exists:', !!connectionString);
    
    const pool = new Pool({
      connectionString: connectionString,
    });

    // Test connection first
    await pool.query('SELECT 1');
    console.log('Database connected successfully');

    const result = await pool.query(`
      SELECT id, script_name, version, sql_content, description, created_at
      FROM scripts
      ORDER BY script_name, created_at DESC
    `);
    
    await pool.end();
    
    return NextResponse.json({ scripts: result.rows });
  } catch (error: any) {
    console.error('Full error:', error);
    // Return the actual error message
    return NextResponse.json(
      { error: error.message || 'Failed to fetch scripts' },
      { status: 500 }
    );
  }
}