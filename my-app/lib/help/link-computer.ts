import type { HelpTopic } from "./types";

/** Help for Link a computer. Shown in the Help panel; the blurb is the page header's one line. */
export const linkComputerHelp: HelpTopic = {
  title: "Link a computer",
  blurb: "Link the desktop app on your computer to this organization.",
  purpose:
    "This page links the Schema Studio desktop app on a computer to an organization on the website. A linked computer gets the organization's saved connections, including their passwords, and can answer questions from your account. Connections kept only on that computer are listed on the website by name, and their passwords stay on it.",
  steps: [
    "On the computer, open Schema Studio's Settings, enter the site's address and press Link. The app shows a code and opens this page in your web browser.",
    "Sign in if the site asks you to.",
    "Type the code under Code shown on the computer. Read it off the computer in front of you.",
    "If you belong to more than one organization, pick the right one under Organization. The code has to be typed again there.",
    "Check the computer's name and the time it asked.",
    "Press Link this computer. Press Not mine if you did not start this just now.",
    "Close the page and go back to Schema Studio on the computer.",
  ],
  terms: [
    {
      term: "Code",
      meaning:
        "Eight letters and numbers that the desktop app shows in its Settings. It works for 10 minutes. The page's address never fills it in, so a link someone sent you cannot link their computer.",
    },
    {
      term: "Linked computer",
      meaning:
        "A computer whose desktop app is joined to an organization. It can open that organization's saved connections.",
    },
    {
      term: "Not mine",
      meaning: "Turns the computer away. Nothing is linked and its code stops working.",
    },
    {
      term: "Unlink",
      meaning:
        "Ends a link. It is on the Connections page under On linked computers, and in the computer's own Settings. An Admin can unlink any computer, for instance one that was lost.",
    },
  ],
  problems: [
    {
      problem: "The page says the code has expired or is not right.",
      fix: "A code works for 10 minutes. Press Link again in the desktop app's Settings and type the new code.",
    },
    {
      problem: "The page says a code has eight letters and numbers.",
      fix: "Part of the code is missing. Type all eight characters. The dash in the middle is optional.",
    },
    {
      problem: "The page refuses to link the computer.",
      fix: "Linking needs a role that may compare schemas. Ask an Admin of the organization for it.",
    },
    {
      problem: "Someone sent me a code and asked me to type it.",
      fix: "Do not type it. Only link a computer you are sitting at, because a linked computer can read the organization's database passwords.",
    },
    {
      problem: "A computer that was linked no longer is.",
      fix: "A link ends by itself when the computer has not been used with the site for 90 days. Link it again the same way.",
    },
  ],
};
