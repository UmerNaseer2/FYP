// What state a deploy target is in before anything runs, and what the screen
// should therefore ask first.
//
// Spec feature 11: "If no schema or tables exist, prompt to run /scripts_init"
// and "After initialization, prompt whether to run /scripts_patch." The client
// names two folders; this app has one registry per script family, so the two
// names are two STATES of the same target rather than two places to keep SQL:
//
//   • nothing there yet  → the first version is an initialisation. Running it
//     builds the schema, and the reader should be told that is what they are
//     about to do, not shown a pending list that looks like an ordinary patch.
//   • just initialised   → the versions above it are the patches, and the
//     reader is asked whether to carry on with them rather than having to
//     notice for themselves that more are waiting.
//
// Pure on purpose — no DB, no fetch, no React. The deploy screen is already
// four thousand lines; the question "what should this target be asked?" is
// worth having one testable answer to, and the two callers (the checklist and
// the after-the-run prompt) must not each have their own idea of it.

/** What the pre-flight found on the target, as far as this decision cares. */
export type TargetState = {
  /** Does the schema itself exist? False for a database that has never had it. */
  schemaExists: boolean;
  /**
   * How many ordinary tables the schema holds, NOT counting script_patch and
   * script_patch_reverted — this app's own bookkeeping is not the user's
   * schema, and a target holding nothing but a ledger is still empty.
   */
  tableCount: number;
  /** Is the ledger table there? */
  hasVersionTable: boolean;
  /** Highest version this family has applied, or null for none. */
  currentVersion: string | null;
};

export type DeployStage =
  /** No schema, or a schema with no tables: the first run is an initialisation. */
  | "needs-init"
  /** Tables exist but this family has applied nothing: its first version still runs first. */
  | "unversioned"
  /** A version is applied; anything above it is a patch. */
  | "versioned";

/**
 * Which of the three the target is in.
 *
 * "unversioned" is deliberately separate from "needs-init". A schema full of
 * tables that this app has never deployed to is NOT empty — calling it
 * "needs initialising" would invite somebody to run a CREATE-everything script
 * against a database that already has the tables, which fails at best and
 * drops data at worst. It is a schema that exists and has no recorded version,
 * which is a different sentence and a different first step.
 */
export function deployStage(state: TargetState): DeployStage {
  if (!state.schemaExists || state.tableCount === 0) return "needs-init";
  if (state.currentVersion === null) return "unversioned";
  return "versioned";
}

/** One thing to say, and whether it is a warning rather than a note. */
export type StagePrompt = {
  title: string;
  body: string;
  /** True when the reader should stop and check something, not just read it. */
  warn: boolean;
};

/**
 * What to tell the reader about an empty or unversioned target, or null when
 * there is nothing worth saying (the ordinary case: a versioned target being
 * patched, which the rest of the screen already describes).
 *
 * `firstPending` is the lowest version waiting to run, so the message can name
 * it rather than saying "the first script" and leaving the reader to work out
 * which one that is.
 */
export function stagePrompt(
  state: TargetState,
  stage: DeployStage,
  firstPending: string | null
): StagePrompt | null {
  if (stage === "needs-init") {
    const where = state.schemaExists
      ? "This schema exists but holds no tables"
      : "This schema does not exist on the target yet";
    return {
      title: "Nothing is here yet — this run would initialise the schema",
      body:
        `${where}, so ` +
        (firstPending
          ? `${firstPending} is an initialisation rather than a patch: it is `
          : "the first version you deploy is an initialisation rather than a patch: it is ") +
        "being run against an empty target and has nothing to migrate. Check it " +
        "creates what you expect before running it — a script written as a patch " +
        "will fail here, because the tables it alters are not there to alter." +
        (state.schemaExists
          ? ""
          : " The schema is created by the script itself; this app does not create it for you."),
      warn: true,
    };
  }

  if (stage === "unversioned") {
    return {
      title: "This schema has tables but no recorded version",
      body:
        "There are tables here, so this is not an empty target — but nothing has " +
        "been deployed to it through this app, so there is no version to patch " +
        (firstPending ? `from and ${firstPending} would run first. ` : "from. ") +
        "If these tables were built by hand or by another tool, check the first " +
        "script does not try to create what is already there before you run it.",
      warn: true,
    };
  }

  return null;
}

/** What to offer after a run finishes, once the target has been initialised. */
export type PatchPrompt = {
  /** How many versions are still waiting above what just ran. */
  remaining: number;
  title: string;
  body: string;
};

/**
 * Spec 11.3 — "After initialization, prompt whether to run /scripts_patch."
 *
 * After a run that initialised the target, the versions above it are its
 * patches, and this is the sentence that offers them. Null when there is
 * nothing to offer, which is every one of:
 *
 *   • the run did not initialise anything (an ordinary patch run — the screen
 *     already shows what is left, and a second prompt saying so is noise),
 *   • the run did not finish cleanly (offering the next step after a failure
 *     would be telling somebody to build on a target nobody has checked),
 *   • or nothing is left to run.
 *
 * It is a prompt, not an action: the answer is the reader's, and the versions
 * still have to go through the same preview and approval as any other run.
 * Chaining straight on would turn one confirmed run into two.
 */
export function patchPrompt(input: {
  /** Was the target at "needs-init" when this run started? */
  initialised: boolean;
  /** Did every migration in the run apply? */
  runSucceeded: boolean;
  /** Was it a dry run? Then nothing was actually initialised. */
  dryRun: boolean;
  /** Versions still pending after this run, lowest first. */
  remainingVersions: string[];
}): PatchPrompt | null {
  if (!input.initialised || !input.runSucceeded || input.dryRun) return null;
  const remaining = input.remainingVersions.length;
  if (remaining === 0) return null;

  const [first] = input.remainingVersions;
  const last = input.remainingVersions[remaining - 1];
  return {
    remaining,
    title: remaining === 1 ? "One more version is waiting" : `${remaining} more versions are waiting`,
    body:
      `The schema is initialised. ` +
      (remaining === 1
        ? `${first} has not been applied yet — run it now to bring this target up to date, `
        : `${first} through ${last} have not been applied yet — run them now to bring this ` +
          `target up to date, `) +
      `or leave it here and come back. Nothing runs until you choose it: this is the same ` +
      `deploy as any other, with the same preview beforehand.`,
  };
}
