// GET /api/github/family?database=<db>&schema=<schema>&script=<script_name>
//
// The versions of ONE script family already published in the GitHub
// registry, and the highest of them. The Migration Workbench on Compare calls
// it so the number it offers is bumped from the family's real highest
// version: the same floor the push route checks against. One folder listing,
// instead of the whole registry /api/github/pull downloads.
//
// Fails closed like the push guard: when GitHub can't be read the answer is a
// readable 502, never an empty list, because an empty list would make the
// screen offer v1.0.0 for a family that already has versions.
//
// Responses:
//   200 { ok: true, versions: string[], highest: string | null }
//   400 { ok: false, error }            a missing or unusable database, schema or script
//   500 { ok: false, code: "github_unconfigured", error }   (the same code as push and pull)
//   502 { ok: false, code, error }      GitHub could not be read
import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import {
  familyVersions,
  GITHUB_UNCONFIGURED_CODE,
  githubConfig,
  githubNotConfiguredMessage,
  listFamilyFiles,
} from "@/lib/github-registry";
import { familyPathProblem } from "@/lib/registry-push";
import { highestVersion } from "@/lib/script-status";

export async function GET(request: NextRequest) {
  // Reading the family is harmless, so any signed-in viewer may do it, the
  // same as the pull route.
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  const params = request.nextUrl.searchParams;
  const database = params.get("database");
  const schema = params.get("schema");
  const script = params.get("script");

  // The same name rules the push route applies, so a family this route
  // accepts is one that can actually be pushed. A missing parameter reads as
  // a missing name.
  const problem = familyPathProblem(database, schema, script);
  if (problem || database === null || schema === null || script === null) {
    return NextResponse.json(
      { ok: false, error: `${problem ?? "The database, schema and script name are all needed."} Nothing was read from GitHub.` },
      { status: 400 },
    );
  }

  const config = githubConfig();
  if (!config.ok) {
    return NextResponse.json(
      { ok: false, code: GITHUB_UNCONFIGURED_CODE, error: githubNotConfiguredMessage(config.missing) },
      { status: 500 },
    );
  }

  const listing = await listFamilyFiles(config, database, schema, script);
  if (!listing.ok) {
    const statusNote = listing.status > 0 ? ` (status ${listing.status})` : "";
    return NextResponse.json(
      {
        ok: false,
        code: listing.code,
        error: `Could not read the versions of "${script}" from GitHub${statusNote}. The next version can't be worked out until it can. ${listing.error}`,
      },
      { status: 502 },
    );
  }

  const { published } = familyVersions(listing.files);
  return NextResponse.json({ ok: true, versions: published, highest: highestVersion(published) });
}
