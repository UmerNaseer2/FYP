import type { HelpTopic } from "./types";

/** Help for Admin. Shown in the Help panel; the blurb is the page header's one line. */
export const adminHelp: HelpTopic = {
  title: "Admin",
  blurb: "Manage people, roles, the organization, GitHub and AI settings.",
  purpose:
    "Admin is where you decide who is in this organization, what each role may do in it, and how it is run. " +
    "It has up to five tabs, and each tab shows only to a role allowed to see it. " +
    "On a new install that is the Admin role alone.",
  steps: [
    "Open Admin from the sidebar and pick a tab. You see only the tabs your role may open.",
    "On Roles & permissions, pick a role or press New role, turn on what it may do, then press Save changes.",
    "On Users, give each person a role with the role picker. The change applies straight away.",
    "Under the list of users, make an invitation, then copy its link and send it yourself. The app sends no email.",
    "On Organization, rename the organization or switch its two-person rule for production deploys.",
    "On GitHub, save the repository and the access token for where the organization's scripts are kept.",
    "On AI, switch AI assistance on if you want it, then switch single features on or off.",
    "Check your work under Recent changes, at the bottom of Roles & permissions. It lists who changed what.",
  ],
  terms: [
    {
      term: "Role",
      meaning:
        "A named set of things a person may do. Viewer, Editor and Admin are built in, and an Admin can make more.",
    },
    {
      term: "Line",
      meaning:
        "One thing a role may do, written as a sentence with a tick box, such as Add a connection. " +
        "Refusals and access requests name a line exactly as it reads on the Roles & permissions tab.",
    },
    {
      term: "At a glance",
      meaning:
        "Four quick answers about a role: whether it changes things, runs migrations, approves production and manages people.",
    },
    {
      term: "Rank rule",
      meaning:
        "You can't give, change or remove a role that can do something your own role can't. " +
        "Only Admin can give or take away the Admin role.",
    },
    {
      term: "Last admin",
      meaning:
        "The only person left with the Admin role. They can't be given another role or removed until someone else is made an admin.",
    },
    {
      term: "Invitation",
      meaning:
        "A link that lets someone join. One made for an email address works once, within 7 days, for that address only. " +
        "An open link lets anyone who has it join as a Viewer for 1, 7 or 30 days.",
    },
    {
      term: "Two-person rule",
      meaning:
        "Off unless an admin switches it on. While it is on, a production deploy or rollback waits for someone other than the person who asked.",
    },
    {
      term: "Access token",
      meaning:
        "A key made on GitHub that lets the app read and write the scripts repository. It is stored encrypted and never shown again.",
    },
    {
      term: "Own AI key",
      meaning:
        "One AI service key saved for the whole organization. It is used in place of the server's AI settings.",
    },
    {
      term: "View as",
      meaning:
        "A picker in the sidebar that shows the app as another role. It is there only while sign-in is switched off for testing.",
    },
  ],
  problems: [
    {
      problem: "I can't see Admin in the sidebar, or a tab is missing.",
      fix:
        "Each tab shows only to a role allowed to see it. Roles & permissions, Organization and AI are for Admin only. " +
        "Ask an admin, or send a request on the Requests page.",
    },
    {
      problem: "A person's row has no role picker or remove button.",
      fix:
        "Either it is your own row, which reads Your account, or their role can do something yours can't (the rank rule). " +
        "Ask an admin to make the change.",
    },
    {
      problem: "It says: This is the last admin. Promote someone else first.",
      fix:
        "Make somebody else an admin first, then ask them to change your role. The last admin can't be removed either.",
    },
    {
      problem: "Delete role is switched off.",
      fix:
        "Someone still has the role. Give them another role on the Users tab first. The built-in roles can't be deleted.",
    },
    {
      problem: "The person I invited never got an email.",
      fix:
        "The app sends no email. The link is shown once, when you make the invitation: copy it then and send it yourself. " +
        "If you missed it, cancel that invitation under Waiting to be taken and make a new one.",
    },
    {
      problem: "The GitHub tab says the saved token can't be read, or the token stopped working.",
      fix:
        "The server's encryption key changed, or the token passed the end date picked when it was made. " +
        "Make a new token on GitHub and paste it on the GitHub tab. " +
        "If the repository belongs to a GitHub organization, that organization may have to approve the token first.",
    },
  ],
  sections: [
    {
      title: "Users tab",
      body: [
        "Lists everyone in this organization, with a role picker and a remove button for each person you may manage.",
        "Removing someone takes away their access here at once. Their sign-in account is not touched, and they come back only through a new invitation or a join link that is still open.",
        "While sign-in is off for testing, everyone using the app is the same stand-in admin, so nobody new is added. The people listed signed in before, and the roles you give them apply when sign-in is back on.",
      ],
    },
    {
      title: "Inviting people",
      body: [
        "To an email address: pick the role they will get. Only someone who signs in with that address can take it, once, within 7 days.",
        "As a link: anyone who has it can join as a Viewer until it runs out or is cancelled, so send it only to people you mean to let in.",
        "Invitations nobody has taken yet are listed under Waiting to be taken, each with Cancel invitation.",
      ],
    },
    {
      title: "Roles & permissions tab",
      body: [
        "Every role has a card. One role shows a role's lines so you can change them. Compare roles shows every role side by side, from what is saved, and only shows.",
        "Turning a line on also turns on its feature's see or open line. Turning a see or open line off also turns off the lines under it. Undo puts everything back.",
        "Admin can always do everything. Its lines can't be changed, so that nobody can lock every admin out of this page.",
      ],
    },
    {
      title: "Setting up a role",
      body: [
        "1. Pick a role, or make a new one.",
        "2. Turn on what it may do, then press Save changes.",
        "3. Give it to people on the Users tab.",
        "4. While sign-in is off for testing, check it with View as on the sidebar.",
      ],
    },
    {
      title: "Recent changes",
      body: [
        "At the bottom of Roles & permissions: changes to roles, to who has them and to the organization, newest first, with who made each one.",
        "Roles made or deleted, lines turned on or off, roles given to people, invitations, people removed and changes to the organization all show there.",
      ],
    },
    {
      title: "Organization tab",
      body: [
        "Name: the address stays the same when the name changes, so saved links keep working.",
        "Two-person rule: off to start with, so anyone whose role allows a run just does it. While it is on, real runs on production need a second person's approval.",
        "Delete this organization: type its name to confirm. It can't be undone. People's accounts stay, and so do scripts already in GitHub.",
      ],
    },
    {
      title: "GitHub tab",
      body: [
        "Repository: type it as owner/name, or paste its address from GitHub.",
        "Access token: it is stored encrypted and never shown again, here or anywhere else. Leave the box blank to keep the saved one.",
        "Save checks the repository and the token with GitHub first. If the repository does not exist yet, the app makes it with the same token, as a private repository with a README. Remove takes the settings away, and scripts already in the repository stay there.",
      ],
    },
    {
      title: "Making an access token",
      body: [
        "1. On GitHub, open Settings, then Developer settings, then Personal access tokens, then Fine-grained tokens, and choose Generate new token.",
        "2. Under Repository access, choose Only select repositories, and pick the repository.",
        "3. Under Permissions, set Contents to Read and write. The app needs nothing else.",
        "4. Generate the token, copy it, and paste it on the GitHub tab.",
        "If the repository does not exist yet and you want the app to make it: in step 2 choose All repositories instead, and in step 3 also set Administration to Read and write. A repository can't be picked in step 2 before it exists. For a repository under an organization, choose that organization as the token's Resource owner.",
        "A token stops working on the date you pick when you make it. When it does, make a new one and paste it in.",
      ],
    },
    {
      title: "AI tab",
      body: [
        "AI assistance is off until an Admin switches it on. It needs an AI service: one set up on the server, or the organization's own key.",
        "While it is on, roles with Use AI assistance see the AI buttons on Compare, Deploy, Drift and the Script Editor, and Ask AI in the top bar.",
        "What is sent: table, column, index, constraint and view definitions, and the SQL of the scripts being reviewed. Never rows of data, passwords, connection addresses or anyone's details.",
        "The app checks every answer against its own engine before showing it, and nothing the AI writes runs without someone approving it.",
      ],
    },
    {
      title: "Organization AI key",
      body: [
        "Pick the service, paste the API key and press Save key. Leave the model names empty to use the ones shown.",
        "The key is not tried when you save it. If the service turns it down, the AI buttons say so the first time someone uses them.",
        "Every AI call for this organization then goes to that service with that key, and is billed to that account. Remove key goes back to the server's settings.",
      ],
    },
    {
      title: "AI use figures",
      body: [
        "Each request to the AI service is one call, a retry or a switch to the other model included.",
        "Saved answers cost nothing: the same question about the same schema is answered from the last checked answer for seven days.",
        "Failed counts calls that gave no usable answer: the service was busy, out of its free allowance or too slow, or the answer did not pass the app's checks.",
      ],
    },
    {
      title: "View as (testing)",
      body: [
        "While sign-in is off for testing, pick a role under your name in the sidebar. Every screen, and the server too, then treats you as that role.",
        "Pick Admin (everything) to go back. With real sign-in, View as is not there.",
      ],
    },
  ],
};
