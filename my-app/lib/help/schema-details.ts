import type { HelpTopic } from "./types";

/** Help for Schema details. Shown in the Help panel; the blurb is the page header's one line. */
export const schemaDetailsHelp: HelpTopic = {
  title: "Schema details",
  blurb: "One tracked schema: its drift state and its history of versions.",
  purpose:
    "This page shows one tracked schema in full. You see whether it has drifted, and its lineage: every version Schema Studio recorded for it. From here you can check drift again or open Compare with this schema as the target.",
  steps: [
    "Open the page from the Dashboard by pressing Open on a schema's card.",
    "Read the pills at the top: the drift state, the database type and how many entries the lineage has.",
    "Press Check drift now, or Re-check drift, to compare the live database with the baseline.",
    "If the schema has drifted, press Review drift. The Drift page shows what changed and the ways to resolve it.",
    "Read the Lineage list, newest at the top. Each entry shows its snapshot counts and its migration script where one is stored.",
    "Press Compare with another database to open Compare with this schema as the target.",
  ],
  terms: [
    {
      term: "Lineage",
      meaning:
        "The history of this schema's versions as Schema Studio recorded them. The first entry is the baseline.",
    },
    {
      term: "Lineage version",
      meaning:
        "Schema Studio's own counter for this tracked schema. It counts structure changes. It is not a script version from GitHub or from Deploy.",
    },
    {
      term: "HEAD",
      meaning:
        "The newest entry in the lineage. The table and column counts under the title come from its snapshot. They are not read live, so after a drift the live schema can differ.",
    },
    {
      term: "Snapshot",
      meaning:
        "A stored copy of the schema's structure at one moment: its tables, columns, constraints and other objects.",
    },
    {
      term: "Baseline",
      meaning:
        "The snapshot taken when the schema was tracked. It was captured straight from the live database, so it has no migration script of its own.",
    },
    {
      term: "Not recorded in this snapshot",
      meaning:
        "Kinds of object an older snapshot does not hold, because it was captured before this app read them. A comparison against it stays quiet about them and does not report them as missing.",
    },
    {
      term: "Connection removed",
      meaning:
        "The saved connection this schema was tracked on has been deleted, so the live database can no longer be reached from here.",
    },
    {
      term: "Re-baseline",
      meaning:
        "Accepting the live structure as the new expected snapshot. It is done on the Drift page. Look at what changed first.",
    },
  ],
  problems: [
    {
      problem: "The page says Schema not found.",
      fix: "The schema is no longer tracked. It may have been removed. Go back to the Dashboard to see what is tracked.",
    },
    {
      problem: "The counts under the title do not match the live database.",
      fix: "They come from the newest lineage snapshot. Press Re-check drift, then Review drift to see what is different now.",
    },
    {
      problem: "The page says no drift check has run yet.",
      fix: "Nobody has compared the live database with the baseline. Press Check drift now.",
    },
    {
      problem: "There is no Compare with another database button.",
      fix: "The schema's connection was removed, so there is nothing to open Compare with. Save the connection again on the Connections page.",
    },
    {
      problem: "A lineage entry has no migration script.",
      fix: "The baseline never has one, because it was captured from the live database. For other entries, no script was stored when the version was recorded.",
    },
  ],
};
