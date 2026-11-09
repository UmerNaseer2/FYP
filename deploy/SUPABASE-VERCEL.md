# Running Schema Studio on Supabase and Vercel

> **Run on real accounts.** Sections 1 to 5 and 7 have run on a real Supabase project and a real Vercel project, with a real Microsoft sign-in. Section 6 has run on one computer, with a local PostgreSQL standing in for Supabase, and not yet on Swinburne's server. Section 8 has run in a desktop browser with a real push, but not yet on a real phone. Section 9 has run against a copy of the site on one computer, with the desktop app's linking code run outside the app, and not yet on Vercel. Section 10 has run on test databases and a real desktop backup, and as a trial into a real Supabase project.

The web app runs on Vercel. Its own data (people, roles, saved connections, history) lives in a Supabase project, used as an ordinary PostgreSQL database. It is the same code as the Docker deployment in [README.md](README.md), set up through environment variables. Sign-in stays with Microsoft (and GitHub if you want it) through NextAuth. Supabase Auth is not used.

## What this setup cannot do

- **Reach a private database.** Vercel runs on the public internet, so a database on a private network cannot be compared or tracked from here. Use the Docker copy for those.
- **Promise an outbound address.** Vercel's outbound addresses are not fixed by default, so a database that only accepts listed addresses will refuse the app.
- **Return more than 4.5 MB.** That is Vercel's limit for a function's request or response body, and the app does not stream. A very large compare result fails with an error.
- **Run for long.** A function stops at 300 seconds. Pro can raise that to 800 in the project's settings, and the free plan cannot. A long compare or deploy is cut off at that point, so run those from the Docker copy.

## 1. Create the Supabase project

1. Create a project in the same region as your Vercel functions, because every request makes several database calls and distance adds up. Vercel's default is Washington, D.C. (`iad1`, which is `us-east-1` in Supabase). If your people are far from there, put both near them, for example Singapore: `ap-southeast-1` in Supabase and `sin1` under **Settings**, **Functions**, **Function Regions** in Vercel. A project that already exists stays where it is, so match Vercel to it instead, for example Sydney: `ap-southeast-2` in Supabase and `syd1` in Vercel.
2. Press **Connect** and copy the **Transaction pooler** string (port 6543). This is `DATABASE_URL_A`. The direct address is IPv6 unless you buy the IPv4 add-on, and the pooler is what Supabase recommends for serverless. The app keeps no session state, so it works behind it.
3. Leave the database's time zone at UTC.
4. Turn off the **Data API** in its settings in the Supabase dashboard. The app talks to PostgreSQL directly and never uses it. While it is on, Supabase serves the `public` schema over the internet to anyone with the project's public key, limited only by that role's grants, and tables made outside the dashboard (as the app's are) do not get row level security on their own.

The app also turns on row level security for its own tables, with no policies, whenever it finds Supabase's `anon` role. Those roles then see no rows even if the Data API stays on. The app is not affected, because a table's owner is exempt.

That is why every copy must connect as the same database user: the app creates its tables on first start and has to own them.

If the project already holds tables from an older copy of the app, move them to another schema before the first start (`ALTER TABLE ... SET SCHEMA`), and remove any trigger on `auth.users` that writes into them. Otherwise the app would try to upgrade tables it did not make, and anyone signing up through Supabase Auth with the project's public key could add rows to them.

## 2. Create the Vercel project

1. Import the repository and set **Root Directory** to `my-app`. The Next.js defaults are right for everything else.
2. Leave **Fluid Compute** on. The route that wakes the drift checker asks for 300 seconds.
3. Leave **Enable access to System Environment Variables** on. The app reads `VERCEL_DEPLOYMENT_ID` so that it sets up its tables once per deployment. Without it everything still works, but every cold start sends about 130 statements first.
4. Add these environment variables:

| Name | Value |
|---|---|
| `DATABASE_URL_A` | The transaction pooler string from step 1. |
| `NEXTAUTH_SECRET` | A new random value: `openssl rand -hex 32`. |
| `APP_ENCRYPTION_KEY` | A new random value: `openssl rand -hex 32`. It encrypts saved database passwords. Every copy of the app on this database needs the same one, and losing it means entering those passwords again. |
| `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `AZURE_AD_TENANT_ID` | From the Azure app registration. `AZURE_AD_ANY_ACCOUNT` is described in `my-app/.env.local.example`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Only for GitHub sign-in. |
| `GITHUB_PAT`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME` | The repository that holds the script registry. |
| `NEXT_PUBLIC_AUTH_BYPASS` | `false` |
| `CRON_SECRET` | A new random value: `openssl rand -hex 32`. Under 32 characters, the route refuses every call. |
| `DRIFT_CALL_MINUTES` | `15` on the free plan: the minutes between the scheduled calls in step 5. Blank means every minute. |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL_FAST`, `AI_MODEL_SMART` | Only for AI help, as "Optional lines" in [README.md](README.md) describes. Each organization still starts with AI off until its Admin switches it on in Admin, AI. |

Leave `ALLOW_PRIVATE_DB_HOSTS` unset, because there is no private network to reach from here. Leave `DRIFT_SCHEDULER` blank, because on Vercel a blank value means a scheduled call wakes the checker.

Do not set `NEXTAUTH_URL` or `AUTH_URL`, and delete an old one from a project that already exists. The sign-in library uses it in place of the request's own address, so a stale value sends sign-in to the wrong site, and previews would all use it too.

## 3. Add the sign-in addresses

Add these to the provider, using your site's production address:

- Microsoft, in the Azure app registration, under the **Web** platform: `https://<your-site>/api/auth/callback/microsoft-entra-id`. Under any other platform Microsoft refuses the client secret, and sign-in fails with `invalid_client` in the logs and "Sign-in failed or was cancelled" on the screen.
- GitHub, in the OAuth app: `https://<your-site>/api/auth/callback/github`

Preview deployments have addresses of their own, so sign-in works there only if you list those too.

## 4. Deploy and sign in

Deploy, then open the site and sign in. The first request of a new deployment creates or updates the tables, which is about 130 statements. That should take a few seconds with the app and the database in the same region, and over a minute from far away: 79 seconds on an empty project at about 290 ms a round trip.

## 5. Schedule the drift checker

A serverless host keeps no process running, so the checker's usual timer has nothing to run in. Something outside has to call it on a schedule. Vercel's own cron runs once a day at most on the free plan, so this uses `pg_cron` inside Supabase.

The schedule below calls every 15 minutes, which is right for the free plan. Step 7 says why. On Pro, use `* * * * *` and leave `DRIFT_CALL_MINUTES` blank. Keep the two matched, because the server cannot see the schedule and would read slow calls as calls that have stopped.

Run this in the Supabase SQL editor, with your own values:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<the CRON_SECRET value>', 'drift_tick_secret');

select cron.schedule(
  'schema-studio-drift-tick',
  '*/15 * * * *',
  $$
  select net.http_get(
    url := 'https://<your-site>/api/internal/drift-tick',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'drift_tick_secret')
    ),
    timeout_milliseconds := 5000
  );
  $$
);
```

Use the production address, since deployment protection can stop a call to a deployment's own address.

Open the **Schedule** screen after the first call. It should read **Running** and say a scheduled call wakes the server every 15 minutes. If it says no call has arrived, ask Supabase what happened:

```sql
select status_code, timed_out, error_msg from net._http_response order by created desc limit 5;
```

- `202` is right.
- `401` means the secret in the vault does not match `CRON_SECRET`.
- `503` means `CRON_SECRET` is missing or too short on Vercel.

Supabase's documentation warns that any database role that can log in can read the decrypted secret in `net.http_request_queue` while a request waits. This secret can only wake the checker, which does nothing for schemas that are not due, but it is a reason to keep the list of login roles short.

To stop the calls:

```sql
select cron.unschedule('schema-studio-drift-tick');
```

Checks run only when a call comes, so a schema is never checked more often than that, whatever its cadence says. A schema that falls due within half a gap is checked on this call rather than nearly a whole gap late, so a 15 minute cadence means every call and not every other one. Each call checks at most 6 schemas, so calls 15 minutes apart mean at most 24 checks an hour, and the rest wait for a later call.

## 6. Sharing the database with the Docker copy

The Docker copy (such as the one on Swinburne's server) can use this same database. Both then show the same organizations, people, roles and cloud connections. Connections to the server's own databases stay on the server: everyone sees them by name, marked "Lives on Swinburne server", but their passwords never leave it and they only work from there.

| Connection | Password kept in | Works from |
| --- | --- | --- |
| Cloud (Neon, Supabase, AWS and so on) | this database | every copy and the desktop app |
| Local on the server (`localhost`, private addresses) | the server's own `db` container | the server copy only |
| Local on a laptop | that laptop's desktop app | that desktop app only |

The connection form guesses from the address: `localhost` or a private address is local. The switch **Only this machine can reach it** overrides the guess.

**Before you start**

- The organization already exists on this site, and everyone who uses the server copy is a member of it here, with the right role. People and roles come from this database from now on, so someone who was only on the server copy is invited here once.
- The server can reach this database: `nc -zv <the pooler's host> 6543` reports it open.
- Write down the server's current `APP_ENCRYPTION_KEY` (or its `NEXTAUTH_SECRET` if it never set one). The move below needs it to open the old passwords.

**1. Move the server's old connections, once.** `my-app/scripts/move-connections.cjs` copies them from the server's own database into the organization here:

- A connection the site already has (same host, port, database and user) is skipped, so running it twice adds nothing.
- Local connections get their passwords saved in the server's own store. Cloud ones are locked with this site's key.
- History, tracked schemas and compare runs stay in the old database. Nothing there is changed, so it stays as a backup.

On the server, in `~/FYP/my-app` with its packages installed (`npm ci` once), put the secrets in a file outside the repository, for example `~/move.env`:

```text
MOVE_FROM_URL=postgres://studio:<POSTGRES_PASSWORD>@127.0.0.1:5433/studio?sslmode=disable
MOVE_FROM_KEY=<the server's old APP_ENCRYPTION_KEY>
MOVE_TO_URL=<this site's DATABASE_URL_A>
MOVE_TO_KEY=<this site's APP_ENCRYPTION_KEY>
MOVE_MACHINE_NAME=Swinburne server
```

The first line is the server's `db` container, as the server itself reaches it (use the `POSTGRES_USER` and `POSTGRES_DB` from `.env` if it changed them from `studio`). Local passwords are saved there too. A server that never set `APP_ENCRYPTION_KEY` gives `MOVE_FROM_NEXTAUTH_SECRET` instead of `MOVE_FROM_KEY`. `MOVE_MACHINE_NAME` must match `LOCAL_MACHINE_NAME` below exactly.

Try it. Without `--apply` it does the whole copy and then undoes it:

```bash
set -a; . ~/move.env; set +a; node scripts/move-connections.cjs --org <the organization's address>
```

It prints how many connections it would copy and skip, and never a host or password. Run it again with `--apply` added, then delete `~/move.env`. Add `--into <address>` when the organization has a different address on this site.

**2. Point the server copy here.** Add these lines to `.env` in `~/FYP` with `nano .env`, replacing the old `APP_ENCRYPTION_KEY` line:

```text
DATABASE_URL_A=<this site's DATABASE_URL_A>
APP_ENCRYPTION_KEY=<this site's APP_ENCRYPTION_KEY>
LOCAL_DATABASE_URL=postgres://studio:<POSTGRES_PASSWORD>@db:5432/studio?sslmode=disable
LOCAL_MACHINE_NAME=Swinburne server
```

`LOCAL_DATABASE_URL` is the same `db` container, as the app container reaches it. If this site never set `APP_ENCRYPTION_KEY`, its passwords are locked with its `NEXTAUTH_SECRET`: leave `APP_ENCRYPTION_KEY` out on the server and give it this site's `NEXTAUTH_SECRET` instead. Keep `ALLOW_PRIVATE_DB_HOSTS=true` and leave `DRIFT_SCHEDULER` blank: the server is the only copy that can check its own databases for drift. A cloud connection is still checked once, by whichever copy gets to it first.

Then run `docker compose up -d`. No rebuild is needed. Sign in on the server copy: it now shows this site's organizations and connections, with the server's own ones ready to use. If you run the move again later, run `docker compose restart app` afterwards so the app reads the new passwords.

**Good to know**

- The desktop app needs nothing new. It links to this site, as section 9 explains, and gets the cloud connections from here. It never gets this database's address.
- `deploy/backup.sh` still saves the server's own `db`: the old data and the local passwords. This database is backed up by Supabase (its dashboard, **Database**, **Backups**).
- To go back, remove the four lines from `.env` (put the old `APP_ENCRYPTION_KEY` back) and run `docker compose up -d`. The server copy is then exactly as it was before step 2.
- A copy without `LOCAL_DATABASE_URL` keeps every password in `DATABASE_URL_A`, as before. The client's container image works that way.

## 7. Staying inside the free plans

Both free plans can run this, with limits worth knowing first.

**Vercel Hobby**

- The plan is for non-commercial, personal use only, so a rollout for a real organization belongs on Pro.
- A month allows 4 hours of Active CPU, 360 GB-hours of provisioned memory and 1,000,000 function calls. Treat these as shared by every project on the account.
- Go over and, in most cases, you wait until 30 days have passed before you can use that feature again.
- A call every minute is 43,200 calls a month, which leaves 333 ms of CPU for each one even with nothing else on the account running. Time spent waiting on a database does not count as CPU, but a cold start does, and it can cost more than that. So every minute risks the whole allowance.
- A call every 15 minutes is 2,880 calls a month. At a full second of CPU each, which is an estimate and not a measurement, that is 0.8 hours, a fifth of the allowance.
- Look at **Usage** in the Vercel dashboard after a day or two. If Active CPU climbs too fast, slow the schedule down and change `DRIFT_CALL_MINUTES` to match.
- A Docker copy on the same database can run the checker instead (step 6). Leave the `pg_cron` call out, and Vercel spends nothing on it.
- A linked computer (section 9) asks the site for work every 15 seconds while its desktop app runs. That is 240 calls an hour, or about 57,600 a month for one left on 8 hours a day: under 6% of the call allowance each. A call is a token check and one short query, but its CPU has not been measured, so watch **Usage** once a few computers are linked, and unlink the ones nobody uses.

**Supabase Free**

- You get two free projects, each with 500 MB of database size and a fixed 2 GB disk.
- A project without enough database activity over a week gets paused, and that stops sign-in, the app and the scheduled calls together. Supabase emails a warning first, and you restore the project from its dashboard. Its documentation says a few requests a day are typically enough. The scheduled calls read the database, so they should count, but nobody has yet watched this over a week.

## 8. The phone app

The site has a phone app of its own at `/phone`, on the same address, for example `https://your-project.vercel.app/phone`. It reads from the database in Supabase, so it keeps working with every computer off. Sign in with the same Microsoft account as the full site. The way in from the full site is the link on the Requests page.

| Tab | What it does |
| --- | --- |
| Drift | Each tracked schema's last stored result. Check now and Acknowledge, for people allowed to. |
| History | What changed lately. |
| Compare | Compare two schemas on a linked computer (section 9), and unlink a computer. |
| Approvals | Read a run's SQL, then approve or reject it. Answer access requests. Starting the run stays on the full site. |
| Alerts | Turn alerts on for this device, and send a test alert. |

There is nothing to set up on Vercel or Supabase. The app makes its own push key the first time someone turns alerts on and keeps it encrypted in the database.

To use it on a phone:

1. Open the address and sign in. Sign in at the production address only, as in section 3.
2. Add it to the Home Screen. On an iPhone or iPad, in Safari, tap Share, then Add to Home Screen, and open it from there. iOS only shows alerts from the Home Screen, from iOS 16.4 on. On Android, in Chrome, open the menu and choose Add to Home screen.
3. Open Alerts, tap Turn on, allow notifications, then tap Send a test alert.

Two things to expect:

- From Vercel, a database on a private network cannot be reached, so its drift checks read "The last check could not reach this database." Only databases reachable from the internet get checked from here.
- This is separate from the phone link in the desktop app, which reaches one running computer through the relay.

## 9. Linked computers

The site cannot reach a database on someone's laptop or office network, and it never holds that database's password. A computer running the desktop app can be linked to the site instead. The phone app's Compare tab can then compare the schemas on that computer's connections, while the passwords stay on the computer.

To link one:

1. In the desktop app, open **Settings**. Under **Phone**, in **Connections phones may see**, choose which connections to share. A connection is not shared until someone says so.
2. Under **Web site**, type the site's address, for example `https://your-project.vercel.app`, and press **Link**.
3. The computer's web browser opens the site. Sign in there as usual, check that the site shows the same code as the desktop app, and approve it. The code lasts 10 minutes.

There is nothing to set up on Vercel or Supabase for this.

How it works, and what it means:

- The site cannot call the computer, since most computers sit behind a router. So the computer asks the site for work every 15 seconds, and every 2 seconds for 2 minutes after some arrives. Section 7 says what that costs.
- Approving gives the computer a token of its own. The site keeps only a hash of it, and the computer never sees anyone's Microsoft sign-in.
- The computer answers only two kinds of question, listing schemas and comparing them, and both change nothing. It answers as the person signed in to the desktop app, so a role that may not compare is refused the same way as on the computer.
- The site learns each shared connection's name and environment, and never its host, user, password or database name.
- Answers pass through the site and its database, so unlike the desktop app's own phone link they are not encrypted end to end. They hold schema names and a summary of the changes, with no SQL, no hosts and no rows. The site deletes them within about 25 minutes.
- A computer runs at most 3 questions at once, and a question nobody answers is given up on after a few minutes.
- One person can link up to 10 computers. Linking an 11th unlinks their oldest.

To unlink a computer, press **Unlink** in the desktop app's Settings, or **Unlink this computer** in the phone app's Compare tab, for example when a laptop is lost. The site refuses its token from then on. Removing someone from the organization also ends their computers' links.

## 10. Moving existing data

`my-app/scripts/move-data.cjs` copies one organization at a time into this site's database, from the Docker copy's database, from another site's, or from a backup saved in the desktop app. It only writes to the new database and reads the old one in a read-only transaction, so the old copy keeps working.

**What moves.** The organization with its roles and members, saved connections, tracked schemas with their snapshots and drift history, compare sets and runs, query history, and approvals. People are matched by email address, so someone already on the new site stays one person.

**What stays behind.**

- Passwords of connections to private addresses, because this site cannot reach those databases anyway. Their scheduled drift checks are turned off. A Docker copy that shares this database keeps those passwords on its own machine instead: move its connections with `scripts/move-connections.cjs`, as section 6 shows.
- Microsoft sign-ins of people new to the site, because a sign-in belongs to one Microsoft directory. Those people sign in again on the new site. Someone from outside the new site's directory cannot, until an admin adds them to it. Add `--same-directory` when both sites sign in through the same directory.
- Open invites, linked computers, and phones with alerts on. Invite, link and turn those on again.

The tool refuses two databases on different versions of the app. Update the older copy first, and start it once so it updates its tables.

**How to run it.** On a computer that can reach both databases, in the `my-app` folder with its packages installed. The tool takes secrets from the environment only, never from its options. Put them in a file outside the repository, for example `~/move.env`:

```text
MOVE_FROM_URL=<the old database's address>
MOVE_FROM_KEY=<the old copy's APP_ENCRYPTION_KEY>
MOVE_TO_URL=<this site's DATABASE_URL_A>
MOVE_TO_KEY=<this site's APP_ENCRYPTION_KEY>
```

A copy that never set `APP_ENCRYPTION_KEY` locks passwords with its `NEXTAUTH_SECRET`, so give that as `MOVE_FROM_NEXTAUTH_SECRET` instead.

Then load the file and list the old database's organizations:

```bash
set -a; . ~/move.env; set +a; node scripts/move-data.cjs
```

Try moving one. Without `--apply` it does the whole move and then undoes it, so a trial meets every problem a real move would:

```bash
node scripts/move-data.cjs --org acme-data
```

Read the report, then run the same command with `--apply` added. Delete `~/move.env` afterwards.

Other options:

| Option | What it does |
| --- | --- |
| `--as <address>` | Gives the organization a different address on the new site, for example when its own is taken there. |
| `--admin <email>` | Makes this person an admin of the moved organization. |
| `--backup <file>` | Reads a desktop backup (Settings, **Backup**, **Save a backup**) instead of a database. Put its passphrase in `MOVE_BACKUP_PASSPHRASE`, and leave out `MOVE_FROM_URL` and `MOVE_FROM_KEY`, since the backup holds its own key. It needs the desktop code built first: `npm install` and `npm run build:ts` in `desktop`. |
| `--keep-private-passwords` | Keeps the passwords of private connections in the new database. Not for a Docker copy set up as in section 6, which keeps them on its own machine. |
| `--same-directory` | Keeps Microsoft sign-ins, as above. |

The report holds counts only, never a host, email address, password or key. Afterwards, sign in on the new site and open the organization's address.

## Known limits

- The connection to the app's own database is encrypted, but the server's certificate is not verified. This is the same as the Docker setup.
- On the first start of a new deployment, a burst of requests about as large as the pooler's server connections can use them all up waiting on the setup lock. Those requests fail after 120 seconds, and later ones work.
- A copy with no deployment stamp, such as a Docker copy, runs the whole setup on every start, and copies starting together take turns. From far away that measured 79 seconds for the first and about 42 for each one after it, so a fourth starting together would run out the 120 second wait. Its request would fail, and a later one would work.

## Sources

- [Supabase: connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase: hardening the Data API](https://supabase.com/docs/guides/database/hardening-data-api)
- [Supabase: new tables and the Data API](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
- [Supabase: scheduling calls](https://supabase.com/docs/guides/functions/schedule-functions)
- [Supabase: pg_net](https://supabase.com/docs/guides/database/extensions/pg_net)
- [Supabase: free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- [Supabase: billing and plan limits](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Supabase: database size](https://supabase.com/docs/guides/platform/database-size)
- [Vercel: function limits](https://vercel.com/docs/functions/limitations)
- [Vercel: system environment variables](https://vercel.com/docs/environment-variables/system-environment-variables)
- [Vercel: cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Vercel: Hobby plan](https://vercel.com/docs/plans/hobby)
- [Vercel: function usage and pricing](https://vercel.com/docs/functions/usage-and-pricing)
- [Vercel: function regions](https://vercel.com/docs/functions/configuring-functions/region)
