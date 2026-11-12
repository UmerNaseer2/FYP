import type { HelpTopic } from "./types";

/** Help for Phone and desktop. Shown in the Help panel; the blurb is the page header's one line. */
export const devicesHelp: HelpTopic = {
  title: "Phone and desktop",
  blurb: "One workspace, three ways in: the website, the desktop app and the phone app.",
  purpose:
    "This page explains the three ways into Schema Studio and how they share one organization. The website holds the organization. The desktop app is the same Schema Studio on an Ubuntu computer, with its own database for connections you keep at home. The phone app is a small version of the website for checking drift and answering requests while you are away.",
  steps: [
    "Pick a tab: Phone app, Desktop app or Sync.",
    "For the phone, open the phone app on your phone's web browser and sign in with the same account.",
    "For the desktop app, open its Settings on the computer, enter this site's address and press Link. Then type the code it shows on the Link a computer page.",
    "Read the Sync tab to see what the website decides and what stays on a computer.",
  ],
  terms: [
    {
      term: "Phone app",
      meaning:
        "Five small screens for a phone: Drift, History, Approvals, Compare and Alerts. It reads from the website and never holds a database password.",
    },
    {
      term: "Desktop app",
      meaning:
        "Schema Studio installed on an Ubuntu computer. It can reach databases that only that computer can reach.",
    },
    {
      term: "Linked computer",
      meaning:
        "A computer whose desktop app is joined to this organization. It gets the organization's saved connections and can run a compare your phone asks for.",
    },
    {
      term: "Cloud connection",
      meaning: "A connection saved on the website. Every linked computer gets a copy.",
    },
    {
      term: "Local connection",
      meaning:
        "A connection saved only in the desktop app. The website lists its name, and its password stays on that computer.",
    },
  ],
  problems: [
    {
      problem: "The Desktop app tab shows no computers.",
      fix: "No computer is linked yet, or your role may not see connections. Link one from the desktop app's Settings, or ask an Admin.",
    },
    {
      problem: "A computer shows as Offline.",
      fix: "Its desktop app is closed, asleep or has no internet. Open Schema Studio on that computer and it comes back by itself.",
    },
    {
      problem: "The phone cannot run a compare.",
      fix: "A compare runs on one of your own linked computers, so one of them has to be on. Drift, History, Approvals and Alerts work with every computer off.",
    },
    {
      problem: "A cloud connection cannot be changed in the desktop app.",
      fix: "The computer cannot reach the website right now. Cloud connections unlock again when it can.",
    },
  ],
  sections: [
    {
      title: "Who wins when two copies differ",
      body: [
        "The website is the master. Members, roles, versions and cloud connections come from it.",
        "Cloud connections lock in the desktop app while the computer is offline, so two people cannot change the same one in two places.",
        "Local connections stay on their computer. The website lists them by name only.",
      ],
    },
  ],
};
