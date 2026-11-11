import type { HelpTopic } from "./types";

/** Help for Script Editor. Shown in the Help panel; the blurb is the page header's one line. */
export const scriptEditorHelp: HelpTopic = {
  title: "Script Editor",
  blurb: "Write a migration by hand and save it to GitHub as a numbered version.",
  purpose:
    "Script Editor is where you write a migration by hand and save it to the GitHub registry as a numbered version. " +
    "Nothing runs against a database from this page. Running a saved version is done on Deploy.",
  steps: [
    "Under Where this script belongs, pick a Connection, a Schema and a Script group. Use Pick existing for a group already in the registry, or + New group and type a name.",
    "Type the migration under SQL.",
    "Type the statements that undo it under Rollback SQL. To save without them, tick the box that starts Save without a rollback.",
    "Fill in the Change log if you want to say why this version exists.",
    "Under Version, check the number. It is suggested from your SQL. Version bump lets you pick another step, and custom lets you type a number.",
    "Press the save button. It reads Save, then the version number, then to GitHub.",
    "When it has saved, follow the link to the file on GitHub, or the link to Deploy to run it.",
  ],
  terms: [
    {
      term: "Registry",
      meaning:
        "The GitHub repository where saved scripts live. Each database, schema and script group has its own folder in it.",
    },
    {
      term: "Script group",
      meaning: "A named set of versions of one script. Every version you save is added to a group.",
    },
    {
      term: "Connection",
      meaning:
        "Here it only names the registry folder and lets the page read which versions the database has already applied, so the new version lands above them.",
    },
    {
      term: "Rollback SQL",
      meaning:
        "The statements that undo a version. They are saved beside the script as a .down.sql file, which Deploy runs when you revert that version.",
    },
    {
      term: "Change log",
      meaning: "An optional line on why the version exists. It is saved in the script and recorded when the version is deployed.",
    },
    {
      term: "Version",
      meaning:
        "The number a script is saved under, such as v1.2.0. A new one is always higher than the version applied to the database and the highest one in GitHub.",
    },
    {
      term: "Version bump",
      meaning:
        "How big a step the new number takes. Patch is for fixes and data, minor adds things, and major changes or removes things that existing queries may use.",
    },
    {
      term: "Change level",
      meaning:
        "How risky the change is: breaking, additive or patch. It is read from the statements that will run, and it is the level Deploy shows for the version.",
    },
  ],
  problems: [
    {
      problem: "The page says the GitHub registry is not set up.",
      fix: "Nothing can be listed or saved until it is. An admin adds the repository and an access token on the Admin screen, under GitHub. In the desktop app, add them in Settings.",
    },
    {
      problem: "The page will not save a script that has COMMIT or ROLLBACK in it.",
      fix: "Take the transaction statements out of both boxes. Deploy runs the whole script in one transaction of its own.",
    },
    {
      problem: "There is no Save button.",
      fix: "Pick a schema and a script group first. The version and the Save button appear in the Version card once they are set.",
    },
    {
      problem: "Save is off for your role.",
      fix: "Saving needs the permission Save scripts to the registry. Ask an admin to turn it on for your role.",
    },
    {
      problem: "A version was saved without a rollback, so Deploy cannot undo it.",
      fix: "Pick its script group. Add a missing rollback appears at the bottom of the page. Pick the version and write its rollback. The migration itself is not changed. A saved rollback cannot be changed afterwards, so read it carefully.",
    },
    {
      problem: "A rollback would drop a column that now holds data.",
      fix: "A rollback restores structure, not rows. Dropping the column deletes everything written into it since the version landed, and only a point-in-time restore brings that back. Where you can, undo by renaming or keeping the column.",
    },
  ],
  sections: [
    {
      title: "Write it with AI",
      body: [
        "If AI assistance is on, type what the script should do in plain words and press Write the script.",
        "The draft comes with a rollback. Read both before you save.",
      ],
    },
  ],
};
