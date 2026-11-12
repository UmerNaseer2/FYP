import type { HelpTopic } from "./types";

/** Help for Requests. Shown in the Help panel; the blurb is the page header's one line. */
export const requestsHelp: HelpTopic = {
  title: "Requests",
  blurb: "Ask for what your role can't do, and answer what is waiting on you.",
  purpose:
    "Requests is where you ask for something your role can't do yet, and where the people who can answer see what is waiting. " +
    "Runs that need an approval, or are ready to run, show here too. " +
    "The app does not send email, so a number beside Requests in the sidebar is how people find out.",
  steps: [
    "Under What do you need?, choose the thing your role can't do yet, or Something else.",
    "Say why if you like. A sentence helps whoever answers. For Something else, you have to say what you need.",
    "Click Send request. It goes to the people here who can change roles or users.",
    "Find it under You asked while it waits. Withdraw takes it back. Once it is answered it moves to Done.",
    "Once it is allowed, reload the page you need it on, and you can use it.",
    "If you answer requests, look under Needs you. Allow just the asker for 24 hours, allow it for everyone in the asker's role, give the asker another role, mark it as done, or decline.",
    "What you allowed for 24 hours is listed under Allowed for 24 hours until it ends. End now stops it early.",
    "For a run, follow Review it on Deploy to approve it, or Open it on Deploy to run one of yours that was approved.",
    "Away from a computer? Use Phone app at the top of this page. The phone app can alert you when something here needs you.",
  ],
  terms: [
    {
      term: "Needs you",
      meaning:
        "Requests you may answer, and runs that wait for your approval. The tab shows when something is waiting, or when you are someone who answers requests.",
    },
    {
      term: "You asked",
      meaning:
        "What you asked for that is still waiting, and the runs you asked to have approved.",
    },
    {
      term: "Done",
      meaning:
        "What you asked for that has an answer. The number beside it counts answers you have not seen yet.",
    },
    {
      term: "Something else",
      meaning:
        "A request that names no line from the Roles & permissions tab. You say what you need in your own words, and it can only be marked as done or declined.",
    },
    {
      term: "Allow just them for 24 hours",
      meaning:
        "Lets only the asker use that one line, for the next 24 hours. Their role does not change, and it ends by itself. You can only lend a line you have yourself, and never an Admin-only one.",
    },
    {
      term: "Allow for everyone",
      meaning:
        "Turns the line on for everyone who has the asker's role. The app says how many people that reaches before it changes anything.",
    },
    {
      term: "Give another role",
      meaning:
        "Changes only the asker's role. If the new role does not include what was asked for, the request is marked as done, not allowed.",
    },
    {
      term: "Mark as done",
      meaning:
        "Closes a request you dealt with another way, such as with a new role made on the Admin page.",
    },
    {
      term: "Needs approval",
      meaning:
        "A run someone asked for that is waiting for an approval on Deploy, because the asker's role may not do that run by itself.",
    },
    {
      term: "Ready to run",
      meaning:
        "A run of yours that has been approved, and can be run on Deploy until the approval runs out.",
    },
  ],
  problems: [
    {
      problem: "The thing I need is not in the list.",
      fix:
        "The list holds only what your role can't do yet and an Admin could give. Choose Something else and say what you need.",
    },
    {
      problem: "Nobody has answered my request.",
      fix:
        "The app sends no email. The people who answer see a number beside Requests in the sidebar, so tell them yourself if it is urgent.",
    },
    {
      problem: "I was allowed something for a day, and now it is gone.",
      fix: "A 24 hour allowance ends by itself. Ask again, or ask for the line to be added to your role for good.",
    },
    {
      problem: "My request was allowed, but the button is still switched off.",
      fix: "Reload the page you need it on. A new role or line applies from the next load.",
    },
    {
      problem: "It says I already asked for this, and it is still waiting.",
      fix:
        "The same request is open. Wait for the answer, or withdraw it under Your requests and ask again with more detail.",
    },
    {
      problem: "The asker needs something in between two roles.",
      fix:
        "Make a new role on the Admin page, give it to them on the Users tab, then mark the request as done.",
    },
    {
      problem: "I am an Admin and there is no form to ask with.",
      fix: "Admin can already do everything, so there is nothing to ask for. You only answer requests here.",
    },
  ],
};
