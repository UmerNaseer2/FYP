import { NextRequest, NextResponse } from 'next/server';
import { auth } from "@/auth";
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
// GET - Fetch all users
export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  
  // Use role from session (no database query!)
  if (session.user.role !== 'admin') {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  
  const result = await pool.query(
    'SELECT id, email, role FROM profiles ORDER BY email'
  );
  
  return NextResponse.json({ users: result.rows });
}

// PUT - Update user role
export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  
  if (session.user.role !== 'admin') {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  
  const { userId, role } = await request.json();
  console.log("Updating user", userId, "to role", role)
  await pool.query(
    'UPDATE profiles SET role = $1 WHERE id = $2',
    [role, userId]
  );
  
  return NextResponse.json({ success: true });
}

// DELETE - Delete a user
export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  
  if (session.user.role !== 'admin') {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  
  const { userId } = await request.json();
  
  await pool.query('DELETE FROM profiles WHERE id = $1', [userId]);
  
  return NextResponse.json({ success: true });
}