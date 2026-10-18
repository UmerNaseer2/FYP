# Week 7 demo: roles and permissions

The client asked (feedback F3) for an admin to decide, for each role and each
feature, which of create, read, update and delete that role may do. This script
walks through that in about ten minutes. Every quoted string below is what the
screen says, word for word, so the demo can be checked against it as it runs.

The full reference is section 11 of the user manual,
`docs/user-manual/schema-studio-user-manual.txt`.

## Before the demo

- Sign-in is off for testing (`NEXT_PUBLIC_AUTH_BYPASS=true`), and the sidebar
  shows the "auth off" pill. View as is only there while sign-in is off.
- The sidebar is expanded. View as sits under your name and is left off the
  collapsed rail.
- View as reads "Admin (everything)".
- The guide at the top of Admin, "How roles and permissions work", is open. A
  browser remembers it being folded, so if a rehearsal folded it, click its
  heading to open it again.
- At least two saved connections. One of them will be marked read-only for a
  minute in part 5, so pick one nobody deploys to, such as a reference schema.
- No role called QA Lead yet. If one is left from a rehearsal, open it on
  Admin > Roles & permissions and press "Delete role".
- Viewer and Editor are at their defaults. "Reset to default" is switched off
  for a role that already is.
- Optional, for part 6: a connection labelled Production, with a schema that
  has migrations waiting to be deployed.

## 1. The grid (2 minutes)

1. Open Admin from the sidebar. The page is "Users and roles", with two tabs,
   "Users" and "Roles & permissions". Above them is the guide, "How roles and
   permissions work": the steps to set up a role, what each box means, and the
   rules worth knowing. Say it is there for whoever looks after the page after
   the demo, then click its heading to fold it. It stays folded in this
   browser.
2. On "Users", point at the note that sign-in is off for testing. With real
   sign-in, this is where each person is given a role.
3. Open "Roles & permissions". Each role is a pill with the number of people
   who have it: Viewer, Editor and Admin are built in.
4. Pick Admin. The note reads "Admin can always do everything": every box is
   ticked and none of them can be changed, so nobody can lock every admin out.
5. Pick Viewer. Only Read is ticked, and the Users and Roles & permissions rows
   read "Admins only", because no other role may manage people or roles. Hover
   a box: the tooltip says what it allows, for example "Add a connection".

Say: the columns are Create, Read, Update and Delete, plus Run and Approve for
the features that have them. The server checks the box on every request; the
screen only follows what the server will allow.

## 2. Make a role (2 minutes)

1. Press "New role".
2. Name: `QA Lead`. Start from: "A copy of Viewer". Description: `Checks
   releases on staging`.
3. Press "Create role". The notice reads "Created QA Lead. Change its boxes
   above if needed, then give it to people on the Users tab."
4. Show the Read rule on the Connections row: untick Read, and the whole row
   clears. Tick Create, and Read comes back with it, because nothing on a
   feature can be reached without opening it.
5. Untick Read on the Visualizer row.
6. The bar at the bottom reads "2 unsaved changes to QA Lead", and the QA Lead
   pill has a dot after its name. Press "Save changes". The notice starts
   "Saved 2 changes to QA Lead. They apply straight away".

QA Lead can now add a connection, but not edit, test or delete one, and cannot
open the Visualizer at all. That is the client's example: a role that may
create and read, but not update or delete.

## 3. See the app as QA Lead (3 minutes)

1. In the sidebar, under your name, set View as to QA Lead. The page reloads,
   and from now on every screen and the server treat you as QA Lead.
2. Admin and Visualizer have gone from the sidebar. Type `/visualizer` into the
   address bar: the page reads "Your role (QA Lead) can't open this page."
3. Open Connections. "Add connection" works. The edit, test and delete buttons
   on each row are switched off, and the note under the header says why, once
   for the whole page rather than on every row:

   > Your role (QA Lead) can't edit or test a saved connection. Ask an admin to
   > allow "Connections: Update" for this role.
   >
   > Your role (QA Lead) can't delete a connection. Ask an admin to allow
   > "Connections: Delete" for this role.

4. Open Deploy and pick a connection under Target. The line under it reads:

   > Running migrations against "(the connection's name)" needs a role that may
   > run deployments, and yours ("QA Lead") may not. Ask an admin to allow
   > "Deploy: Run" for your role.

5. Optional: set View as to Viewer, open Connections, and point at "Add
   connection", switched off, with the note `Your role (Viewer) can't add a
   connection. Ask an admin to allow "Connections: Create" for this role.`
6. Set View as back to "Admin (everything)". The page reloads and Admin is back
   in the sidebar.

## 4. Recent changes (1 minute)

1. Open Admin > Roles & permissions and scroll to "Recent changes".
2. The newest line is the save, "changed what QA Lead can do", with "Gave:
   Connections: Create" and "Took away: Visualizer: Read" under it. The line
   below it is "created QA Lead (copied from Viewer)". Each line names who did
   it and when.

## 5. A database nobody may write to (1 minute)

1. Open Connections and edit the connection picked before the demo.
2. Set "Who may run migrations here" to "Read-only: nobody may run migrations
   here" and press "Save changes". The row now has a "Read-only" badge.
3. Open Deploy and pick it under Target. Even as Admin, the line under it reads
   "Marked read-only on Connections" and nothing will run against it, not a
   deploy and not a dry run. Comparing and exporting still work.
4. Put the setting back to "Anyone whose role may run deployments" and save.

Say: this is a setting on the database, not on a role, so it holds for
everyone, admins included. A reference schema that others are compared
against should never be written to by mistake.

## 6. Optional: a production approval (2 minutes)

1. On Deploy, pick the Production connection, its schema and the migrations to
   run, and tick the boxes the checklist asks for. The line under the buttons
   then reads "Deploy on production needs an approval", and a dry run does
   not.
2. Press "Request approval". With sign-in off there is only one person, so the
   toast says you clear it yourself.
3. Press "Approve this run". The deploy button is now enabled for that exact
   SQL, for up to 7 days.

Say: with real sign-in, the person who asked cannot approve their own request.
Approving needs "Approvals: Approve", which only Admin has out of the box, and
an admin can give it to another role.

## Clean up

- Admin > Roles & permissions > QA Lead > "Delete role", then "Delete role"
  again in the dialog. It was never given to anyone, so nobody loses access.
- Check the connection from part 5 is back to "Anyone whose role may run
  deployments".
- View as reads "Admin (everything)".
- The guide at the top of Admin is open again, ready for the next run.

## If something goes wrong

- Stuck viewing the app as a role: set View as to "Admin (everything)". It
  works even when the app's database is not answering.
- View as is missing: the sidebar is collapsed, or sign-in is on.
- A message starting "Could not check": the app's own database did not answer,
  so no box is missing. Wait a moment and reload.
- A button is switched off with no reason on screen: hover it. The tooltip
  names the box an admin would need to tick.

## Numbers worth knowing

- 14 features and 35 boxes in the grid.
- Every box brings Read with it, and unticking Read clears the row.
- Users and Roles & permissions belong to Admin alone, so no role can make
  itself an admin.
- Every save, every role made or deleted, and every role given to someone is
  listed under Recent changes.
