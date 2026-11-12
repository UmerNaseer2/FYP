import type { HelpTopic } from "./types";

/** Help for Version Sync. Shown in the Help panel; the blurb is the page header's one line. */
export const versionsyncHelp: HelpTopic = {
  title: "Version Sync",
  blurb: "See which versions a schema is missing, and replay them from one that is ahead.",
  purpose:
    "Version Sync compares the versions two schemas have run and shows what the one behind is missing. " +
    "A replay runs the exact scripts the ahead schema already ran, in the same order, so the version history is kept. " +
    "A structural compare jumps straight to the end state instead.",
  steps: [
    "Pick a Source: a connection and a schema. This is the schema that is ahead.",
    "Pick a Target the same way. This is the schema that is behind. The button between the two pickers swaps them.",
    "Wait while the page reads both ledgers. There is no button to start it.",
    "Read Missing on the Target. It lists the versions the Source has and the Target lacks, in the order the Source ran them.",
    "Press a Run button. It replays from the top of the list down to its own row, because a later version may depend on an earlier one. Run all replays the whole list.",
    "Check the Replay dialog. Nothing has run yet. It shows what runs, in order, with a warning for each risk you should read first.",
    "Press Dry run to rehearse. The scripts run and are then rolled back, so nothing is written.",
    "Press Replay to do it for real. If your role may not run migrations on the Target, ask an Admin to approve that exact replay, and then you can run it once.",
  ],
  terms: [
    {
      term: "Ledger",
      meaning:
        "The list of versions a schema has run. It is kept in the schema's script_patch table, with each version's script name, number, change level and SQL.",
    },
    { term: "Source", meaning: "The schema that is ahead. Its scripts are the ones a replay runs." },
    { term: "Target", meaning: "The schema that is behind. A replay writes to it." },
    {
      term: "Replay",
      meaning:
        "Running the Source's stored scripts on the Target, in order, as one transaction: every version applies, or none does. Each version is then recorded in the Target's ledger, just as a Deploy run records it.",
    },
    {
      term: "Dry run",
      meaning: "A rehearsal of the replay inside a transaction that is always rolled back.",
    },
    {
      term: "Cannot be replayed forward",
      meaning:
        "Versions the Target lacks, in scripts where the Target is already at that version or above. A replay only moves forward, so the server refuses these.",
    },
    {
      term: "Diverged",
      meaning:
        "The Target has versions the Source does not. A replayed script may clash with the Target's own changes, and nothing is merged automatically.",
    },
    {
      term: "Without stored SQL",
      meaning: "A version that was applied before the app kept its SQL. There is no script to run, so it cannot be replayed.",
    },
    {
      term: "Source vs Target",
      meaning: "Both ledgers side by side, so you can see which side has which version.",
    },
  ],
  problems: [
    {
      problem: "There are no Run buttons.",
      fix: "A replay needs the permission Apply or revert migrations, and a Target whose connection lets your role run migrations. Without them you can still read the lists. Ask an admin.",
    },
    {
      problem: "The page says a run stops before a version.",
      fix: "That version has no stored SQL or is out of order, and the versions after it wait behind it. Replay the versions before it first. If the GitHub registry still has it, deploy it to the Target from Deploy.",
    },
    {
      problem: "A change you want is under Cannot be replayed forward.",
      fix: "Write it as a new version in the Script Editor and deploy it.",
    },
    {
      problem: "The page says the schemas have diverged.",
      fix: "Open each version listed there and read its script before you replay anything.",
    },
    {
      problem: "Dry run and Replay stay off in the dialog.",
      fix: "Both buttons wait until the Target's tracking record can be read. If your role may not run migrations on the Target, Replay also waits until an Admin approves the replay you asked for, and there is no dry run.",
    },
  ],
  sections: [
    {
      title: "What a replay writes",
      body: [
        "It writes to the Target only. The Source is read, never changed.",
        "If the GitHub registry is set up and has no file for a replayed version under the Target, the file is saved there too. The page says what was saved and what was not.",
        "The stored SQL should use table names without a schema in front. The replay points them at the Target schema.",
      ],
    },
  ],
};
