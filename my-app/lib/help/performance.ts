import type { HelpTopic } from "./types";

/** Help for Performance. Shown in the Help panel; the blurb is the page header's one line. */
export const performanceHelp: HelpTopic = {
  title: "Performance",
  blurb: "Watch database health, slow queries, indexes and alerts.",
  purpose:
    "Performance answers three questions about a PostgreSQL database you already have a connection to. " +
    "What is this schema likely to be slow at? Why is this one query slow? What has this schema been doing over time? " +
    "It has six tabs, and they all work on the connection and schema you pick at the top.",
  steps: [
    "Pick a connection and a schema at the top. The choice stays when you move between tabs.",
    "Open Suggestions to see what the schema is likely to be slow at. Each finding says what to do about it.",
    "Tick the fixes you want under the list, then copy them, download them as a .sql file, or save them as a migration.",
    "Open Analyse a query, paste one query that reads data, and press Analyse to see the server's plan and a score out of 100.",
    "Tick Run it and measure only when you want real times. The query then really runs on that server.",
    "Open History to set a query's runs side by side and see whether it has got slower.",
    "Open Live activity to see what the server is doing right now, and Trends to see how the schema has changed.",
    "Open Alerts, switch on the rules you want, check each number, and press Save thresholds.",
  ],
  terms: [
    {
      term: "Suggestion",
      meaning:
        "Something in the schema that usually makes it slow, such as a foreign key with no index behind it. Each one says what to do.",
    },
    {
      term: "Plan",
      meaning: "The steps the server would take to answer a query. The page shows them in plain English.",
    },
    {
      term: "Estimated",
      meaning:
        "The query was not run. The row counts and costs are the server's own guesses, which is what it chose the plan from.",
    },
    {
      term: "Measured",
      meaning:
        "The query was really run, inside a transaction that was rolled back, so the times and row counts are real.",
    },
    {
      term: "Score",
      meaning:
        "A number out of 100 for one query. Points come off for things in the plan or the SQL that usually cost more than they look.",
    },
    {
      term: "Sequential scan",
      meaning: "The server reads a whole table to find a few rows. On a large table an index is usually faster.",
    },
    {
      term: "Dead rows",
      meaning:
        "Old copies of rows left behind by updates and deletes. They take up space until the server cleans them up with a vacuum.",
    },
    {
      term: "Cache hit ratio",
      meaning:
        "The share of reads the server answered from its own memory. A low number means it is reading from disk a lot.",
    },
    {
      term: "Threshold",
      meaning:
        "A limit you set on the Alerts tab. When a reading passes it, the other tabs flag that reading as a problem.",
    },
    {
      term: "Live counters",
      meaning:
        "PostgreSQL's own record of how tables and indexes have been used. Some suggestions need it, such as unused indexes.",
    },
  ],
  problems: [
    {
      problem: "The tabs only say to choose a connection and a schema.",
      fix: "Pick both at the top of the page. Only PostgreSQL connections are listed. If the list is empty, add one on Connections.",
    },
    {
      problem: "My query is refused.",
      fix:
        "Only one query that reads can be analysed: SELECT, WITH, VALUES or TABLE. Take off a leading EXPLAIN, " +
        "because the page adds that itself.",
    },
    {
      problem: "I cannot tick Run it and measure.",
      fix:
        "Your role needs the permission Measure a query on a live database. Ask an Admin. " +
        "You can still analyse without it, and the page will show the server's estimate.",
    },
    {
      problem: "Trends says the schema is not tracked.",
      fix:
        "Readings are taken by the drift check, not when you open the tab. Track the schema on the Dashboard and " +
        "let a drift check run. The history starts from then.",
    },
    {
      problem: "There is no Save as a migration button.",
      fix:
        "Saving goes through the Script Editor, so your role needs Save scripts to the registry. " +
        "Copy and Download still work. A fix for a different schema than the one picked can only be copied or downloaded.",
    },
    {
      problem: "I set an alert number but nothing is flagged.",
      fix: "Every rule starts switched off. Tick the rule, check its number, and press Save thresholds.",
    },
  ],
  sections: [
    {
      title: "Suggestions tab",
      body: [
        "Worked out from the schema's structure and from the server's own record of how its tables are read. Nothing is stored, so the advice is always current.",
        "The checks cover missing keys and indexes, duplicated, unused and invalid indexes, column types that cost more than they need to, and tables mostly read in full.",
        "Schema changes and maintenance fixes start ticked, even ones the severity filter hides. Query rewrites and decisions are not listed, because a rewrite changes your query and a decision needs your choice first.",
      ],
    },
    {
      title: "Analyse a query tab",
      body: [
        "Paste a query and see what the server would do with it, step by step, plus anything that usually costs more than it looks.",
        "With Run it and measure ticked, the query runs read-only, is rolled back, and is stopped after 15 seconds. A function it calls can still do whatever the connection's database user is allowed to do.",
        "Every analysis is saved to History, so the next run of the same query can be compared with it.",
      ],
    },
    {
      title: "History tab",
      body: [
        "Every query analysed against this schema, newest first, with what it scored and what it cost.",
        "Pick one query to see each of its runs set against an earlier one. Two readings are the only way to tell that a query has got slower.",
      ],
    },
    {
      title: "Live activity tab",
      body: [
        "One reading of what the server is doing: what is running, what has run too long, and what sits in an open transaction holding locks.",
        "It does not refresh on its own. Press Read again for a new reading.",
        "PostgreSQL reports activity for the whole server, so this tab shows every session on it, not only the schema you picked.",
      ],
    },
    {
      title: "Trends tab",
      body: [
        "How this schema has changed over time: its structure, its size on disk, and how often it drifted from its baseline.",
        "One reading is taken every time a drift check runs, so the history starts when the watching does.",
      ],
    },
    {
      title: "Alerts tab",
      body: [
        "Five rules say what counts as a problem for this connection and schema only. A rule that is off is never checked.",
        "The number already in each box is a suggestion. The app has not looked at your database and decided what is slow.",
        "Query slower than counts only measured runs. Dead rows above changes when Suggestions reports a table as needing a vacuum. Left off, that tab uses 20 percent.",
      ],
    },
  ],
};
