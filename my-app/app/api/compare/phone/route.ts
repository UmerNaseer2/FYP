import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { runComparison } from "@/lib/compare-run";
import {
  phoneCompareQuery,
  readPhoneCompareRequest,
  summarizeForPhone,
} from "@/lib/phone-compare";

/**
 * Why the saved sets are left out. runComparison reads them only to list them
 * on the screen, and a phone asks for one comparison by its parts.
 */
const NO_SETS = "Saved comparison sets are not sent to a phone.";

/**
 * POST /api/compare/phone  { source: { connectionId, schema }, targets: [...] }
 *
 * The desktop app's phone link calls this when a paired phone asks for a
 * comparison (compare.run in desktop/src/shared/remote/rpc.ts). It runs the
 * same runComparison as the Compare screen, and answers with the summary in
 * lib/phone-compare.ts: no SQL, no connection details, and nothing a database
 * server said.
 *
 * Nothing is written. The run is not added to the comparison history, because
 * a phone checking on a schema is not a run somebody reviewed, and the saved
 * sets are not read, because they need a permission of their own and a phone
 * does not show them. The previous run is still read, so the answer can say
 * what changed since.
 *
 * POST, like /api/compare, so the request is a JSON body the desktop app
 * writes rather than a query string.
 */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("compare:read");
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body." }, { status: 400 });
  }

  const read = readPhoneCompareRequest(body);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });

  try {
    const screen = await runComparison(phoneCompareQuery(read.data), null, NO_SETS);
    if (screen.kind === "no-connections") {
      return NextResponse.json(
        { error: "There are no saved connections on the computer." },
        { status: 404 }
      );
    }
    return NextResponse.json(summarizeForPhone(screen));
  } catch (error) {
    // A target that cannot be reached is reported inside the summary, so
    // getting here means the run itself broke, usually the metadata store.
    console.error("POST compare/phone error:", error);
    return NextResponse.json(
      {
        error:
          "Could not run this comparison. If this keeps happening, check that the app's database is running.",
      },
      { status: 500 }
    );
  }
}
