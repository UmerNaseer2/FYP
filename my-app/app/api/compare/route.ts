import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { runComparison, type CompareScreen } from "@/lib/compare-run";

// Re-exported so the screen can name the shape it renders without importing
// the module that computes it — that one opens database connections.
export type { CompareScreen };

/**
 * POST /api/compare  { query, record? }
 *
 * `query` is the Compare screen's own query string, verbatim. The selection
 * lives in the URL so a comparison stays shareable and reloadable, and sending
 * it back untouched means one piece of code decides what "?targetConnection=3
 * &targetConnection=7" means rather than two that could drift apart.
 *
 * POST rather than GET even though this mostly reads: it can write. `record`
 * stamps the open saved set's "last run" time and stores what each pair was
 * found to differ by, and the screen only sets it when somebody actually
 * pressed Compare or opened the set. As a GET this used to count a run every
 * time the page was reloaded or the link was shared.
 */
export async function POST(request: NextRequest) {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  let body: { query?: string; record?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body." }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query : "";

  try {
    const screen = await runComparison(
      new URLSearchParams(query),
      // actorFor rather than the email: with the auth bypass on, every request
      // carries the same configured address, and writing it into the history
      // would name a person who may never have opened this app.
      body.record === true ? { ranBy: actorFor(gate.principal) } : null,
    );
    return NextResponse.json(screen);
  } catch (error) {
    // A target that cannot be reached is reported inside the payload, so
    // getting here means the run itself broke — usually the metadata store.
    console.error("POST compare error:", error);
    return NextResponse.json(
      {
        error:
          "Could not run this comparison. If this keeps happening, check that the app's database is running.",
      },
      { status: 500 }
    );
  }
}
