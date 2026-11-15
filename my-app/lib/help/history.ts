import { anchor } from "./steps";
import type { HelpTopic } from "./types";

/** Help for History. Shown in the Help panel; the blurb is the page header's one line. */
export const historyHelp: HelpTopic = {
  title: "History",
  blurb: "Every drift check recorded in your organization, newest first.",
  purpose:
    "History lists the drift checks Schema Studio has recorded for your organization. Each one says which schema was checked, what the check found, and what started it.",
  steps: [
    { text: "Read the Last 30 days strip first. One square is one check. Its colour and mark show what the check found.", target: anchor("history-days", ".hi-days") },
    "Press a day in the strip to see only that day. Press Show all 30 days to go back.",
    { text: "Use the buttons under the strip to show one result at a time, such as Drifted.", target: anchor("history-filters", ".hi-f") },
    { text: "Pick a schema, pick what started the check, or type in the search box to narrow the list further.", target: anchor("history-search", ".hi-search") },
    { text: "Press an entry to read about it beside the list. Open in Drift takes you to that schema's drift page.", target: anchor("history-list", ".hi-list") },
    { text: "Press Export as CSV to save the entries on screen as a file. Press Print report to print them.", target: anchor("history-export", ".hi-acts") },
  ],
  terms: [
    {
      term: "Drift check",
      meaning:
        "A comparison of a tracked schema's live database with the snapshot Schema Studio keeps of it.",
    },
    {
      term: "Drifted",
      meaning: "The live database no longer matches the snapshot.",
    },
    {
      term: "Can't be reached",
      meaning: "The check could not run because the database did not answer.",
    },
    {
      term: "Acknowledged",
      meaning: "Someone has seen a drifted check and marked it as known.",
    },
    {
      term: "Started by",
      meaning: "What ran the check: a person, the schedule, or a deploy.",
    },
  ],
  problems: [
    {
      problem: "The page says your role cannot see this.",
      fix: "Reading drift checks needs the Drift tracking: Read permission. Ask an Admin for it.",
    },
    {
      problem: "An old check is missing.",
      fix: "The page lists the newest 200 checks. Open the schema's drift page to read its own history.",
    },
    {
      problem: "The list is empty.",
      fix: "Nothing has been checked yet. Track a schema on the Dashboard, then press Check drift.",
    },
  ],
};
