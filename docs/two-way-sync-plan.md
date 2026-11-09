# Two-way sync between the desktop app and a website

Agreed with the user on 2026-11-08. Branch `two-way-sync`, worktree `FYP-main-2-sync`, cut from main at 15dc820.

## Why

Each copy of Schema Studio (the desktop app, the Swinburne Docker server, Vercel) keeps its own database. Signing in with the same Microsoft account proves who you are on each, but a connection added on the desktop never reached the website. The user wants the desktop and the website to match as closely as they can.

## The rules

1. **The website org is the master.** "Link this computer" already ties a desktop to one org on one site (any Schema Studio site, including the client's own server). Once linked, the desktop mirrors that org.
2. **Each connection is edited in one place only.**
   - A connection the website can reach (Neon, Supabase, AWS with a public address) belongs to the website. The desktop holds a copy. Editing it on the desktop sends the change straight to the site. Offline, or with the site down, it is locked: "Offline, can't edit right now." Nothing is queued for later.
   - A connection only this computer can reach (`localhost`, a home or office network) belongs to the desktop. Its password never leaves the computer. The website lists it as "On <computer name>" for its owner, and a compare of it from the website runs on the desktop (the existing linked-computer jobs).
3. **The site decides which is which.** When a connection is added on a linked desktop, the site tests whether it can reach the database. Reached: it is saved on the site. Not reached: it stays on the desktop. A desktop-only connection can be sent to the website later with a button, which runs the same test.
4. **No silent overwrites.** Every save says which version it started from. If someone saved first, the save is turned down with who changed it and when, and the person picks: keep theirs, or save mine on top.
5. **The website's roles count.** Writes from a desktop go through the site's own connection routes, as the linked person, so the site checks their role there. The desktop takes on the person's website role (step 3).

## Decisions made while building (the user can change any of these)

- **Passwords to the desktop.** The site sends a connection's password to a linked desktop only when the person's role there holds "Connections: Update". Without it the connection still shows on the desktop, marked "No password on this computer". Reason: on the desktop the password sits in a database the person can open themselves, so it is only given to people who could already change it.
- **Desktop-only connections on the website are seen by their owner only**, the same as linked computers today. Teammates do not see someone else's laptop databases.
- **Unlinking** removes the website's connections from the desktop (they stay on the website) and keeps the desktop's own.
- **Connections already on a desktop when it links** stay desktop-only. "Send to website" moves one up, after the site has reached the database itself. The desktop's own row becomes the site's copy in place, so its local drift history and saved comparisons stay with it.
- **Test results stay where they ran.** "Last tested" is not synced, because a test from the desktop and a test from the site can honestly disagree.
- **The website role only takes away.** On a linked desktop the person may do what both their desktop role and their website role allow, never more than the desktop role. A website Admin is not held back at all. Refusals name the role as "<role> on the website". The role is kept on the desktop, so it still holds while the website cannot be reached, and a kept role that cannot be read refuses everything (503) until the next sync or an unlink. Unlinking gives the desktop role back in full.
- **Compare screen.** Desktop-only connections show on the website's Connections page. Comparing them from the website stays in the phone app page, which already goes through the desktop. Putting them in the main Compare screen is a later piece.

## Steps

### Step 1: connections sync both ways
- Site: `version`, `updated_at`, `updated_by` on connections; PUT and DELETE take the version they started from and answer 409 with the current row when it moved on. The connection routes accept a linked computer's token, acting as its person in its org. New `GET /api/agent/sync` gives the org's connections and a fingerprint, so an unchanged org costs one small answer.
- Desktop: `site_id` and `site_version` on its connections. The desktop's poll (already every 15 s) also checks the fingerprint and, when it changed, rewrites its copies through a desktop-only route. New bridge calls let the Connections page save, delete, add and send to website through the link. All desktop-only connections are listed on the site for their owner.
- Screens: a "Website" or "This computer" tag on each connection on the desktop, the offline lock, the conflict box on both sides, and the "On <computer>" rows on the website.

### Step 2: drift results and history
The website checks drift on its own connections, and the desktop shows those results. The desktop checks its own connections and sends the results up, so the owner sees them on the website. Neither side checks the other's connections, so nothing is checked twice.

### Step 3: roles and status
The desktop takes on the person's website role while linked, read from the site on each sync. Settings shows a sync status line: linked org, last synced, offline or not, and how many connections each side owns.

Each step is committed after its tests and type checks pass. One run against a local site and a desktop dev build checks all three together at the end. Nothing is pushed until the user says so; main auto-deploys to the Swinburne server.

## Progress

- 2026-11-08: plan written.
- 2026-11-08: step 1 built and committed locally on `two-way-sync`.
  - Site: `version`, `updated_at`, `updated_by` on connections, with the version check and 409 in `lib/connection-writes.ts` shared by the Connections route and the linked computer's routes (`/api/agent/sync`, `/api/agent/sync/connections`). Passwords go down only to roles with Connections: Update. `/api/computers?connections=all` lists each computer's own connections for its owner.
  - Desktop: `src/core/stays-home.ts` keeps home addresses home without asking the site. `cloud-agent.ts` pulls the org's connections when the fingerprint moves and writes them through the desktop-only `/api/desktop/sync` route (main process token only). Five new bridge calls: `syncStatus`, `syncCreate`, `syncUpdate`, `syncRemove`, `syncSendUp`.
  - Connections page: "Website" or "This computer" tag, "No password on this computer", the offline lock and its banner, saves of website connections through the desktop app, the conflict box (keep theirs, or save mine on top; keep it, or delete anyway), "Send to website", and "On your computers" on the website.
  - Checked: type checks, the full web suite, and the desktop's 836 tests. Not yet run live.
- 2026-11-08: step 2 built and committed locally on `two-way-sync`.
  - Each schema is checked in one place only, and only its results travel: at most 5 checks per schema, 200 schemas, summaries cut to 300 characters (`lib/agent-rules.ts`).
  - Site: `agent_connections.drift` holds what a computer checks on its own connections, sent inside its connections list. `GET /api/agent/sync/drift?rev=` sends a linked computer the org's results on the site's own connections, or "nothing changed" for the same fingerprint, and nothing to a role without Drift. The scheduler skips a desktop's copies of website connections, and tracking a schema on a copy is refused with 409.
  - Desktop: `cloud-agent.ts` asks for the site's results every 60 seconds once the site syncs, and again on demand when they are 10 seconds old; a 404 waits 30 minutes, a 401 unlinks. New bridge call `syncDrift`.
  - Drift page: "Checked by the website" in the desktop app (latest result per schema, link to the full diff on the site, offline note), "On your computers" in a browser, and a notice on a schema whose connection now belongs to the website.
  - Checked: type checks, the full web suite (6,315 tests), and the desktop's 845 tests. Not yet run live.
- 2026-11-08: step 3 built and committed locally on `two-way-sync`.
  - Site: each changed sync answer carries the person's role (`lib/site-role.ts`), and the fingerprint includes it, so a role change reaches the desktop at the next sync.
  - Desktop server: `organizations.site_role` keeps the role; `/api/desktop/sync` saves it with the list (null clears it, a role it cannot read is a 400 before anything is written). `lib/auth-guard.ts` holds the default organization to it while linked.
  - Desktop app: a changed list without a readable role is not taken. Unlinking, a 401, and a start with no saved link clear the copies and the role. Settings, Web site, shows a sync line: the website role, when it last synced, how many connections come from the website and how many stay on this computer, and that website connections cannot be changed while it is offline.
  - Checked: type checks, the full web suite (6,347 tests), and the desktop's 849 tests. Not yet run live.
- 2026-11-08: the 9 database suites run on a throwaway PostgreSQL cluster (256 tests pass).
  - They found two things the earlier steps missed: the move tool now clears a connection's `site_id` and `site_version` and the organization's `site_role` when it moves an organization to another database, since those only mean something on the linked desktop; and the agent database test now expects `shared` and `drift`.
  - New: a real-database check that the website role is kept, read back and cleared, and that a kept role it cannot read is refused.
