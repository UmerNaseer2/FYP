import type { HelpTopic } from "./types";

/** Help for Drift. Shown in the Help panel; the blurb is the page header's one line. */
export const driftHelp: HelpTopic = {
  title: "Drift",
  blurb: "Find changes made to a database outside this app, then undo or accept them.",
  purpose:
    "Drift watches a tracked schema for changes nobody planned. When you track a schema, the app saves a snapshot of its structure. " +
    "Drift compares the live database against that snapshot and shows what no longer matches, so every change can be explained.",
  steps: [
    "Track a schema on the Dashboard first. That saves the snapshot Drift compares against.",
    "Open Drift and pick the schema under Tracked schema.",
    "Read the status at the top: in sync, drifted, unreachable or no baseline.",
    "If it has drifted, read Expected and Actual to see which tables and columns changed.",
    "Choose how to deal with it: Author a migration, Re-baseline to live, or Acknowledge.",
    "Press Check drift now to run the check again and record the result.",
    "Open the Schedule tab and pick a time under How often, so the schema is checked without anyone asking.",
    "Open the Audit log tab to look back over every recorded check.",
  ],
  terms: [
    {
      term: "Drift",
      meaning: "A difference between the live database and the structure the app expects, made outside this app.",
    },
    {
      term: "Baseline",
      meaning: "The saved snapshot of a schema's structure. It is the expected side of every drift check.",
    },
    {
      term: "Expected and Actual",
      meaning: "Expected is the baseline. Actual is the live database, read when the page loads.",
    },
    {
      term: "Author a migration",
      meaning:
        "Opens Compare with the live schema loaded, so you can write the migration that makes the change intentional. Nothing is written for you.",
    },
    {
      term: "Re-baseline to live",
      meaning:
        "Accepts the live structure as the new expected snapshot. It asks you to confirm, because the drift then disappears without being explained.",
    },
    {
      term: "Acknowledge",
      meaning: "Records that a person has looked at the drift. It changes nothing in the database.",
    },
    {
      term: "Recorded check",
      meaning:
        "A check that was saved to the audit log. The diff on the page is read live, so it can be newer than the last recorded check.",
    },
    {
      term: "Unreachable",
      meaning: "The app could not connect to the schema's database, so it could not compare anything.",
    },
    {
      term: "Cadence",
      meaning: "How often a schema is checked on its own, from Manual only up to Once a day.",
    },
  ],
  problems: [
    {
      problem: "The page says Nothing tracked yet.",
      fix: "Go to the Dashboard and track a schema. Drift can only watch schemas that have a baseline.",
    },
    {
      problem: "The status says not checked, but a full diff is showing.",
      fix:
        "The diff is read live each time the page loads. The status badge is the last saved result. Press Check drift now to save one.",
    },
    {
      problem: "The schema's database is unreachable.",
      fix: "Open Connections and test the connection. It may have been removed, or its server may be down.",
    },
    {
      problem: "Automatic drift checking says Not running.",
      fix:
        "Checks then only run when you press Check drift now. The Schedule tab says why it stopped. " +
        "A schema set to Manual only is never checked on a timer.",
    },
    {
      problem: "The audit log has no new rows, but the schema is on a schedule.",
      fix:
        "An automatic check adds an audit row only when the result changes. Look at Last checked on the Schedule tab to see that it ran.",
    },
    {
      problem: "The buttons to fix drift are greyed out.",
      fix:
        "The four actions wait for one another, so wait for the running one to finish. If your role lacks the permission, ask an Admin.",
    },
  ],
  sections: [
    {
      title: "Drift detail tab",
      body: [
        "Compares a tracked schema's live structure against its expected snapshot, and lets you resolve any drift.",
        "A schema that is back in sync keeps only the re-check.",
        "If AI assistance is switched on, a panel named Explain this drift can describe the changes in plain words.",
      ],
    },
    {
      title: "Audit log tab",
      body: [
        "Every recorded drift check, newest first.",
        "Filter it by status, or search it by schema, connection or summary.",
      ],
    },
    {
      title: "Schedule tab",
      body: [
        "How often each tracked schema is checked on its own, when it was last checked, and when the next check is due.",
        "Last checked is stamped every time a check runs, whatever the result. A schema that stays in sync does not fill the log.",
        "The card at the top says whether automatic checking is running on this server.",
      ],
    },
    {
      title: "Checked by the website, and On your computers",
      body: [
        "In the desktop app, Checked by the website lists schemas the organization checks on its own connections. This computer shows the latest results. The full diff is on the website.",
        "In a browser, On your computers lists schemas the desktop app checks on connections that stay on your computers. Only you see that list, and the full diff is in the desktop app.",
      ],
    },
  ],
};
