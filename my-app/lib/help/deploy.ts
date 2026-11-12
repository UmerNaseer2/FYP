import type { HelpTopic } from "./types";

/** Help for Deploy. Shown in the Help panel; the blurb is the page header's one line. */
export const deployHelp: HelpTopic = {
  title: "Deploy",
  blurb: "Run saved versions on a database, with a dry run first and undo after.",
  purpose:
    "Deploy brings one schema of a database up to a version. It runs versions saved to the registry from Compare & Author or the Script Editor, not pasted SQL. Each run goes in one transaction, so all of its migrations are applied or none are.",
  steps: [
    "Save the migration to the registry first, on Compare & Author or in the Script Editor.",
    "On Pre-flight, pick the connection, the schema and the script group, then press Check database.",
    "Read Applied to target, the version timeline and the list of pending migrations.",
    "Choose how far to go. Tick a version, press its Run button, or press Run all. This only picks the range. Nothing runs yet.",
    "Read the Pre-flight checklist. On a production target, tick every box the page asks for.",
    "Press Dry run to rehearse. The scripts run on the target and are then rolled back, so nothing is written.",
    "Press Deploy to run for real. The Run step shows how each migration went.",
    "On Verify, read what was applied, then record it on Version Sync or watch the database on Drift.",
  ],
  terms: [
    {
      term: "Script group",
      meaning:
        "One named set of migrations that carries a schema forward, one version at a time. It shows up here once a script is saved on Compare & Author or in the Script Editor.",
    },
    {
      term: "Pending migration",
      meaning: "A version in the registry that the target database does not have yet.",
    },
    {
      term: "Ledger",
      meaning:
        "The script_patch table inside the target schema. It records every version applied there. Deploy creates it if the schema does not have one.",
    },
    {
      term: "Dry run",
      meaning:
        "A rehearsal. The SQL really runs on the target inside one transaction that always ends in a rollback. It stops any statement that takes longer than five minutes.",
    },
    {
      term: "One transaction",
      meaning:
        "Every migration in a run is applied together. If one fails, the whole run is rolled back and the target is left as it was. The one exception is a new enum value, which is added first and stays.",
    },
    {
      term: "Skipped",
      meaning:
        "An older version that was never applied and sits below the version the target is on now. It will not run.",
    },
    {
      term: "Breaking",
      meaning:
        "A migration that drops or rewrites structure that is already there. Anything that reads the old shape stops working once it is applied.",
    },
    {
      term: "Applies-to header",
      meaning:
        "A line in a script that names the applications it is for. A version for an application this database does not host is left out of the run, and later versions still run.",
    },
    {
      term: "Deploy history (all attempts)",
      meaning:
        "Everything run against this schema from here, whether or not it landed. Failed, refused and timed out runs are listed too, with the reason.",
    },
  ],
  problems: [
    {
      problem: "The script group list is empty.",
      fix: "Nothing is saved for this schema yet. Make a script on Compare & Author, or write one by hand in the Script Editor, then come back.",
    },
    {
      problem: "Deploy and Dry run are switched off.",
      fix: "Read the line under the two buttons. It names the first thing in the way: an unticked box, a missing approval, a read-only connection, your role, or a drift check that is still running.",
    },
    {
      problem: "I cannot untick a version in the middle of the list.",
      fix: "A run is always an unbroken sequence from the first pending version, because a later migration changes what an earlier one creates. Untick a version to stop before it. Every version after it comes out too.",
    },
    {
      problem: "A version I saved is missing from the pending list.",
      fix: "Look for a line that starts with Not in this run. The version was skipped, or its Applies-to header names an application this database does not host. If a note at the top says some of the registry could not be read, reload the page.",
    },
    {
      problem: "A dry run fails on a new enum value but the real run works.",
      fix: "A real run adds a new enum value before the transaction opens. A dry run cannot do that without leaving the value behind, so it adds it inside the transaction, where PostgreSQL will not let it be used yet. The real run is safe to try.",
    },
    {
      problem: "The run stopped part way.",
      fix: "Nothing was applied. Read the error on the Run step, fix the script or the data it tripped on, then go Back to Pre-flight or press Run again. If the page says the outcome is not known, press Check database first.",
    },
  ],
  sections: [
    {
      title: "Rolling back",
      body: [
        "On Pre-flight, press Plan a rollback and pick the version to go back to. Every applied version above it is undone, newest first, in one transaction.",
        "A rollback restores structure, not rows. Deleted rows do not come back, so keep a backup. One rollback undoes at most 50 versions. To go further back, run it and then roll back again.",
        "Dry run the rollback rehearses it without changing anything. A rollback runs as soon as you press its button, unless the target is production and your organization has the two-person rule on.",
      ],
    },
    {
      title: "Production approvals",
      body: [
        "Only while an admin has the two-person rule on: a target labelled production needs an approval from a second person for each real run and each rollback. Dry runs never need one. Nobody can approve their own request. With the rule off, nobody needs an approval at all.",
        "An approval covers one run of the exact SQL it was given, for up to 7 days. Change the SQL, or wait longer, and it needs approving again. A dry run does not need it or use it up.",
        "The note you type with a request is shown to whoever approves it. The note typed with a decision is stored with the approval and shown in the audit log.",
      ],
    },
    {
      title: "Who may run a deploy",
      body: [
        "Running, rolling back and rehearsing all need the Apply or revert migrations permission. Out of the box, Editor and Admin have it.",
        "The connection has the last word. On Connections it can be set to allow anyone who may deploy, admins only, or nobody (read-only).",
      ],
    },
  ],
};
