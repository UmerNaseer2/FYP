// Recording an applied version in the GitHub script registry, after the fact.
//
// Spec feature 07: "Automatically push approved scripts to GitHub."
//
// The Script Editor's Save button and the Workbench's Push button already send
// a script to GitHub in one action, so a script somebody wrote in this app is
// in the registry from the moment it is accepted. What was missing is the
// other direction: a version can reach a database WITHOUT ever reaching the
// registry, and then nothing in GitHub says it happened. Two ways that occurs
// today, both through /api/scripts/apply:
//
//   • Version Sync replays a version from one database's ledger onto another.
//     The SQL comes from the Source's script_patch row, not from GitHub, and
//     the registry is keyed by <database>/<schema>/<script>, so the Target's
//     folder never gets a file for it.
//   • Anything else that posts SQL to the apply route without a registry file
//     behind it.
//
// Deploy already shows the result — "Applied — no registry file" — which is
// exactly the database-versus-registry drift the feature exists to stop. This
// module closes it: after a run commits, every version it applied is written
// to the registry if the registry has no file for it.
//
// WHY THIS IS NOT the push route's pushNewVersion, which writes the same two
// files. They are different operations wearing similar clothes:
//
//   push route   proposes a NEW version. It picks a number, refuses one that
//                is not above the family's highest, deletes a leftover
//                rollback, and fails closed with a refusal the author reads
//                and acts on. Nothing has happened yet, so refusing costs
//                nothing.
//   this module  records a version that HAS ALREADY RUN. There is no number to
//                pick and no refusal worth making — the migration is in the
//                database whatever GitHub says — so its only two answers are
//                "written" and "not written, here is why", and neither one may
//                fail the deploy that called it.
//
// Folding those into one function would mean a mode flag threaded through a
// hundred and fifty lines of refusal text that only one caller can act on. So
// the sequence of calls is written twice, deliberately, while everything that
// could DISAGREE between them — the file names, the Change-type stamp, the
// commit message — is imported from the same place both use.

import { stampChangeType, type ScriptChangeType } from "@/lib/change-type";
import {
  contentsFileUrl,
  githubConfig,
  githubFetch,
  listFamilyFiles,
  logGitHubAnswer,
  type GitHubConfig,
} from "@/lib/github-registry";
import { migrationFileName, rollbackFileName } from "@/lib/registry-paths";
import type { ArchivedVersion } from "@/lib/registry-report";
import {
  describeGitHubFailure,
  findVersionFiles,
  pushCommitMessage,
  rollbackCommitMessage,
  type RegistryEntry,
} from "@/lib/registry-push";

/** One applied version, as the apply route holds it after the run. */
export type AppliedVersion = {
  scriptName: string;
  version: string;
  sql: string;
  /** The rollback that was stored with it, or null when it has none. */
  downSql: string | null;
  changeType: ScriptChangeType;
  /** The version's own words, for the commit body. Null when it had none. */
  description: string | null;
};

// The answer's shape lives in lib/registry-report, with the reader the screens
// use, so a page can read what this writes without importing a module that
// carries a GitHub token. Re-exported because the apply route wants both
// halves and should not have to know there are two files.
export type { ArchivedVersion } from "@/lib/registry-report";

function pathOf(database: string, schema: string, scriptName: string, fileName: string): string {
  return `${database}/${schema}/${scriptName}/${fileName}`;
}

/**
 * Write one version's files, having already established the registry has none
 * for it.
 *
 * Create-only (a PUT with no sha), so GitHub itself refuses to overwrite a
 * file that appeared since the listing. That refusal is a 422, and it is read
 * here as "already saved" rather than as a failure: two servers archiving the
 * same replayed version is a race with a correct outcome, not an error worth
 * showing anybody.
 */
async function writeVersion(
  config: GitHubConfig,
  database: string,
  schema: string,
  applied: AppliedVersion,
): Promise<ArchivedVersion> {
  const { scriptName, version } = applied;
  const identity = { database, schema, scriptName, version };
  const answer = (rest: Partial<ArchivedVersion>): ArchivedVersion => ({
    script_name: scriptName,
    version,
    status: "not-saved",
    path: null,
    reason: null,
    rollback_saved: false,
    ...rest,
  });

  const migrationName = migrationFileName(version);
  const upRes = await githubFetch(
    config,
    contentsFileUrl(config, database, schema, scriptName, migrationName),
    {
      method: "PUT",
      body: {
        message: pushCommitMessage({
          ...identity,
          description: applied.description,
          level: applied.changeType,
        }),
        // Stamped with the level the ledger stored, so a file archived from a
        // replay reads back at the same level Deploy ran it at. Without this
        // the Target's copy could be pulled later as "unknown" and re-run
        // through a louder set of warnings than the original needed.
        content: toBase64(stampChangeType(applied.sql, applied.changeType)),
      },
    },
  );

  if (!upRes) {
    return answer({
      reason:
        `The connection to GitHub dropped while recording v${version} of "${scriptName}", so ` +
        `it is not known whether the file was written. The migration itself is applied and safe.`,
    });
  }
  if (upRes.status === 422) {
    return answer({
      status: "already-saved",
      path: pathOf(database, schema, scriptName, migrationName),
    });
  }
  if (!upRes.ok) {
    await logGitHubAnswer("archive an applied version", upRes);
    return answer({
      reason:
        `${describeGitHubFailure(upRes.status, `record v${version} of "${scriptName}" in the registry`)} ` +
        `The migration itself is applied and safe.`,
    });
  }

  // The rollback, if the ledger kept one. Best-effort on top of best-effort:
  // the version is recorded whatever happens here, and a version in the
  // registry with no rollback beside it is a state every reader already
  // understands (Deploy refuses to undo it and says why).
  let rollbackSaved = false;
  if (applied.downSql !== null) {
    const downRes = await githubFetch(
      config,
      contentsFileUrl(config, database, schema, scriptName, rollbackFileName(version)),
      {
        method: "PUT",
        body: {
          message: rollbackCommitMessage("rollback", identity),
          content: toBase64(applied.downSql),
        },
      },
    );
    if (downRes?.ok) rollbackSaved = true;
    else if (downRes) await logGitHubAnswer("archive an applied rollback", downRes);
  }

  return answer({
    status: "saved",
    path: pathOf(database, schema, scriptName, migrationName),
    rollback_saved: rollbackSaved,
  });
}

/** Base64 for the Contents API. Buffer, not btoa: this only ever runs on the server. */
function toBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Record every version a committed run applied, skipping the ones the registry
 * already has.
 *
 * Returns null when GitHub is not configured — there is no registry to fall
 * behind, so nothing was attempted and nothing is worth reporting. Otherwise
 * one entry per version, in the order they ran.
 *
 * NEVER THROWS, and never reports a problem the caller must handle. Every
 * caller reaches this after COMMIT: the database has already changed, and a
 * registry that could not be written is a bookkeeping gap to tell the user
 * about, not a reason to turn a successful deploy into a failure.
 *
 * Fails closed on a listing it could not read, per family. The alternative is
 * writing because the check failed, which is how a create-only PUT turns into
 * a 422 on every deploy and the log fills with refusals about files that were
 * always there.
 */
export async function archiveAppliedVersions(input: {
  database: string;
  schema: string;
  versions: ReadonlyArray<AppliedVersion>;
}): Promise<ArchivedVersion[] | null> {
  const config = githubConfig();
  if (!config.ok) return null;
  if (input.versions.length === 0) return [];

  const { database, schema } = input;
  // One listing per FAMILY, not per version: a run of five versions of one
  // script is one folder, and re-reading it five times would be five GitHub
  // calls to answer the same question. Read once, then track what this loop
  // itself adds, so the second version of a family is not checked against a
  // listing taken before the first one was written.
  const listings = new Map<string, RegistryEntry[] | null>();
  const results: ArchivedVersion[] = [];

  for (const applied of input.versions) {
    const { scriptName, version } = applied;

    if (!listings.has(scriptName)) {
      const listing = await listFamilyFiles(config, database, schema, scriptName);
      listings.set(scriptName, listing.ok ? [...listing.files] : null);
      if (!listing.ok) {
        console.error(`Registry archive — could not list "${scriptName}": ${listing.error}`);
      }
    }
    const files = listings.get(scriptName) ?? null;

    if (files === null) {
      results.push({
        script_name: scriptName,
        version,
        status: "not-saved",
        path: null,
        reason:
          `The registry folder for "${scriptName}" could not be read, so v${version} was not ` +
          `recorded there. The migration itself is applied and safe — save it from the Script ` +
          `Editor once GitHub is reachable.`,
        rollback_saved: false,
      });
      continue;
    }

    const existing = findVersionFiles(files, version);
    if (existing.up) {
      results.push({
        script_name: scriptName,
        version,
        status: "already-saved",
        path: pathOf(database, schema, scriptName, existing.up.name),
        reason: null,
        rollback_saved: existing.down !== null,
      });
      continue;
    }

    let written: ArchivedVersion;
    try {
      written = await writeVersion(config, database, schema, applied);
    } catch (error) {
      // githubFetch already turns a network failure into null rather than a
      // throw, so reaching here means something unforeseen. It still may not
      // reach the caller: see the contract above.
      console.error(`Registry archive — v${version} of "${scriptName}" threw:`, error);
      written = {
        script_name: scriptName,
        version,
        status: "not-saved",
        path: null,
        reason:
          `v${version} of "${scriptName}" could not be recorded in the registry. The migration ` +
          `itself is applied and safe.`,
        rollback_saved: false,
      };
    }

    // Whatever happened, this version is no longer absent from the folder as
    // far as the next version of the same family is concerned — and if it is
    // (the write failed), the next version's own check is against a name that
    // is still missing, which is the truth.
    if (written.status !== "not-saved") {
      files.push({ name: migrationFileName(version), sha: "", type: "file" });
      if (written.rollback_saved) {
        files.push({ name: rollbackFileName(version), sha: "", type: "file" });
      }
    }
    results.push(written);
  }

  return results;
}
