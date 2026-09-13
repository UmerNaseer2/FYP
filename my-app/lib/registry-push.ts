// The PURE rules for publishing a script family to the GitHub registry.
//
// Every rule that both push screens (the Migration Workbench on Compare and
// the Script Editor) and the push route must agree on lives here, once: what a
// version must look like and where it may land, which names may be used in the
// registry path, what the files are called, what the commits say, and how a
// rollback file is classed.
//
// Nothing here fetches or reads the environment, and nothing needs Node (no
// Buffer, no crypto), because the two screens import this file in the browser.
// The GitHub reads that apply these rules live in lib/github-registry.ts,
// which is server-only.
import type { ScriptChangeType } from "./change-type";
import { migrationFileName, parseRegistryFileName, rollbackFileName } from "./registry-paths";
import {
  bumpVersion,
  checkNewVersion,
  compareVersions,
  highestVersion,
  levelOfStep,
  levelToBump,
  looksLikeVersion,
  normalizeVersion,
  type BumpLevel,
} from "./script-status";
import { containsTransactionControl, hasExecutableSql } from "./sql-guard";

// ── Names in the registry path ──────────────────────────────────────────────

/** PostgreSQL cuts names at 63 bytes, so a longer database or schema name cannot exist. */
export const MAX_IDENTIFIER_BYTES = 63;

/** script_patch.script_name is VARCHAR(150): a longer name would publish, then fail at Deploy. */
export const MAX_SCRIPT_NAME_LENGTH = 150;

/** The allowed-characters rule, word for word the same on both screens and in the route. */
export const SCRIPT_NAME_RULE = "Script names can use letters, digits, _ and - only.";

const SCRIPT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,150}$/;

// A loop over character codes rather than a regex: it reads plainly, and the
// lint rule against control characters inside a regex stays happy. Codes 0-31
// are tabs, line breaks and other invisible controls; 127 is DEL.
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Check one database or schema name before it becomes a folder in the
 * registry path <database>/<schema>/<script>/. Returns the problem in plain
 * words, or null when the name is fine. `label` is the word the copy uses,
 * e.g. "database" or "schema".
 *
 * Why each rule: an invisible control character cannot be checked by eye; a
 * leading or trailing space makes a folder that looks like another one but is
 * not; "." and ".." are folder steps, not names; a "/" or "\" would split one
 * name into two folders; and a name over PostgreSQL's 63-byte limit cannot
 * belong to a real database or schema. The value is never echoed back, so an
 * odd or huge input cannot garble the message.
 */
export function validateRegistrySegment(
  label: string,
  value: unknown,
  maxBytes: number = MAX_IDENTIFIER_BYTES,
): string | null {
  if (typeof value !== "string" || value === "") {
    return `The ${label} name is missing. Choose the ${label} this script is for and try again.`;
  }
  if (hasControlCharacter(value)) {
    return `The ${label} name contains an invisible character such as a tab or a line break. Retype the name and try again.`;
  }
  if (value.trim() !== value) {
    return `The ${label} name starts or ends with a space. Remove the space and try again.`;
  }
  if (value === "." || value === "..") {
    return `The ${label} name can't be "." or "..": GitHub reads those as folder steps, not names.`;
  }
  if (value.includes("/") || value.includes("\\")) {
    return `The ${label} name contains "/" or "\\". Those split a name into folders in GitHub, so they can't be part of one.`;
  }
  // Bytes, not characters: PostgreSQL's limit is in bytes, and an accented
  // letter takes two. TextEncoder works in the browser and on the server alike.
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > maxBytes) {
    return `The ${label} name is ${bytes} bytes long, but PostgreSQL names stop at ${maxBytes} bytes, so no ${label} can have it. Check the name and try again.`;
  }
  return null;
}

/**
 * Check a script (family) name: letters, digits, _ and - only, 1 to 150
 * characters. Returns the problem in plain words, or null when it is fine.
 */
export function validateScriptName(value: unknown): string | null {
  if (typeof value !== "string" || value === "") {
    return `Give the script a name. ${SCRIPT_NAME_RULE}`;
  }
  if (value.length > MAX_SCRIPT_NAME_LENGTH) {
    return `The script name is ${value.length} characters long, and Deploy can record at most ${MAX_SCRIPT_NAME_LENGTH}. Shorten it and try again.`;
  }
  if (!SCRIPT_NAME_PATTERN.test(value)) {
    return `This script name can't be used. ${SCRIPT_NAME_RULE} Replace spaces and other characters with _ or -.`;
  }
  return null;
}

/** The first problem with a family's whole path (database, schema, script name), or null. */
export function familyPathProblem(database: unknown, schema: unknown, scriptName: unknown): string | null {
  return (
    validateRegistrySegment("database", database) ??
    validateRegistrySegment("schema", schema) ??
    validateScriptName(scriptName)
  );
}

// ── Versions ────────────────────────────────────────────────────────────────

/** The hint every version error starts with, on both screens and in the route. */
export const VERSION_FORMAT_HINT = "Use a version like 1.4.0 (major.minor.patch).";

// One to three parts of 1 to 9 digits each. Nine digits keeps every part a
// safe whole number; three parts is what Deploy's ordering reads.
const PUSH_VERSION_PATTERN = /^\d{1,9}(\.\d{1,9}){0,2}$/;

/**
 * Turn a typed version into the one spelling the registry stores: "X.Y.Z".
 * "v1.2" becomes "1.2.0" and " 2 " becomes "2.0.0".
 *
 * Why so strict: "1.2" and "1.2.0" are the same version to Deploy, so storing
 * both spellings would make two files for one version; "1.0.0.down" would
 * make a file the registry reads as a ROLLBACK; and a doubled "v" would make
 * "vv1.2.sql". Only digits with up to three parts get through.
 */
export function normalizePushVersion(raw: unknown): { version: string } | { error: string } {
  if (typeof raw !== "string") {
    return { error: `${VERSION_FORMAT_HINT} The version was missing or was not text.` };
  }
  const trimmed = raw.trim();
  if (trimmed === "") return { error: `${VERSION_FORMAT_HINT} The version was empty.` };
  const bare = trimmed.replace(/^v/i, "");
  const version = PUSH_VERSION_PATTERN.test(bare) ? normalizeVersion(bare) : null;
  if (!version) {
    // Echo what was typed, cut short so a pasted script can't flood the message.
    const shown = trimmed.length > 40 ? `${trimmed.slice(0, 40)}...` : trimmed;
    return { error: `${VERSION_FORMAT_HINT} Got "${shown}".` };
  }
  return { version };
}

/** One entry of a GitHub folder listing: only the fields the rules use. */
export type RegistryEntry = { name: string; sha: string; type?: string };

/** A file already in the registry, with the sha GitHub needs to replace or delete it. */
export type RegistryFileRef = { name: string; sha: string };

// Read a listing entry as a registry file, or null when it isn't one: a
// folder, a README, or a .sql file whose name doesn't start with a version.
// An entry with no `type` is taken to be a file (callers that already
// filtered can pass plain {name, sha}).
function readEntry(entry: RegistryEntry): { version: string; isDown: boolean } | null {
  if (entry.type !== undefined && entry.type !== "file") return null;
  const parsed = parseRegistryFileName(entry.name);
  if (!parsed || !looksLikeVersion(parsed.version)) return null;
  return parsed;
}

/**
 * Find one version's files in a family folder listing.
 *   - up:      its migration file, or null
 *   - down:    its rollback file, or null (with no `up`, a leftover from an
 *              earlier save that failed half-way)
 *   - highest: the highest version among the MIGRATION files, as written
 *              ("2.0"), so a leftover rollback never raises the floor
 * Versions match with compareVersions, so an existing v1.0.sql blocks 1.0.0.
 */
export function findVersionFiles(
  entries: ReadonlyArray<RegistryEntry>,
  version: string,
): { up: RegistryFileRef | null; down: RegistryFileRef | null; highest: string | null } {
  let up: RegistryFileRef | null = null;
  let down: RegistryFileRef | null = null;
  const migrations: string[] = [];
  for (const entry of entries) {
    const file = readEntry(entry);
    if (!file) continue;
    if (!file.isDown) migrations.push(file.version);
    if (compareVersions(file.version, version) !== 0) continue;
    const ref = { name: entry.name, sha: entry.sha };
    if (file.isDown) down = down ?? ref;
    else up = up ?? ref;
  }
  return { up, down, highest: highestVersion(migrations) };
}

/** What a family folder holds, read by familyVersions. */
export type FamilyVersions = {
  /** Every version with a migration file, as written, lowest first. */
  published: string[];
  /**
   * Rollback files with no migration beside them, keyed by the version in
   * X.Y.Z form, holding the file's sha. Left by an earlier save that failed
   * half-way; such a version is NOT published.
   */
  orphanRollbacks: Record<string, string>;
};

/**
 * Split a family folder listing into its published versions and any leftover
 * rollback files. A version counts as published only when its migration file
 * is there: a v1.1.0.down.sql on its own does not make 1.1.0 taken.
 */
export function familyVersions(files: ReadonlyArray<RegistryEntry>): FamilyVersions {
  const published: string[] = [];
  const rollbacks: { version: string; sha: string }[] = [];
  for (const entry of files) {
    const file = readEntry(entry);
    if (!file) continue;
    if (file.isDown) rollbacks.push({ version: file.version, sha: entry.sha });
    else published.push(file.version);
  }
  published.sort(compareVersions);

  const orphanRollbacks: Record<string, string> = {};
  for (const rollback of rollbacks) {
    const hasMigration = published.some((version) => compareVersions(version, rollback.version) === 0);
    if (hasMigration) continue;
    orphanRollbacks[normalizeVersion(rollback.version) ?? rollback.version] = rollback.sha;
  }
  return { published, orphanRollbacks };
}

/** The version guard's answer. Both refusals carry the family's highest version and the number to use. */
export type PushVersionVerdict =
  | { ok: true; highest: string | null }
  | {
      ok: false;
      code: "version_exists" | "version_not_newer";
      highest: string | null;
      suggested: string;
      error: string;
    };

/**
 * Is `version` (already normalised) a new number strictly above every version
 * the family has published? When it is not, `error` says so in plain words
 * and names the number to push instead: the family's highest version bumped
 * at the script's change level.
 *
 * Why strictly above: Deploy runs a family's versions in order, so a version
 * below the highest sorts before scripts already published and is never
 * offered to a database that has reached them.
 */
export function checkPushVersion(
  published: ReadonlyArray<string>,
  version: string,
  scriptName: string,
  level: ScriptChangeType,
): PushVersionVerdict {
  const check = checkNewVersion(published, version);
  if (check.status === "ok") return { ok: true, highest: check.highest };

  const suggested = bumpVersion(check.highest, levelToBump(level));
  if (check.status === "exists") {
    return {
      ok: false,
      code: "version_exists",
      highest: check.highest,
      suggested,
      error: `v${version} of "${scriptName}" is already in GitHub. Published versions never change — push this as v${suggested} instead.`,
    };
  }
  return {
    ok: false,
    code: "version_not_newer",
    highest: check.highest,
    suggested,
    error:
      `v${version} is lower than v${check.highest}, the newest version of "${scriptName}" in GitHub. ` +
      `A lower number sorts before scripts that are already published, so Deploy would never offer it ` +
      `to a database that has reached v${check.highest}. Push it as v${suggested}.`,
  };
}

// ── The change level sent with a push ───────────────────────────────────────

/** The three levels a push may carry, loudest first. */
export const CHANGE_LEVELS: ReadonlyArray<ScriptChangeType> = ["breaking", "additive", "patch"];

/** Shown when a push arrives without one of the three levels. */
export const CHANGE_LEVEL_REQUIRED =
  "Choose whether this change is breaking, additive or a patch before pushing — it decides the version number and how Deploy treats the script.";

/**
 * The change level a push carries, or null when it is not exactly one of the
 * three. Strict on purpose: the level is written into the file's
 * "-- Change-type:" line and Deploy trusts that line, so a guess from loose
 * text ("major", "Breaking!") must never land in the registry.
 */
export function readChangeLevel(value: unknown): ScriptChangeType | null {
  return typeof value === "string" && (CHANGE_LEVELS as ReadonlyArray<string>).includes(value)
    ? (value as ScriptChangeType)
    : null;
}

// ── The rollback choice ─────────────────────────────────────────────────────

/** Shown when the rollback box holds only comments. */
export const ROLLBACK_COMMENTS_ONLY =
  "This rollback contains only comments, so it would undo nothing. Write the statements that undo the migration, or tick Save without a rollback.";

/** Shown when the rollback box is empty and the box is not ticked. */
export const ROLLBACK_MISSING =
  "Write a rollback, or tick Save without a rollback. Without one, Deploy cannot undo this version.";

/** Shown when there is a real rollback AND the no-rollback box is ticked. */
export const ROLLBACK_AND_NO_ROLLBACK =
  "You wrote a rollback and also ticked Save without a rollback. Untick the box to save the rollback with this version, or clear the rollback.";

/**
 * Why a push is blocked by its rollback choice, or null when the choice is
 * clear. The one source of this copy for both push screens.
 *
 * Saving without a rollback has to be a conscious choice (the tick), because
 * a version with no rollback can't be undone from Deploy. A comment-only
 * rollback is not a rollback: it runs as an empty query and changes nothing.
 */
export function rollbackChoiceProblem(
  rollbackSql: string | null | undefined,
  saveWithoutRollback: boolean,
): string | null {
  const text = rollbackSql ?? "";
  const runs = hasExecutableSql(text);
  if (runs) return saveWithoutRollback ? ROLLBACK_AND_NO_ROLLBACK : null;
  if (saveWithoutRollback) return null;
  return text.trim() === "" ? ROLLBACK_MISSING : ROLLBACK_COMMENTS_ONLY;
}

/**
 * The rollback to send with a push: the text when it has statements that run
 * and the no-rollback box is not ticked, otherwise undefined (no down_sql).
 */
export function rollbackToSend(
  rollbackSql: string | null | undefined,
  saveWithoutRollback: boolean,
): string | undefined {
  if (saveWithoutRollback) return undefined;
  return typeof rollbackSql === "string" && hasExecutableSql(rollbackSql) ? rollbackSql : undefined;
}

/**
 * What a rollback file in GitHub holds:
 *   - "none":           there is no file (null or undefined text)
 *   - "no_statements":  a file with nothing that runs (blank or comments only)
 *   - "has_statements": a real rollback
 */
export type RollbackFileState = "none" | "no_statements" | "has_statements";

export function rollbackFileState(text: string | null | undefined): RollbackFileState {
  if (text === null || text === undefined) return "none";
  return hasExecutableSql(text) ? "has_statements" : "no_statements";
}

/**
 * Whether a rollback may be added to a version that is already saved, and
 * which commit that is: "add_missing" when there is no rollback file,
 * "replace_empty" when the file runs nothing. Null means refuse: a rollback
 * that has statements never changes once saved, so a reviewed rollback can't
 * be swapped afterwards.
 */
export function attachRollbackKind(state: RollbackFileState): "add_missing" | "replace_empty" | null {
  if (state === "none") return "add_missing";
  if (state === "no_statements") return "replace_empty";
  return null;
}

/**
 * How a version's rollback reads after a registry pull:
 *   - "none":                no rollback file
 *   - "usable":              a rollback Deploy can run
 *   - "no_statements":       a file that runs nothing (blank or comments only)
 *   - "transaction_control": it opens or closes its own transaction, which the
 *                            revert route refuses
 *   - "unreadable":          there is a file, but it could not be downloaded
 * Only "usable" is offered for rollback; the others say why not.
 */
export type PulledRollbackState = "none" | "usable" | "no_statements" | "transaction_control" | "unreadable";

/**
 * Class a pulled rollback. `text` is the file's text, or null when the family
 * has no rollback file for the version; `unreadable` is true when a file is
 * there but its download failed.
 */
export function pulledRollbackState(text: string | null, unreadable = false): PulledRollbackState {
  if (unreadable) return "unreadable";
  if (text === null) return "none";
  // hasExecutableSql is the one "does this run anything?" test, so a blank
  // file and a comments-only file both land here.
  if (!hasExecutableSql(text)) return "no_statements";
  return containsTransactionControl(text) ? "transaction_control" : "usable";
}

// ── Commit messages ─────────────────────────────────────────────────────────

/** Which script version a commit is about. */
export type PushIdentity = { database: string; schema: string; scriptName: string; version: string };

const SUBJECT_MAX = 72;
const BODY_MAX = 1000;

// "db/public/orders_fix v1.2.0": database and schema are in every subject, so
// two families with the same name in different schemas read differently in
// the repository's history.
function identityLine(identity: PushIdentity): string {
  return `${identity.database}/${identity.schema}/${identity.scriptName} v${identity.version}`;
}

/**
 * The commit message for a migration file: a subject line of at most 72
 * characters, then a blank line and the full description (up to 1000
 * characters) when the subject could not show all of it.
 *
 * The subject is the identity plus the first non-blank line of the
 * description, cut with "..." to fit. The identity itself is never cut, so a
 * subject can pass 72 characters only when the names alone do.
 *
 * `level`, when given, follows the version in brackets
 * ("db/public/orders_fix v2.0.0 (breaking): ..."), so the repository history
 * shows the level the author chose next to the number it produced.
 */
export function pushCommitMessage(
  input: PushIdentity & { description?: string | null; level?: ScriptChangeType | null },
): string {
  const identity = input.level ? `${identityLine(input)} (${input.level})` : identityLine(input);
  const description = (input.description ?? "").trim();
  const firstLine =
    description
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";

  let subject = identity;
  if (firstLine) {
    const full = `${identity}: ${firstLine}`;
    // Room left for the description after "<identity>: " and the "...".
    const room = SUBJECT_MAX - identity.length - 2 - 3;
    if (full.length <= SUBJECT_MAX) subject = full;
    else if (room > 0) subject = `${identity}: ${firstLine.slice(0, room).trimEnd()}...`;
  }

  const subjectShowsAll = subject === `${identity}: ${description}` || description === "";
  if (subjectShowsAll) return subject;
  const body = description.length > BODY_MAX ? `${description.slice(0, BODY_MAX - 3)}...` : description;
  return `${subject}\n\n${body}`;
}

/** The kinds of rollback commit, each with its own subject ending. */
export type RollbackCommitKind = "rollback" | "add_missing" | "replace_empty" | "remove_leftover";

const ROLLBACK_COMMIT_ENDINGS: Record<RollbackCommitKind, string> = {
  rollback: "rollback",
  add_missing: "add missing rollback",
  replace_empty: "replace empty rollback",
  remove_leftover: "remove leftover rollback from an earlier failed save",
};

/** The commit message for a rollback file, e.g. "db/public/orders_fix v1.2.0: add missing rollback". */
export function rollbackCommitMessage(kind: RollbackCommitKind, identity: PushIdentity): string {
  return `${identityLine(identity)}: ${ROLLBACK_COMMIT_ENDINGS[kind]}`;
}

// ── GitHub failures in plain words ──────────────────────────────────────────

/** A short, stable code for each kind of GitHub failure, so a screen never matches on copy. */
export type GitHubErrorCode =
  | "token_rejected"
  | "github_forbidden"
  | "github_rate_limited"
  | "repo_not_found"
  | "github_conflict"
  | "github_down"
  | "github_error";

export function githubErrorCode(status: number): GitHubErrorCode {
  if (status === 401) return "token_rejected";
  if (status === 403) return "github_forbidden";
  if (status === 429) return "github_rate_limited";
  if (status === 404) return "repo_not_found";
  if (status === 409 || status === 422) return "github_conflict";
  if (status >= 500 && status <= 599) return "github_down";
  return "github_error";
}

/**
 * What a GitHub error status means, in words an IT person can act on.
 * `action` finishes the sentence "while trying to ...", for example
 * 'save v1.2.0 of "orders_fix"'. The caller adds what state things are in
 * now (for example "Nothing was published."). Only env key NAMES appear
 * here, never their values, and GitHub's raw response body is never shown.
 */
export function describeGitHubFailure(status: number, action: string): string {
  if (status === 401) {
    return `GitHub did not accept the server's access token while trying to ${action}; it may have expired or been revoked. Ask whoever runs the server to replace GITHUB_PAT, then try again.`;
  }
  if (status === 403) {
    return `GitHub refused to let the server ${action}: the access token has no permission for the registry repository, or the server has used up its GitHub requests for now. Wait a few minutes and try again; if it keeps happening, ask whoever runs the server to check the token's access.`;
  }
  if (status === 429) {
    return `GitHub is limiting how many requests the server can make, so it could not ${action}. Wait a minute and try again.`;
  }
  if (status === 404) {
    return `GitHub could not find the registry repository while trying to ${action}, or the access token cannot see it. Ask whoever runs the server to check GITHUB_REPO_OWNER and GITHUB_REPO_NAME, and that GITHUB_PAT has access to that repository.`;
  }
  if (status === 409 || status === 422) {
    return `The registry repository changed while the server was trying to ${action}: someone else saved a file there at the same moment. Reload the versions and try again.`;
  }
  if (status >= 500 && status <= 599) {
    return `GitHub is having problems right now (error ${status}), so the server could not ${action}. Try again in a few minutes.`;
  }
  return `GitHub answered with an unexpected error (${status}) while the server was trying to ${action}. Try again; if it keeps happening, ask whoever runs the server to check the GitHub settings.`;
}

// ── The push preview both screens show ──────────────────────────────────────

/** What a push will do, for the preview shown before the Push button. */
export type PushPreview = {
  /** The files the push will create, migration first: ["v2.0.0.sql", "v2.0.0.down.sql"]. */
  files: string[];
  /** Set when no rollback file will be written, saying what that means; otherwise null. */
  noRollbackLine: string | null;
  /** "Will become a major bump: v1.4.2 → v2.0.0", or the first-version line. */
  stepLine: string;
  /** The bump the step takes, or null for a first version or a number not above the floor. */
  bump: BumpLevel | null;
  /** True when the family has no version yet. */
  isFirstVersion: boolean;
};

/**
 * Describe a push before it happens. `floor` is the family's highest version
 * (applied to the target or published in GitHub; null for a new family),
 * `version` the number the push will use, and `withRollback` whether a
 * rollback file goes with it (rollbackToSend(...) !== undefined).
 */
export function describePush(input: { floor: string | null; version: string; withRollback: boolean }): PushPreview {
  const { floor, version, withRollback } = input;
  const files = [migrationFileName(version)];
  if (withRollback) files.push(rollbackFileName(version));
  const noRollbackLine = withRollback
    ? null
    : `No rollback file will be written, so Deploy will not be able to undo v${version}.`;

  if (!looksLikeVersion(floor)) {
    return {
      files,
      noRollbackLine,
      stepLine: `First version of this family: v${version}`,
      bump: null,
      isFirstVersion: true,
    };
  }
  const step = levelOfStep(floor, version);
  if (step === null) {
    return {
      files,
      noRollbackLine,
      stepLine: `v${version} is not above v${floor.trim()}, the newest version of this family, so it can't be pushed.`,
      bump: null,
      isFirstVersion: false,
    };
  }
  const bump = levelToBump(step);
  return {
    files,
    noRollbackLine,
    stepLine: `Will become a ${bump} bump: v${floor.trim()} → v${version}`,
    bump,
    isFirstVersion: false,
  };
}
