// POST /api/github/retire: retire one saved version of a script family, so
// Deploy stops offering it.
//
// Why: Deploy runs a family's versions in order. When one version fails on a
// database (its SQL does not fit that database), every version after it waits
// behind it, and there was no way past it short of deleting files in GitHub
// by hand.
//
// What it does: it adds one file beside the version, v<version>.retired.md
// (lib/github/registry-paths.ts), a short note that says what retiring means
// and how to undo it. Nothing else changes:
//   - the migration and its rollback stay in the folder, so the number stays
//     taken and a database that already ran the version can still roll it back;
//   - Deploy and Quick run stop offering the version to any database, so the
//     versions after it can run;
//   - deleting the note in GitHub brings the version back.
// Older copies of the app skip the note, since it is not a .sql file.
//
// Retiring is about what Deploy offers. The apply route runs the SQL it is
// sent and does not read GitHub, the same as for the order of versions.
//
// Like the push route this FAILS CLOSED: when the family folder can't be read,
// nothing is written. The write is create-only (no sha), so two people
// retiring the same version at once both end with it retired, and no other
// file is ever replaced. A missing repository is not made here: there is
// nothing in it to retire.
//
// Request JSON: { database_name, schema_name, script_name, version, reason? }
//
// Responses. Every error is { ok: false, code, error } with a readable error:
//   200 { ok: true, already: false, version, path, url }   the note was added
//   200 { ok: true, already: true, version, path }          it was retired already
//   400 invalid_input                                       nothing was sent to GitHub
//   404 version_missing                                     no such version in the folder
//   409 github_conflict | not_a_folder
//   500 github_unconfigured
//   503 github_settings_unavailable                         the organization's settings could not be read
//   502 token_rejected | github_forbidden | github_rate_limited | repo_not_found |
//       github_down | github_error | github_unreachable | outcome_unknown
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guard";
import { githubConfigFor } from "@/lib/github/config";
import {
  contentsFileUrl,
  githubFetch,
  listFamilyFiles,
  logGitHubAnswer,
  type FamilyListing,
} from "@/lib/github/registry";
import {
  familyFolderPath,
  parseRegistryFileName,
  registryRoot,
  reservedFolderProblem,
  retiredMarkerName,
} from "@/lib/github/registry-paths";
import {
  describeGitHubFailure,
  familyPathProblem,
  findRetiredNote,
  findVersionFiles,
  githubErrorCode,
  readRetireReason,
  readRetireVersion,
  retireCommitMessage,
  retiredMarkerText,
  type PushIdentity,
} from "@/lib/github/registry-push";

// The state every refusal ends on, so the user always knows GitHub is untouched.
const NOTHING_SAVED = "Nothing was changed in GitHub.";

/** What to retire. `root` is the caller's organization's folder in the registry ("" for the default one). */
type RetireInput = {
  root: string;
  database: string;
  schema: string;
  scriptName: string;
  version: string;
  reason: string | null;
};

function fail(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ ok: false, code, error }, { status });
}

function invalid(problem: string): NextResponse {
  return fail(400, "invalid_input", `${problem} ${NOTHING_SAVED}`);
}

// The contents API takes file content as base64.
function toBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

// The path as people read it, e.g. "db/public/orders_fix/v1.2.0.retired.md".
function registryPath(input: RetireInput, fileName: string): string {
  return `${familyFolderPath(input.root, input.database, input.schema, input.scriptName)}/${fileName}`;
}

// The saved file's page on GitHub, from a successful PUT. Best effort: the
// note is saved either way, so an odd answer only loses the link.
async function htmlUrlOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { content?: { html_url?: unknown } };
    return typeof body.content?.html_url === "string" ? body.content.html_url : null;
  } catch {
    return null;
  }
}

/** Check the whole request before GitHub is contacted, so a bad request can never cause a write. */
function readInput(raw: unknown, root: string): RetireInput | { problem: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { problem: "The request must be a JSON object." };
  }
  const body = raw as Record<string, unknown>;

  // The same checks as a push: the names become folders in GitHub, and must
  // not point into another organization's folder.
  const pathProblem = familyPathProblem(body.database_name, body.schema_name, body.script_name);
  if (pathProblem) return { problem: pathProblem };
  const reserved = reservedFolderProblem(root, body.database_name as string, body.schema_name as string);
  if (reserved) return { problem: reserved };

  const version = readRetireVersion(body.version);
  if ("error" in version) return { problem: version.error };
  const reason = readRetireReason(body.reason);
  if ("error" in reason) return { problem: reason.error };

  return {
    root,
    database: body.database_name as string,
    schema: body.schema_name as string,
    scriptName: body.script_name as string,
    version: version.version,
    reason: reason.reason,
  };
}

// The family folder could not be listed. Nothing has been written.
function listingFailed(listing: Extract<FamilyListing, { ok: false }>, input: RetireInput): NextResponse {
  if (listing.code === "not_a_folder") {
    return fail(409, listing.code, `${listing.error} ${NOTHING_SAVED}`);
  }
  return fail(
    502,
    listing.code,
    `Could not read the versions of "${input.scriptName}" in GitHub, so nothing was retired. ${listing.error}`,
  );
}

export async function POST(req: NextRequest) {
  // 1. Retiring changes what Deploy offers every database, so it has its own
  //    permission, which only Admin has out of the box.
  const gate = await requirePermission("scripts:delete");
  if (!gate.ok) return gate.response;

  // 2. The organization's GitHub settings, read now so a changed setting is
  //    picked up. The message names missing keys, never values or the token.
  const config = await githubConfigFor(gate.principal);
  if (!config.ok) return fail(config.status, config.code, config.message);

  // 3. The whole request is checked before GitHub is contacted.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return invalid("The request was not valid JSON.");
  }
  const input = readInput(raw, registryRoot(gate.principal));
  if ("problem" in input) return invalid(input.problem);

  // 4. What the family folder holds. When it can't be read, stop.
  const listing = await listFamilyFiles(config, input.root, input.database, input.schema, input.scriptName);
  if (!listing.ok) return listingFailed(listing, input);

  // 5. Only a version the folder really has can be retired.
  const { up } = findVersionFiles(listing.files, input.version);
  if (!up) {
    return fail(
      404,
      "version_missing",
      `v${input.version} of "${input.scriptName}" is not in the registry, so there is nothing to retire. Reload the page and check the version. ${NOTHING_SAVED}`,
    );
  }

  // The note goes beside its migration under the SAME spelling of the version
  // (an old v1.0.sql gets v1.0.retired.md), as a rollback does.
  const version = parseRegistryFileName(up.name)?.version ?? input.version;
  const noteName = retiredMarkerName(version);
  const path = registryPath(input, noteName);

  // 6. Retired already: say so, and change nothing. The path is the note's
  //    own, which may spell the version differently (v1.0.0.retired.md
  //    beside v1.0.sql).
  const existing = findRetiredNote(listing.files, version);
  if (existing) {
    return NextResponse.json({ ok: true, already: true, version, path: registryPath(input, existing.name) });
  }

  // 7. The note, create-only: with no sha, GitHub refuses (422) to replace a
  //    file that is already there.
  const identity: PushIdentity = {
    database: input.database,
    schema: input.schema,
    scriptName: input.scriptName,
    version,
  };
  const noteUrl = contentsFileUrl(config, input.root, input.database, input.schema, input.scriptName, noteName);
  const res = await githubFetch(config, noteUrl, {
    method: "PUT",
    body: {
      message: retireCommitMessage(identity, input.reason),
      content: toBase64(retiredMarkerText(identity, input.reason, new Date())),
    },
  });
  if (!res) {
    return fail(
      502,
      "outcome_unknown",
      `The connection to GitHub dropped while retiring v${version} of "${input.scriptName}", so it is not known whether it was retired. Try again: if it was, you will be told so.`,
    );
  }
  if (res.status === 422) {
    // Usually someone else retired it a moment ago. Look, rather than guess.
    await logGitHubAnswer("retire version", res);
    const check = await githubFetch(config, noteUrl);
    if (check?.ok) return NextResponse.json({ ok: true, already: true, version, path });
    return fail(
      502,
      "github_error",
      `GitHub refused to save the note that retires v${version} of "${input.scriptName}" (status 422). ${NOTHING_SAVED} Try again; if it keeps happening, ask an admin to check the GitHub settings on the Admin screen.`,
    );
  }
  if (!res.ok) {
    await logGitHubAnswer("retire version", res);
    // 409: the branch moved under concurrent commits. A refusal, so a retry is safe.
    return fail(
      res.status === 409 ? 409 : 502,
      githubErrorCode(res.status),
      `${describeGitHubFailure(res.status, `retire v${version} of "${input.scriptName}"`)} ${NOTHING_SAVED}`,
    );
  }

  return NextResponse.json({ ok: true, already: false, version, path, url: await htmlUrlOf(res) });
}
