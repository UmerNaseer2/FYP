import { NextResponse } from "next/server";
import pool from "@/lib/version-db";

export async function GET() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_comparisons (
        id SERIAL PRIMARY KEY,
        schema_a TEXT NOT NULL,
        schema_b TEXT NOT NULL,
        compared_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const connectionsResult = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM connections
    `);

    const compareResult = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM schema_comparisons
    `);

    return NextResponse.json({
      totalConnections: connectionsResult.rows[0]?.total ?? 0,
      activeConnections: connectionsResult.rows[0]?.total ?? 0,
      comparedSchemas: compareResult.rows[0]?.total ?? 0,
      pendingScripts: 0,
      systemStatus: "Online",
      updatedAt: new Date().toLocaleString(),
    });
  } catch (error) {
    console.error("Dashboard API error:", error);

    return NextResponse.json({
      totalConnections: 0,
      activeConnections: 0,
      comparedSchemas: 0,
      pendingScripts: 0,
      systemStatus: "Database Error",
      updatedAt: new Date().toLocaleString(),
    });
  }
}