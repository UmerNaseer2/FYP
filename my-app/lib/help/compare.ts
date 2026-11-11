import type { HelpTopic } from "./types";

/** Help for Compare & Author. Shown in the Help panel; the blurb is the page header's one line. */
export const compareHelp: HelpTopic = {
  title: "Compare & Author",
  blurb: "Compare one source schema with one or more targets and get editable SQL.",
  purpose:
    "Compare one source schema with up to six target schemas. Each target gets its own report of the differences and its own script that makes that target match the source. Comparing changes nothing in either database, and you can edit the script before you save it.",
  steps: [
    "Pick the source: the connection and schema that already look the way you want.",
    "Pick the target: the connection and schema that should be updated. Press Add target to compare the same source with more targets.",
    "Tick Allow data loss or Compare row data only if you need them. A change to either one takes effect the next time you press Compare.",
    "Press Compare. The app reads the schemas and shows one result for each target.",
    "Read the Summary table and the report under it. Look at anything marked destructive or breaking first.",
    "Review the Generated migration under the report. You can edit the Migration tab and the Rollback tab freely.",
    "Check the migration name, pick a change level and press Push to GitHub. That saves the script to your organization's registry.",
    "Open Deploy to run the saved script. Compare never runs it.",
  ],
  terms: [
    {
      term: "Source",
      meaning: "The schema you want. Compare only reads it and never changes it.",
    },
    {
      term: "Target",
      meaning:
        "The schema that gets updated. Every generated script changes that target so it matches the source.",
    },
    {
      term: "+, - and ~",
      meaning:
        "The signs on the rows of the report. Every row is a change to the target: plus is created, minus is dropped and the wavy sign is altered in place.",
    },
    {
      term: "before → after",
      meaning:
        "How a changed value is written. Read it left to right: the value the target has now, then the value the migration gives it.",
    },
    {
      term: "Destructive",
      meaning: "A statement that deletes data, such as DROP TABLE or DROP COLUMN.",
    },
    {
      term: "Breaking",
      meaning:
        "A change that can break something that reads this schema, such as a dropped view or function. A statement can be destructive, breaking, both or neither.",
    },
    {
      term: "Held back",
      meaning:
        "A statement that was generated and then commented out, so it will not run. Destructive statements are held back while Allow data loss is off.",
    },
    {
      term: "Allow data loss",
      meaning:
        "A switch. While it is off, DROP TABLE, DROP COLUMN and any materialized view rebuild that has to drop the view first are written into the script commented out.",
    },
    {
      term: "Compare row data",
      meaning:
        "A switch. It also reads the rows of every table and reports which tables hold different rows, not just the structure. It is much slower on big tables.",
    },
    {
      term: "Schema objects",
      meaning:
        "Things that belong to the schema and not to any one table: views, sequences, types, functions and the like.",
    },
  ],
  problems: [
    {
      problem: "I want to compare two targets with each other.",
      fix: "Each target is compared with the source only. Targets are not compared with each other. Press Use as source on one target's result to swap it with the source, then press Compare.",
    },
    {
      problem: "A table I renamed shows as one table to create and one to drop.",
      fix: "A rename is written as a rename only when the structure matches and the two names are very close. Otherwise the report offers it as a possible rename for you to confirm by hand. On two big schemas with little in common, renamed tables are not looked for at all, and the page says so.",
    },
    {
      problem: "The script has DROP statements that are commented out.",
      fix: "Allow data loss is off, so statements that delete data are held back. Tick Allow data loss and press Compare again to make them live. Read the script first: this app cannot bring dropped rows back.",
    },
    {
      problem: "Row data reads as different but the data looks the same.",
      fix: "Values are compared as text. Two servers that write the same value differently, for example a different major version or a different DateStyle, read as different even when the data matches. Row counts are exact either way.",
    },
    {
      problem: "I changed a picker or a switch and the result did not change.",
      fix: "Nothing is applied until you press Compare. The line Not applied yet shows under the button until you do.",
    },
    {
      problem: "The push button refuses my script.",
      fix: "Do not write BEGIN, COMMIT or ROLLBACK in a script, because Deploy wraps the whole run in one transaction. Saving also needs the Save scripts to the registry permission and a GitHub repository set up by an Admin.",
    },
  ],
  sections: [
    {
      title: "Several targets",
      body: [
        "Each target gets its own result, with its own diff and its own migration.",
        "The Results bar counts how many targets differ, are in sync or could not be read.",
        "The Saved sets bar keeps a source and its targets under a name, so you can open the same comparison again later.",
      ],
    },
    {
      title: "Reading the report",
      body: [
        "The Summary table has one row for every kind of object and four columns: In sync, Only in source, Only in target and Changed.",
        "The report lists tables first and schema objects after them. Click a group's header to fold it or open it.",
        "Export this diff copies the report as Markdown, JSON or CSV, or prints it.",
      ],
    },
    {
      title: "Views and other schema objects",
      body: [
        "A dropped view or function is graded breaking, because the migration removes it and anything still calling it stops working.",
        "A rebuilt view is dropped with CASCADE first, which can take the things that depend on it too.",
        "Rebuilding a view also takes every index and trigger on it, so the script writes all of them back, whether or not the report lists them as changed.",
      ],
    },
    {
      title: "Row data",
      body: [
        "Rows are compared by checksum, so the order they are stored in does not matter and no primary key is needed.",
        "Open the table picker to read only some tables. Tick nothing to read every table again. Tables you leave out are still listed, as not read.",
        "Each statement has a time limit. A table that runs out of time is listed under Not compared.",
      ],
    },
  ],
};
