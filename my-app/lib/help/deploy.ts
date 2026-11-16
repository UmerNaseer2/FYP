import { anchor } from "./steps";
import type { HelpTopic } from "./types";

/** Help for Deploy. Shown in the Help panel; the blurb is the page header's one line. */
export const deployHelp: HelpTopic = {
  title: "Deploy",
  blurb: "Run saved versions on a database, or type SQL and run it now.",
  purpose:
    "Deploy brings one schema of a database up to a version. It runs versions saved to the registry from Compare & Author or the Script Editor. For a small change, Quick run takes SQL you type, or SQL the AI writes from your words, and saves it as the next version as it runs. Each run goes in one transaction, so all of its migrations are applied or none are.",
  steps: [
    "Save the migration to the registry first, on Compare & Author or in the Script Editor.",
    { text: "On Pre-flight, pick the connection, the schema and the script group, then press Check database.", target: anchor("deploy-target", ".dp-fields") },
    "Read Applied to target, the version timeline and the list of pending migrations.",
    { text: "Choose how far to go. Tick a version, press its Run button, or press Run all. This only picks the range. Nothing runs yet.", target: anchor("deploy-pending", ".dp-mig-list") },
    { text: "Read the Pre-flight checklist. It warns you about breaking changes, deleted rows and drift. The warnings do not stop a run.", target: anchor("deploy-checklist", ".dp-gates") },
    { text: "Press Dry run to rehearse. The scripts run on the target and are then rolled back, so nothing is written.", target: anchor("deploy-run", ".dp-zone") },
    "Press Deploy to run for real. The Run step shows how each migration went.",
    "On Verify, read what was applied, then record it on Version Sync or watch the database on Drift.",
    { text: "For a quick change, press Quick run instead. Type the SQL, or describe it and let the AI write it, add a rollback, then press Dry run and Deploy.", target: anchor("deploy-quick-run", ".qr-open") },
  ],
  terms: [
    {
      term: "Script group",
      meaning:
        "One named set of migrations that carries a schema forward, one version at a time. It shows up here once a script is saved on Compare & Author or in the Script Editor.",
    },
    {
      term: "Quick run",
      meaning:
        "A panel on Deploy that runs SQL you type, or SQL the AI writes, on one schema. It is saved as the next version of the quick-changes group (or a group you name): a row in the schema's script_patch table and a file in GitHub, with its rollback if you add one.",
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
      problem: "Quick run's Deploy button stays off.",
      fix: "Press Dry run first. Deploy opens only for the exact SQL, rollback and group the dry run passed, so any change locks it until the next dry run. If your role has to ask, the panel offers Save to GitHub and ask an Admin instead.",
    },
    {
      problem: "The script group list is empty.",
      fix: "Nothing is saved for this schema yet. Make a script on Compare & Author, or write one by hand in the Script Editor, then come back.",
    },
    {
      problem: "Deploy and Dry run are switched off.",
      fix: "Read the line under the two buttons. It names the first thing in the way: a missing approval, a read-only connection, your role, or a drift check that is still running.",
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
      title: "Running a quick change",
      body: [
        "Quick run is for a change you want on one schema now, without saving a script first. Pick the connection and schema, then type the SQL on Write SQL, or say what should change on Describe it and the AI writes the SQL, tried on the schema and rolled back.",
        "A rollback is optional. Type it, or press Write the rollback with AI and the AI writes it from your SQL. Without one, the run can't be undone from Schema Studio. With one, Undo this run appears once it commits: dry run the rollback, then roll back.",
        "The version is picked from the change level, above the highest version the group has in the ledger and in GitHub. When the run commits it lands in the schema's script_patch table and is saved to GitHub, with its rollback beside it. Without GitHub set up, it is kept in the scripts table only.",
        "Roles and approvals work as everywhere else on Deploy. A role that has to ask saves the version to GitHub and an Admin gets a request for that exact SQL.",
      ],
    },
    {
      title: "Rolling back",
      body: [
        "On Pre-flight, press Plan a rollback and pick the version to go back to. Every applied version above it is undone, newest first, in one transaction.",
        "A rollback restores structure, not rows. Deleted rows do not come back, so keep a backup. One rollback undoes at most 50 versions. To go further back, run it and then roll back again.",
        "Dry run the rollback rehearses it without changing anything. A rollback runs as soon as you press its button, unless your role needs an Admin's approval for it.",
      ],
    },
    {
      title: "Approvals",
      body: [
        "Your role decides what you may do. If it allows a run or a rollback on the connection, you just do it, and an Admin always may. Nobody else needs to approve it.",
        "An approval covers one run of the exact SQL it was given, for up to 7 days. Change the SQL, or wait longer, and it needs approving again. A dry run does not need it or use it up.",
        "If your role may not run migrations or roll back on the connection, Deploy offers Ask for approval instead. An Admin approves that exact run, and then you can run it once, within 7 days. Only you can use that approval, and nobody can approve their own request. There is no dry run without it, and a read-only connection is never opened this way.",
        "The note you type with a request is shown to whoever approves it. The note typed with a decision is stored with the approval and shown in the audit log.",
      ],
    },
    {
      title: "Who may run a deploy",
      body: [
        "Running, rolling back and rehearsing all need the Apply or revert migrations permission. Out of the box, Editor and Admin have it.",
        "The connection has the last word. On Connections it can be set to allow anyone who may deploy, admins only, or nobody (read-only).",
        "An Admin can always run. Anyone else whose role or connection stops them can ask an Admin to approve one exact run, as described under Approvals.",
      ],
    },
  ],
};
