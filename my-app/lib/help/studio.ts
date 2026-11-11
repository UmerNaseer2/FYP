import type { HelpTopic } from "./types";

/** Help for Dashboard. Shown in the Help panel; the blurb is the page header's one line. */
export const studioHelp: HelpTopic = {
  title: "Dashboard",
  blurb: "Every tracked schema, with its lineage version and its latest drift check.",
  purpose:
    "The Dashboard lists every schema your organization tracks. Each card shows the schema's environment, its lineage version and what the last drift check found. Start here to see what needs attention.",
  steps: [
    "Save a connection on the Connections page first. Schema Studio can only track a schema on a PostgreSQL server you have saved.",
    "Press Track a schema, pick a Connection, then pick one of its schemas.",
    "Check the Environment. It starts as the connection's, and you can change it if this schema is a different one.",
    "Add a Label if you want a friendly name on the card, then press Track schema. A baseline snapshot is taken straight away and recorded as v1.0.0.",
    "Use the chips above the cards to show one environment at a time. The tiles at the top count what is on screen.",
    "Press Check drift on a card to compare the live database with its baseline. Press Review drift when a card says Drifted.",
    "Press Open on a card to see the schema's details and its history of versions.",
    "Press the stop tracking button on a card when you no longer need to watch a schema.",
  ],
  terms: [
    {
      term: "Tracked schema",
      meaning:
        "A schema that Schema Studio keeps a snapshot of, so it can tell you later when the live database has moved away from it.",
    },
    {
      term: "Baseline",
      meaning:
        "The snapshot of what a schema looked like when you tracked it. A drift check compares the live database with it.",
    },
    {
      term: "Lineage version",
      meaning:
        "Schema Studio's own counter for a tracked schema. It moves when a deploy or a re-baseline changes the structure. It is separate from the script versions that Deploy shows.",
    },
    {
      term: "Drift",
      meaning:
        "A difference between the live database and its baseline, usually from a change made outside this app. Drift is only reported. Nothing is corrected for you.",
    },
    {
      term: "Drifted, In sync, Unreachable, Not checked",
      meaning:
        "What the last drift check found: the live schema differs, it matches, the database did not answer, or nobody has checked yet.",
    },
    {
      term: "Environment",
      meaning:
        "What kind of database this is: Dev, Staging or Production. Compare and Deploy read it to warn you before you touch production.",
    },
    {
      term: "Label",
      meaning:
        "An optional friendly name shown on the card. Production warnings come from the Environment setting, not from this label.",
    },
    {
      term: "Stop tracking",
      meaning:
        "Removes the schema from the Dashboard with its snapshots, lineage and drift history. The database itself is not touched.",
    },
  ],
  problems: [
    {
      problem: "Track a schema, Check drift or the stop tracking button is switched off.",
      fix: "Your role may not do that. The note at the top of the page names the permission. Ask an admin to turn it on for your role.",
    },
    {
      problem: "The Connection list in the Track a schema dialog is empty.",
      fix: "No PostgreSQL connection is saved yet. Add one on the Connections page, then come back.",
    },
    {
      problem: "The dialog says the connection has no user schemas to track.",
      fix: "That database holds no schemas of its own. Check that the connection points at the right database.",
    },
    {
      problem: "A card says Unreachable.",
      fix: "The database did not answer the last drift check. Test the connection on the Connections page, then press Check drift again.",
    },
    {
      problem: "A card says Drifted but you changed nothing.",
      fix: "The database was changed outside Schema Studio, or an earlier change was forgotten. Press Review drift to see what changed. If the live structure is the one you want, re-baseline it on the Drift page.",
    },
    {
      problem: "Refresh did not clear a drift.",
      fix: "Refresh only reads the list again. It does not run a check or change a baseline. Press Check drift on the card.",
    },
  ],
};
