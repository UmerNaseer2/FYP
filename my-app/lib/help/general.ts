import type { HelpTopic } from "./types";

/** Help for Schema Studio. Shown in the Help panel; the blurb is the page header's one line. */
export const generalHelp: HelpTopic = {
  title: "Schema Studio",
  blurb: "How Schema Studio fits together and where to start.",
  purpose:
    "Schema Studio is a tool for managing PostgreSQL schemas. It compares two databases, writes the SQL that brings them into line, runs it safely and keeps a record of every version. All work belongs to an organization, and your role in it decides what you may do.",
  steps: [
    "Connect: save a connection for each database on the Connections page, for example dev, staging and production.",
    "Track: on the Dashboard, track the schemas you care about. Each one gets a baseline snapshot.",
    "Compare: on Compare, pick the schema you want as the source and the schema to update as the target. The app lists the differences and writes a migration. Comparing changes nothing in either database.",
    "Edit the script: in the Script Editor, write or adjust the SQL and its rollback, then save it to GitHub as a version. Nothing runs from that page.",
    "Deploy: on Deploy, pick the target, press Check database, read the checklist and do a dry run. Then press Deploy to run for real.",
    "Record the version: a deploy writes each version it ran into the target's ledger. Version Sync shows which versions a schema has missed and replays them.",
    "Watch: Drift tells you when a live database has moved away from its baseline. Performance shows what a schema is likely to be slow at.",
  ],
  terms: [
    {
      term: "Schema",
      meaning: "A named group of tables inside a PostgreSQL database, such as public or inventory. Every table belongs to one.",
    },
    {
      term: "Connection",
      meaning: "A saved PostgreSQL database: its host, port, user and password. You can save several and compare across them.",
    },
    {
      term: "Migration",
      meaning: "A versioned SQL script that changes a schema, for example by adding a table or dropping a column.",
    },
    {
      term: "Version",
      meaning: "A number such as v1.0.0 that names one migration. Deploy only moves forward, so a new version must be higher than every one already applied.",
    },
    {
      term: "Script name",
      meaning: "A family name for related migrations, also called a script group. One script name can have many versions.",
    },
    {
      term: "Ledger",
      meaning: "The script_patch table inside a schema. It lists every migration applied to that schema.",
    },
    {
      term: "Replay",
      meaning: "Running a stored migration again on a different schema, to bring that schema up to date.",
    },
    {
      term: "Drift",
      meaning: "A live schema that has moved away from its baseline snapshot without anyone meaning it to.",
    },
    {
      term: "Organization",
      meaning: "The group all work belongs to. It has its own people, roles, saved connections and scripts.",
    },
    {
      term: "Role",
      meaning: "What you may do in an organization. Viewer, Editor and Admin are built in, and an admin can change them or make new ones.",
    },
  ],
  problems: [
    {
      problem: "A button is missing or switched off, or a message starts with Your role.",
      fix: "Your role does not have the permission that button needs. The message names it as a line on Admin, Roles and permissions. Ask an admin to turn that line on for your role, then reload the page.",
    },
    {
      problem: "A compare fails, or a connection error appears.",
      fix: "Open the Connections page and press Test on the connection's row to see the detailed error. Check the saved details, the network and the SSL setting.",
    },
    {
      problem: "A deploy says the version is already applied.",
      fix: "The same script name and version cannot be applied to a schema twice. Save the change as a new, higher version. A run that failed wrote nothing, so it can simply be run again.",
    },
    {
      problem: "Drift is reported but you changed nothing.",
      fix: "It may be an earlier change. Check the Audit log tab on the Drift page to see when it was found. If the live structure is the one you want, use Re-baseline to live on the Drift page.",
    },
    {
      problem: "A schema list in Compare or Visualizer is empty.",
      fix: "Pick a connection first. Check that the schema exists in that database, then reload the page and try again.",
    },
    {
      problem: "The menu shows no role under your name.",
      fix: "The app has no session for you, so you are not signed in even if a page is visible. Sign in again from the login page.",
    },
  ],
  sections: [
    {
      title: "Shortcuts and tips",
      body: [
        "Esc closes any dialog, drawer or open list.",
        "Cmd or Ctrl with Enter runs the analysis on Performance, under Analyse a query.",
        "Your name, your role and the sign out button are at the bottom left of the menu. The light and dark theme switch is just above them.",
      ],
    },
    {
      title: "AI assistance",
      body: [
        "AI help is optional. It can summarise a comparison, review a run, explain a drift, draft SQL and answer questions about a schema.",
        "It stays off until an admin switches it on.",
      ],
    },
  ],
};
