// POST /api/github/push: save one version of a script family to the GitHub
// script registry.
//
// Layout (unchanged): <database>/<schema>/<script_name>/v<version>.sql at the
// repository root, with its rollback beside it as v<version>.down.sql. Each
// <script_name>/ folder is the project diagram's "folder of versions"; the
// database and schema levels exist because Deploy scopes the registry by them.
//
// Two modes:
//   normal  publish a NEW version: the migration file, then its rollback.
//   attach  (attach_rollback: true) add a rollback to a version that is already
//           saved and has none, or has one that runs nothing. A rollback that
//           has statements never changes once saved.
//
// Why the migration is written FIRST (it used to be the rollback): GitHub's
// contents API saves one file per call, with no transaction across calls.
// Every write here is create-only (no sha), so GitHub itself refuses to
// overwrite a file that exists; correctness no longer rests on a pre-check.
// In this order the worst half-way result is a saved version with no
// rollback: visible in the registry (rollback_state "none"), refused for undo
// by Deploy with a reason, and fixable with attach mode. The old order could
// leave a rollback with no migration, which a later push of the same version
// then silently picked up as its rollback.
//
// This route FAILS CLOSED on purpose, unlike the pull route: when GitHub
// can't be read, nothing is written. Deciding "the family is empty" because a
// read failed is exactly how a version below an existing one got published,
// and how a saved rollback got overwritten.
//
// Request JSON, normal mode:
//   { database_name, schema_name, script_name, version, change_level,
//     sql_content, down_sql?, description? }
// Request JSON, attach mode:
//   { attach_rollback: true, database_name, schema_name, script_name, version, down_sql }
//
// Responses. Every error is { ok: false, code, error } with a readable error:
//   200 { ok: true, url, version, paths: { migration, rollback }, rollback_saved,
//         rollback_error?, rollback_error_code? }
//       rollback_error_code: rollback_outcome_unknown | rollback_exists | rollback_failed
//       (rollback_exists: someone else's rollback is there, so a retry cannot help)
//   400 invalid_input                           nothing was sent to GitHub
//   404 version_missing                         attach: that version is not saved
//   409 version_exists | version_not_newer      also carry highest_version and suggested
//   409 push_in_progress | github_conflict | not_a_folder | rollback_exists
//   500 github_unconfigured
//   502 token_rejected | github_forbidden | github_rate_limited | repo_not_found |
//       github_down | github_error | github_unreachable | outcome_unknown
import { NextRequest, NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth-guard";
import { stampChangeType, type ScriptChangeType } from "@/lib/change-type";
import {
  contentsFileUrl,
  decodeContentsFile,
  GITHUB_UNCONFIGURED_CODE,
  githubConfig,
  githubFetch,
  githubNotConfiguredMessage,
  listFamilyFiles,
  logGitHubAnswer,
  type FamilyListing,
  type GitHubConfig,
} from "@/lib/github-registry";
import { migrationFileName, parseRegistryFileName, rollbackFileName } from "@/lib/registry-paths";
import {
  attachRollbackKind,
  CHANGE_LEVEL_REQUIRED,
  checkPushVersion,
  describeGitHubFailure,
  familyPathProblem,
  familyVersions,
  findVersionFiles,
  githubErrorCode,
  MIGRATION_NO_STATEMENTS,
  normalizePushVersion,
  pushCommitMessage,
  readChangeLevel,
  ROLLBACK_COMMENTS_ONLY,
  rollbackCommitMessage,
  rollbackFileState,
  type PushIdentity,
  type RegistryEntry,
} from "@/lib/registry-push";
import { bumpVersion, levelToBump } from "@/lib/script-status";
import { containsTransactionControl, hasExecutableSql } from "@/lib/sql-guard";

// The state every refusal ends on, so the user always knows GitHub is untouched.
const NOTHING_SAVED = "Nothing was saved to GitHub.";

// A description becomes the commit body; past this it is a document, not a note.
const MAX_DESCRIPTION_LENGTH = 1000;

// The statements containsTransactionControl refuses, named the way the Script
// Editor names them.
const TRANSACTION_WORDS = "COMMIT, ROLLBACK, ABORT, a standalone END or PREPARE TRANSACTION";

/** Which version of which family a request is about. */
type Family = { database: string; schema: string; scriptName: string; version: string };

type NormalPush = Family & {
  mode: "normal";
  level: ScriptChangeType;
  sql: string;
  /** The rollback to save beside it, or null for none. */
  downSql: string | null;
  description: string | null;
};

type AttachPush = Family & { mode: "attach"; downSql: string };

function fail(status: number, code: string, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ok: false, code, error, ...extra }, { status });
}

function invalid(problem: string): NextResponse {
  return fail(400, "invalid_input", `${problem} ${NOTHING_SAVED}`);
}

// The contents API takes file content as base64.
function toBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

// The path as people read it, e.g. "db/public/orders_fix/v1.2.0.sql".
function registryPath(family: Family, fileName: string): string {
  return `${family.database}/${family.schema}/${family.scriptName}/${fileName}`;
}

function identityOf(family: Family): PushIdentity {
  return { database: family.database, schema: family.schema, scriptName: family.scriptName, version: family.version };
}

// The saved file's page on GitHub, from a successful PUT. Best effort: the
// file is saved either way, so an odd answer only loses the link.
async function htmlUrlOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { content?: { html_url?: unknown } };
    return typeof body.content?.html_url === "string" ? body.content.html_url : null;
  } catch {
    return null;
  }
}

/**
 * Check the whole request before GitHub is contacted, so a bad request can
 * never cause a write. Returns the problem in plain words, or the push.
 */
function readInput(raw: unknown): NormalPush | AttachPush | { problem: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { problem: "The request must be a JSON object." };
  }
  const body = raw as Record<string, unknown>;

  // The names become folders in GitHub, so they are checked first: no "/",
  // "..", invisible characters, stray spaces or over-long names.
  const pathProblem = familyPathProblem(body.database_name, body.schema_name, body.script_name);
  if (pathProblem) return { problem: pathProblem };

  // One spelling per version: "v1.2" is stored as 1.2.0, and "1.0.0.down" or
  // "latest" are refused, because they would make a file the registry misreads.
  const normalized = normalizePushVersion(body.version);
  if ("error" in normalized) return { problem: normalized.error };
  const family: Family = {
    database: body.database_name as string,
    schema: body.schema_name as string,
    scriptName: body.script_name as string,
    version: normalized.version,
  };

  // The rollback. Absent, null or only whitespace all mean "no rollback". Text
  // that runs nothing (comments only) is refused rather than saved: it would
  // run as an empty query and report "Rolled back" while nothing changed.
  if (body.down_sql !== undefined && body.down_sql !== null && typeof body.down_sql !== "string") {
    return { problem: "The rollback was sent, but not as text." };
  }
  const downSql = typeof body.down_sql === "string" && body.down_sql.trim() !== "" ? body.down_sql : null;
  const attach = body.attach_rollback === true;
  if (downSql !== null) {
    if (!hasExecutableSql(downSql)) {
      return {
        problem: attach
          ? `This rollback contains only comments, so it would undo nothing. Write the statements that undo v${family.version}.`
          : ROLLBACK_COMMENTS_ONLY,
      };
    }
    if (containsTransactionControl(downSql)) {
      return {
        problem: `The rollback opens or closes its own transaction (${TRANSACTION_WORDS}). Deploy runs every rollback inside a transaction of its own, so remove that statement and try again.`,
      };
    }
  }

  if (attach) {
    if (downSql === null) {
      return { problem: `Write the rollback to add to v${family.version} of "${family.scriptName}".` };
    }
    return { ...family, mode: "attach", downSql };
  }

  // The level the author chose travels with the file (its "-- Change-type:"
  // line), so it is required and must be exactly one of the three.
  const level = readChangeLevel(body.change_level);
  if (!level) return { problem: CHANGE_LEVEL_REQUIRED };

  if (typeof body.sql_content !== "string") {
    return { problem: "The migration SQL is missing, or was not sent as text." };
  }
  if (!hasExecutableSql(body.sql_content)) {
    return { problem: MIGRATION_NO_STATEMENTS };
  }
  // Apply and revert refuse these later; refusing them now means a version
  // that can never be deployed is never published.
  if (containsTransactionControl(body.sql_content)) {
    return {
      problem: `The migration opens or closes its own transaction (${TRANSACTION_WORDS}). Deploy runs every script inside a transaction of its own, so remove that statement and push again.`,
    };
  }

  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
    return { problem: "The description was sent, but not as text." };
  }
  const description = typeof body.description === "string" ? body.description : null;
  if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      problem: `The description is ${description.length} characters long. Keep it to ${MAX_DESCRIPTION_LENGTH} characters or fewer.`,
    };
  }

  return { ...family, mode: "normal", level, sql: body.sql_content, downSql, description };
}

// The family folder could not be listed. Nothing has been written.
function listingFailed(listing: Extract<FamilyListing, { ok: false }>, family: Family): NextResponse {
  if (listing.code === "not_a_folder") {
    // Not GitHub failing: the repository holds a FILE where this family's
    // folder of versions should be.
    return fail(409, listing.code, `${listing.error} Or push this script under a different name. ${NOTHING_SAVED}`);
  }
  return fail(
    502,
    listing.code,
    `Could not check which versions of "${family.scriptName}" are already in GitHub, so nothing was saved: ` +
      `pushing without that check could publish a version below one that already exists. ${listing.error}`,
  );
}

// Another save of this same version is happening right now.
function pushInProgress(family: Family): NextResponse {
  return fail(
    409,
    "push_in_progress",
    `Someone else is saving v${family.version} of "${family.scriptName}" right now. Wait a moment, reload the registry, then try again. ${NOTHING_SAVED}`,
  );
}

// Attach mode: the version already has a rollback that runs something.
function rollbackExists(family: Family, justNow: boolean): NextResponse {
  return fail(
    409,
    "rollback_exists",
    justNow
      ? `A rollback for v${family.version} of "${family.scriptName}" was added by someone else a moment ago, so yours was not saved. Check it in the Script Editor.`
      : `v${family.version} of "${family.scriptName}" already has a rollback with statements. A saved rollback never changes, so yours was not saved.`,
  );
}

/** Normal mode: publish a new version, migration first, then its rollback. */
async function pushNewVersion(config: GitHubConfig, input: NormalPush, files: RegistryEntry[]): Promise<NextResponse> {
  const { version, scriptName, level } = input;
  const identity = identityOf(input);

  // 1. The version rule: new, and strictly above every version the family
  //    has published. Deploy runs a family's versions in order, so a lower
  //    number would never be offered to a database that is past it. Both
  //    refusals name the family's highest version and the number to use.
  const { published } = familyVersions(files);
  const verdict = checkPushVersion(published, version, scriptName, level);
  if (!verdict.ok) {
    return fail(409, verdict.code, `${verdict.error} ${NOTHING_SAVED}`, {
      highest_version: verdict.highest,
      suggested: verdict.suggested,
    });
  }

  // 2. A rollback file for this version with no migration beside it was left
  //    by an earlier save that failed half-way (the old rollback-first order).
  //    Remove it first, by the exact sha that was listed, so it can never end
  //    up beside the new migration as a rollback nobody wrote for it. A sha
  //    that no longer matches means someone else is saving this version.
  const { down: leftover } = findVersionFiles(files, version);
  if (leftover) {
    const leftoverUrl = contentsFileUrl(config, input.database, input.schema, scriptName, leftover.name);
    const res = await githubFetch(config, leftoverUrl, {
      method: "DELETE",
      body: { message: rollbackCommitMessage("remove_leftover", identity), sha: leftover.sha },
    });
    if (!res) {
      return fail(
        502,
        "github_unreachable",
        `The connection to GitHub dropped while removing ${leftover.name}, a rollback left by an earlier failed save. ${NOTHING_SAVED} Try again in a moment.`,
      );
    }
    // 404 means someone already removed it, which is the state wanted.
    if (!res.ok && res.status !== 404) {
      await logGitHubAnswer("remove leftover rollback", res);
      if (res.status === 409 || res.status === 422) return pushInProgress(input);
      return fail(
        502,
        githubErrorCode(res.status),
        `${describeGitHubFailure(res.status, `remove ${leftover.name}, a rollback left by an earlier failed save`)} ${NOTHING_SAVED}`,
      );
    }
  }

  // 3. The migration, create-only: with no sha, GitHub refuses (422) to
  //    replace a file that is already there. Its "-- Change-type:" line is
  //    set to the author's level, replacing any stale generator or hand-typed
  //    line, so Deploy reads back exactly the level chosen here.
  const migrationName = migrationFileName(version);
  const migrationUrl = contentsFileUrl(config, input.database, input.schema, scriptName, migrationName);
  const upRes = await githubFetch(config, migrationUrl, {
    method: "PUT",
    body: {
      message: pushCommitMessage({ ...identity, description: input.description, level }),
      content: toBase64(stampChangeType(input.sql, level)),
    },
  });
  if (!upRes) {
    // The request may have reached GitHub before the connection dropped, so
    // "try again" could meet a version that was in fact saved.
    return fail(
      502,
      "outcome_unknown",
      `The connection to GitHub dropped while saving v${version} of "${scriptName}", so it is not known whether it was saved. Reload the registry to check before trying again.` +
        (input.downSql !== null
          ? ` If v${version} is listed, it was saved without its rollback, which can be added in the Script Editor.`
          : ""),
    );
  }
  if (upRes.status === 422) {
    // Usually the file appeared since the listing: someone else saved this
    // version a moment ago. Look, rather than guess from the status alone.
    await logGitHubAnswer("save migration", upRes);
    const check = await githubFetch(config, migrationUrl);
    if (check?.ok) {
      const suggested = bumpVersion(version, levelToBump(level));
      return fail(
        409,
        "version_exists",
        `Someone else published v${version} of "${scriptName}" a moment ago. Nothing of yours was published — pick the next version (v${suggested}) and push again.`,
        { highest_version: version, suggested },
      );
    }
    return fail(
      502,
      "github_error",
      `GitHub refused to save v${version} of "${scriptName}" (status 422). ${NOTHING_SAVED} Try again; if it keeps happening, ask whoever runs the server to check the GitHub settings.`,
    );
  }
  if (!upRes.ok) {
    await logGitHubAnswer("save migration", upRes);
    // 409: the branch moved under concurrent commits. A refusal, so a retry is safe.
    return fail(
      upRes.status === 409 ? 409 : 502,
      githubErrorCode(upRes.status),
      `${describeGitHubFailure(upRes.status, `save v${version} of "${scriptName}"`)} ${NOTHING_SAVED}`,
    );
  }
  const url = await htmlUrlOf(upRes);

  // 4. The rollback, also create-only. The version is saved whatever happens
  //    here, so the answer stays 200 and says plainly what became of the
  //    rollback; paths.rollback is set only when it was saved.
  const rollbackName = rollbackFileName(version);
  let rollbackSaved = false;
  let rollbackError: string | null = null;
  // Which of the three rollback failures it was, for screens that offer a
  // retry: "rollback_exists" means someone else's rollback is already there,
  // and a saved rollback never changes, so a retry could only be refused.
  let rollbackErrorCode: "rollback_outcome_unknown" | "rollback_exists" | "rollback_failed" | null = null;
  if (input.downSql !== null) {
    const downRes = await githubFetch(
      config,
      contentsFileUrl(config, input.database, input.schema, scriptName, rollbackName),
      { method: "PUT", body: { message: rollbackCommitMessage("rollback", identity), content: toBase64(input.downSql) } },
    );
    if (!downRes) {
      rollbackErrorCode = "rollback_outcome_unknown";
      rollbackError = `v${version} was saved, but the connection to GitHub dropped while saving its rollback, so it is not known whether the rollback was saved. Reload the registry to check; if v${version} shows no rollback, save the rollback again.`;
    } else if (downRes.ok) {
      rollbackSaved = true;
    } else {
      await logGitHubAnswer("save rollback", downRes);
      rollbackErrorCode = downRes.status === 422 ? "rollback_exists" : "rollback_failed";
      rollbackError =
        downRes.status === 422
          ? `A rollback for v${version} was added by someone else a moment ago, so yours was not saved. Check it in the Script Editor.`
          : `v${version} was saved, but its rollback was not: ${describeGitHubFailure(downRes.status, `save the rollback for v${version}`)} The version itself is safe — retry saving the rollback.`;
    }
  }

  return NextResponse.json({
    ok: true,
    url,
    version,
    paths: {
      migration: registryPath(input, migrationName),
      rollback: rollbackSaved ? registryPath(input, rollbackName) : null,
    },
    rollback_saved: rollbackSaved,
    ...(rollbackError ? { rollback_error: rollbackError, rollback_error_code: rollbackErrorCode } : {}),
  });
}

/**
 * Attach mode: add a rollback to a version that is already saved. Allowed
 * only when it has no rollback, or has one that runs nothing; a rollback with
 * statements was reviewed with its version and never changes.
 */
async function attachRollback(config: GitHubConfig, input: AttachPush, files: RegistryEntry[]): Promise<NextResponse> {
  const { version, scriptName } = input;
  const identity = identityOf(input);

  const { up, down } = findVersionFiles(files, version);
  if (!up) {
    return fail(
      404,
      "version_missing",
      `v${version} of "${scriptName}" is not in the registry, so there is nothing to attach a rollback to. Check the version, or push the migration first. ${NOTHING_SAVED}`,
    );
  }

  // The rollback goes beside its migration under the SAME spelling of the
  // version (an old v1.0.sql gets v1.0.down.sql): the pull route pairs the
  // two files by name, so another spelling would never be read as its rollback.
  // findVersionFiles returns `down` only when it is spelled that way, so a
  // v1.0.0.down.sql beside v1.0.sql is neither read nor replaced here: it is
  // not this version's rollback, and v1.0.down.sql is added instead.
  const upVersion = parseRegistryFileName(up.name)?.version ?? version;
  const rollbackName = down ? down.name : rollbackFileName(upVersion);
  const rollbackUrl = contentsFileUrl(config, input.database, input.schema, scriptName, rollbackName);

  // A rollback file is there: read it, and replace it only if it runs nothing.
  let kind: "add_missing" | "replace_empty" = "add_missing";
  let sha: string | null = null;
  if (down) {
    const res = await githubFetch(config, rollbackUrl);
    if (!res) {
      return fail(
        502,
        "github_unreachable",
        `The server could not reach GitHub to read the rollback already saved for v${version}. ${NOTHING_SAVED} Check that the server can reach api.github.com, then try again.`,
      );
    }
    // Listed a moment ago and gone now: someone else is changing it.
    if (res.status === 404) return pushInProgress(input);
    if (!res.ok) {
      await logGitHubAnswer("read rollback", res);
      return fail(
        502,
        githubErrorCode(res.status),
        `${describeGitHubFailure(res.status, `read the rollback already saved for v${version}`)} ${NOTHING_SAVED}`,
      );
    }
    const file = decodeContentsFile(await res.json().catch(() => null));
    if (!file) {
      return fail(
        502,
        "github_error",
        `The rollback already saved for v${version} could not be read (GitHub does not send files over 1 MB this way), so it was left as it is. ${NOTHING_SAVED}`,
      );
    }
    const allowed = attachRollbackKind(rollbackFileState(file.text));
    if (allowed === null) return rollbackExists(input, false);
    kind = allowed;
    sha = file.sha;
  }

  // Replacing sends the sha that was just read, so GitHub refuses (409) if
  // the file changed since; adding sends none, so GitHub refuses (422) if a
  // rollback appeared since.
  const res = await githubFetch(config, rollbackUrl, {
    method: "PUT",
    body: {
      message: rollbackCommitMessage(kind, identity),
      content: toBase64(input.downSql),
      ...(sha ? { sha } : {}),
    },
  });
  if (!res) {
    return fail(
      502,
      "outcome_unknown",
      `The connection to GitHub dropped while adding the rollback to v${version} of "${scriptName}", so it is not known whether it was saved. Reload the registry to check before trying again.`,
    );
  }
  if (!res.ok) {
    await logGitHubAnswer("attach rollback", res);
    if (sha && (res.status === 409 || res.status === 422)) return pushInProgress(input);
    if (!sha && res.status === 422) {
      const check = await githubFetch(config, rollbackUrl);
      if (check?.ok) return rollbackExists(input, true);
      return fail(
        502,
        "github_error",
        `GitHub refused to save the rollback for v${version} of "${scriptName}" (status 422). ${NOTHING_SAVED} Try again; if it keeps happening, ask whoever runs the server to check the GitHub settings.`,
      );
    }
    return fail(
      res.status === 409 ? 409 : 502,
      githubErrorCode(res.status),
      `${describeGitHubFailure(res.status, `add a rollback to v${version} of "${scriptName}"`)} ${NOTHING_SAVED}`,
    );
  }

  return NextResponse.json({
    ok: true,
    url: await htmlUrlOf(res),
    version,
    paths: { migration: registryPath(input, up.name), rollback: registryPath(input, rollbackName) },
    rollback_saved: true,
  });
}

export async function POST(req: NextRequest) {
  // 1. Only editors write to the registry.
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  // 2. The GitHub settings, read now rather than when the module loads, so a
  //    changed setting is picked up (and a test can fake it). The message
  //    names missing keys, never values.
  const config = githubConfig();
  if (!config.ok) {
    return fail(500, GITHUB_UNCONFIGURED_CODE, githubNotConfiguredMessage(config.missing));
  }

  // 3. The whole request is checked before GitHub is contacted.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return invalid("The request was not valid JSON.");
  }
  const input = readInput(raw);
  if ("problem" in input) return invalid(input.problem);

  // 4. What the family folder already holds: one listing (it stops at 1000
  //    entries, far more than one family has). When it can't be read, stop:
  //    see "fails closed" at the top.
  const listing = await listFamilyFiles(config, input.database, input.schema, input.scriptName);
  if (!listing.ok) return listingFailed(listing, input);

  return input.mode === "attach"
    ? attachRollback(config, input, listing.files)
    : pushNewVersion(config, input, listing.files);
}
