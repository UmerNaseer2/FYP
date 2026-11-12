import type { HelpTopic } from "./types";

/** Help for Connections. Shown in the Help panel; the blurb is the page header's one line. */
export const connectionsHelp: HelpTopic = {
  title: "Connections",
  blurb: "Save the PostgreSQL databases this organization works with, and test that they answer.",
  purpose:
    "A connection is one saved database on a PostgreSQL server this app can reach, local or hosted. Compare, Drift and Deploy all read through connections, so this is the first thing to set up. Passwords are encrypted when saved and are never shown again.",
  steps: [
    "Press Add connection. On an empty list the button reads Add your first connection.",
    "Under Quick start, pick Local Postgres or Hosted to fill in a name and the SSL mode each one needs. Hosted leaves the connection string to you.",
    "Type a Friendly name, such as production or dev local. It is the name shown in lists and breadcrumbs.",
    "Give the details either way round: paste a postgres:// connection string, or fill in Host, Port, Database, User and Password.",
    "Pick the SSL mode, then choose who may run migrations here.",
    "Press Test now to check that the database answers, then press Save connection.",
    "Later, use Test, Edit or Delete on a connection's row. Delete removes it from the app, not the real database.",
  ],
  terms: [
    {
      term: "Friendly name",
      meaning: "Your own name for the connection. It is shown in lists and breadcrumbs across the app.",
    },
    {
      term: "Connection string",
      meaning:
        "One line that holds the whole address, starting with postgres://. When you edit a connection, leave it blank to keep the saved one, or paste a new one to replace it.",
    },
    {
      term: "SSL mode",
      meaning:
        "Off means no encryption, which is normal for a database on the same computer. Require encrypts the link but accepts any certificate, which is what hosted Postgres (Supabase, Neon, RDS) needs. Verify full also checks the certificate and the host name, and fails on a self-signed certificate.",
    },
    {
      term: "Who may run migrations here",
      meaning:
        "Who may make this app write to this database. It is checked by Deploy, by Revert and by a Version Sync replay. Comparing, generating scripts, previewing and exporting are not affected. It can only narrow who may run migrations, never let anyone else in.",
    },
    {
      term: "Read-only",
      meaning:
        "Nobody may run migrations here, Admins included. It is a statement about the database, not a rank to be outranked. Use it for a reference or model schema that other databases are compared against.",
    },
    {
      term: "Application table",
      meaning:
        "Optional. A table on this database with an application_name column, naming the applications it hosts. Deploy reads it to decide whether a script marked for one application may run here. Write it as schema.table, or just the table name to read it in the schema being deployed to.",
    },
    {
      term: "Only this machine can reach it",
      meaning:
        "Shown on a copy of Schema Studio that keeps its own local passwords. When ticked, the password stays on that machine. Everyone in the organization sees the connection by name, and it runs only there.",
    },
    {
      term: "Healthy",
      meaning:
        "How many connections answered the last time they were tested. A dash means none has been tested yet.",
    },
  ],
  problems: [
    {
      problem: "Test now fails on a hosted database.",
      fix: "Set the SSL mode to Require. Hosted Postgres such as Supabase, Neon and RDS refuses a link that is not encrypted.",
    },
    {
      problem: "Verify full fails but Require works.",
      fix: "The server uses a self-signed certificate, or the host name does not match it. Use Require, or give the server a certificate that can be checked.",
    },
    {
      problem: "A button is switched off.",
      fix: "Adding, editing or testing, and deleting are three separate permissions. The note under the page header says which one your role is missing, and lets you ask an Admin for it.",
    },
    {
      problem: "I cannot make Who may run migrations here less strict.",
      fix: "Anyone who may edit the connection can make it stricter. Making it looser again needs the Approve runs permission, which only an Admin has to begin with.",
    },
    {
      problem: "A script for one application is refused at deploy time.",
      fix: "Check the Application table. If it has the wrong name, is missing, or cannot be read, restricted scripts are refused instead of being let through.",
    },
  ],
  sections: [
    {
      title: "The list",
      body: [
        "Filter the list with All, Local, Remote or SSL on. The connections are listed by name.",
        "The line under the page title counts the connections, how many are healthy, failing or untested, and the average time a test took.",
      ],
    },
    {
      title: "On linked computers",
      body: [
        "These connections are kept in the desktop app on computers linked to the organization. Their passwords stay on that computer, so they cannot be changed or used from the website.",
        "Open Schema Studio on that computer to use them. Its owner can also compare them from the website while the computer is on.",
        "A linked computer can open the organization's saved connections. Its owner or an Admin can unlink it with Unlink, for instance when it is lost.",
      ],
    },
  ],
};
