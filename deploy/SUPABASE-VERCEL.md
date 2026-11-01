# Running Schema Studio on Supabase and Vercel

> **Not yet run on real accounts.** The code behind this guide was tested on plain PostgreSQL through a stand-in for a transaction pooler, not on Supabase or Vercel themselves. Expect to correct a step or two the first time through.

The web app runs on Vercel. Its own data (people, roles, saved connections, history) lives in a Supabase project, used as an ordinary PostgreSQL database. It is the same code as the Docker deployment in [README.md](README.md), set up through environment variables. Sign-in stays with Microsoft (and GitHub if you want it) through NextAuth. Supabase Auth is not used.

## What this setup cannot do

- **Reach a private database.** Vercel runs on the public internet, so a database on a private network cannot be compared or tracked from here. Use the Docker copy for those.
- **Promise an outbound address.** Vercel's outbound addresses are not fixed by default, so a database that only accepts listed addresses will refuse the app.
- **Return more than 4.5 MB.** That is Vercel's limit for a function's request or response body, and the app does not stream. A very large compare result fails with an error.
- **Run for long.** A function stops at 300 seconds. Pro can raise that to 800 in the project's settings, and the free plan cannot. A long compare or deploy is cut off at that point, so run those from the Docker copy.

## 1. Create the Supabase project

1. Create a project in the same region as your Vercel functions, because every request makes several database calls and distance adds up. Vercel's default is Washington, D.C. (`iad1`, which is `us-east-1` in Supabase). If your people are far from there, put both near them, for example Singapore: `ap-southeast-1` in Supabase and `sin1` under **Settings**, **Functions**, **Function Regions** in Vercel.
2. Press **Connect** and copy the **Transaction pooler** string (port 6543). This is `DATABASE_URL_A`. The direct address is IPv6 unless you buy the IPv4 add-on, and the pooler is what Supabase recommends for serverless. The app keeps no session state, so it works behind it.
3. Leave the database's time zone at UTC.
4. Turn off the **Data API** in its settings in the Supabase dashboard. The app talks to PostgreSQL directly and never uses it. While it is on, Supabase serves the `public` schema over the internet to anyone with the project's public key, limited only by that role's grants, and tables made outside the dashboard (as the app's are) do not get row level security on their own.

The app also turns on row level security for its own tables, with no policies, whenever it finds Supabase's `anon` role. Those roles then see no rows even if the Data API stays on. The app is not affected, because a table's owner is exempt.

That is why every copy must connect as the same database user: the app creates its tables on first start and has to own them.

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

Leave `ALLOW_PRIVATE_DB_HOSTS` unset, because there is no private network to reach from here. Leave `DRIFT_SCHEDULER` blank, because on Vercel a blank value means a scheduled call wakes the checker.

## 3. Add the sign-in addresses

Add these to the provider, using your site's production address:

- Microsoft, in the Azure app registration: `https://<your-site>/api/auth/callback/microsoft-entra-id`
- GitHub, in the OAuth app: `https://<your-site>/api/auth/callback/github`

Preview deployments have addresses of their own, so sign-in works there only if you list those too.

## 4. Deploy and sign in

Deploy, then open the site and sign in. The first request of a new deployment creates or updates the tables, so it can take a few seconds.

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

The Docker copy can stay on beside Vercel, with both showing the same data:

- Point it at the same `DATABASE_URL_A` and use the same `APP_ENCRYPTION_KEY`.
- Saved connections are shared too, so a connection to a private database works from the Docker copy and fails from Vercel.
- Let one copy run the checker. Set `DRIFT_SCHEDULER=off` on the other, or leave the `pg_cron` call out. Two copies would not check twice, but one that cannot reach a private database would record it as unreachable.

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

**Supabase Free**

- You get two free projects, each with 500 MB of database size and a fixed 2 GB disk.
- A project without enough database activity over a week gets paused, and that stops sign-in, the app and the scheduled calls together. Supabase emails a warning first, and you restore the project from its dashboard. Its documentation says a few requests a day are typically enough. The scheduled calls read the database, so they should count, but nobody has yet watched this over a week.

## Known limits

- The connection to the app's own database is encrypted, but the server's certificate is not verified. This is the same as the Docker setup.
- On the first start of a new deployment, a burst of requests about as large as the pooler's server connections can use them all up waiting on the setup lock. Those requests fail after 120 seconds, and later ones work.

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
