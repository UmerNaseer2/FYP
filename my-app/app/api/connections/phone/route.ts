import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { toEnvironment } from "@/lib/environments";
import pool, { syncMetadataTables } from "@/lib/version-db";

/**
 * GET /api/connections/phone
 *
 * The saved connections a paired phone may pick from. The desktop app's phone
 * link calls this when a phone asks for the list (connections.list in
 * desktop/src/shared/remote/rpc.ts), then keeps only the connections its owner
 * shared with phones.
 *
 * It answers with what Compare's pickers show and nothing more: the number,
 * the name, the environment and the database's name. Never the host, the user
 * name or the password, which GET /api/connections sends the Connections
 * screen. Only PostgreSQL connections, in the order Compare lists them,
 * because those are the ones a comparison or a schema read can use.
 *
 * It asks for either box a phone uses the list for: Compare, to compare, and
 * Visualizer, to read a schema. GET /api/connections leaves Compare out on
 * purpose, because it answers with the hosts.
 */
export async function GET() {
  const gate = await requirePermission("compare:read", "visualizer:read");
  if (!gate.ok) return gate.response;

  try {
    // Shared DDL (lib/version-db) guarantees the `environment` column exists.
    await syncMetadataTables();
    const result = await pool.query(`
      SELECT id, name, database_name, environment
      FROM connections
      WHERE type = 'PostgreSQL'
      ORDER BY name ASC
    `);

    return NextResponse.json({
      connections: result.rows.map((row) => ({
        // A bigint id arrives from pg as a string of digits.
        id: Number(row.id),
        name: row.name,
        environment: toEnvironment(row.environment),
        database: row.database_name,
      })),
    });
  } catch (error) {
    // Logged here, on the computer. The phone only hears that it failed.
    console.error("GET connections/phone error:", error);
    return NextResponse.json(
      {
        error:
          "Could not read the saved connections. If this keeps happening, check that the app's database is running.",
      },
      { status: 500 }
    );
  }
}
