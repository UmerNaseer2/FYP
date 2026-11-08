# Running Schema Studio on a server, kept up to date by itself

Once this is set up, every signed push to `main` that passes CI goes live on
the server by itself, usually within twenty minutes: CI takes about ten, as
it also builds and starts the whole stack in Docker, the server checks GitHub
every five, and the rebuild takes a minute or two. Nobody has to log in.

Then lock the server down with [HARDENING.md](HARDENING.md): security
updates, an account of its own for the app, a firewall, and the list of keys
whose signed commits it deploys.

Before anyone takes a disk image of the server, read
[DISK-IMAGE.md](DISK-IMAGE.md): the image holds every secret on the server,
and every copy of it keeps updating itself. To hand over only the app, as a
container image with no secrets or data in it, see
[CONTAINER-IMAGE.md](CONTAINER-IMAGE.md).

To run it on Vercel with its data in Supabase instead, see
[SUPABASE-VERCEL.md](SUPABASE-VERCEL.md).

How it works: the server cannot be reached from GitHub (only through
Splashtop), so GitHub cannot push to it. Instead the server asks. cron runs
[`auto-update.sh`](auto-update.sh) every five minutes. When `main` on GitHub
has a new commit, signed with a trusted key, and CI passed on it, the script
pulls it, rebuilds the app
container and waits for it to be healthy. Swapping the new container in takes
the app offline for about a second. If anything goes wrong, the old version
keeps running and the log says what happened. If the new version starts but
is not healthy within three minutes, the script puts the old version back and
does not try that commit again until the next push. The database keeps its
data throughout.

Once a week, at night, the same script also fetches the newest `node` and
`postgres` images, which the app and its database are built on, and moves
onto them if they changed. Their security fixes then arrive even when nobody
pushes. A second script, [`backup.sh`](backup.sh), saves a copy of the
database every night (step 8).

All commands below are run on the server, in its terminal. If Splashtop shows
only a black screen, ask IT for SSH access: every step works the same over
SSH.

## 1. Check the server has what it needs

```bash
docker compose version
git --version
python3 --version
curl --version
```

If one is missing, ask IT to install it.

Check your user can run Docker without `sudo`:

```bash
docker ps
```

If that says "permission denied", ask IT to add your user to the `docker` group.
If the list includes `schema-studio-app-1`, Schema Studio is already set up on
this server: stop here and see [Watching it](#watching-it) instead. A second
copy would break the first (see the rules at the end).

Check the server can reach GitHub:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://api.github.com
```

It should print `200`. Anything else means the network is blocking GitHub, so
ask IT.

## 2. Make sure it survives a restart

```bash
systemctl is-enabled docker
systemctl is-active cron
```

These should print `enabled` and `active`. If Docker says `disabled`, run
`sudo systemctl enable docker` or ask IT. The containers then come back by
themselves, because both have `restart: unless-stopped` in
`docker-compose.yml`.

The PC must also never go to sleep. Ask IT to confirm, or switch sleep off
yourself (this needs `sudo`):

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

## 3. Get the code

```bash
git clone --branch main https://github.com/<OWNER>/FYP.git ~/FYP
cd ~/FYP
```

Put the GitHub account the repository is under in place of `<OWNER>`, as its
address on GitHub shows. It must stay on `main`. The script follows `main` and refuses to run on any
other branch.

## 4. Make the server's own secrets

Compose reads a file called `.env` next to `docker-compose.yml`. Without it,
the stack starts with the demo defaults written in `docker-compose.yml`, which
are public on GitHub. Make fresh ones for the server. Do this only once:

```bash
cat > .env <<EOF
COMPOSE_PROJECT_NAME=schema-studio
POSTGRES_PASSWORD=$(openssl rand -hex 24)
NEXTAUTH_SECRET=$(openssl rand -hex 32)
APP_ENCRYPTION_KEY=$(openssl rand -hex 32)
POSTGRES_PORT=127.0.0.1:5433
APP_PORT=127.0.0.1:3000
EOF
chmod 600 .env
```

To check the file without showing the secrets:

```bash
awk -F= '{print $1, length($2)}' .env
```

It should print the six names, with the lengths 13, 48, 64, 64, 14 and 14.

Why each line:

- `COMPOSE_PROJECT_NAME=schema-studio` names the containers
  `schema-studio-app-1` and `schema-studio-db-1`, and the database volume
  `schema-studio_pgdata`. Without it Docker names them after the folder,
  `fyp`. Anything else on the server run from a folder called `FYP` would then
  share those names, and starting or stopping it would replace or remove this
  app's containers.
- `POSTGRES_PASSWORD` is read only once, when the database is first created.
  That is why the block above must never be run again: the database would keep
  its first password while the app switched to the new one, and the app would
  be locked out of its own data.
- `APP_ENCRYPTION_KEY` encrypts the saved connection passwords. Keep a copy
  somewhere safe: lose it and every saved connection has to be entered again.
- `POSTGRES_PORT=127.0.0.1:5433` lets only the server itself reach the
  database port, not the rest of the network.
- `APP_PORT=127.0.0.1:3000` does the same for the app: only the server's own
  browser can open it, at http://localhost:3000. That is also the one
  address Microsoft sign-in works at without `https`. Keep this line until IT
  makes a public link (see the last section).

`.env` is in `.gitignore`, so it is never committed and the updater never
touches it.

### Microsoft sign-in

Everyone signs in with a Microsoft account, so the app needs three values
from its app registration in Microsoft Entra ID. Without them it shows
"Single sign-on is not set up" and nobody gets in. Get them in the Azure
portal, portal.azure.com, on your own computer:

1. Open Microsoft Entra ID, then App registrations, and open the app's
   registration. If there is none yet, choose New registration, give it a
   name, and pick "Accounts in this organizational directory only".
2. Under Authentication, find the platform of the type **Web** (not
   "Single-page application"; add a Web platform if there is none), add the
   redirect URI `http://localhost:3000/api/auth/callback/microsoft-entra-id`,
   and save.
3. Under Certificates & secrets, choose New client secret, name it after this
   server, and copy its **Value** straight away: Azure shows it only once.
   With a secret of its own, this server's can be deleted later without
   breaking any other copy of the app.
4. On the Overview page, copy the Application (client) ID and the Directory
   (tenant) ID.

Then add them to `.env` on the server:

```bash
nano .env
```

Add these three lines at the end, each value in place of its dots, then save
with Ctrl+O and Enter, and quit with Ctrl+X:

```text
AZURE_AD_CLIENT_ID=...
AZURE_AD_CLIENT_SECRET=...
AZURE_AD_TENANT_ID=...
```

To paste through Splashtop, copy on your own computer, then press
Ctrl+Shift+V in the server's terminal. Check with the same `awk` command as
above: the three new lines should show the lengths 36, about 40, and 36.

### Optional lines

Add these with `nano .env` when you need them. If the app is already running,
apply them with `docker compose up -d`.

- The Script Editor's push and pull to GitHub need no lines here. Once you
  are signed in as Admin, save the scripts repository and an access token on
  the Admin screen, under GitHub. The app keeps the token encrypted with
  `APP_ENCRYPTION_KEY` and never shows it again. Make the token on GitHub
  under Settings, Developer settings, Personal access tokens, Fine-grained
  tokens: access to the scripts repository only, with the permission
  Contents set to Read and write. (`GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`
  and `GITHUB_PAT` in `.env` still work, for the default organization only,
  until an admin saves its own.)
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, only if people should be
  able to sign in with GitHub as well. They come from a GitHub OAuth app
  (GitHub, Settings, Developer settings, OAuth Apps) whose callback URL is
  `http://localhost:3000/api/auth/callback/github`.
- `ALLOW_PRIVATE_DB_HOSTS=true`, only if you want to compare databases on the
  campus network or on this server. Without it the app refuses private
  addresses such as 10.x.x.x, 192.168.x.x and localhost, which protects a
  public server. Hosted databases such as Neon work either way.
- `APP_MEMORY_LIMIT=4g` or `DB_MEMORY_LIMIT=2g`, only if the app or the
  database keeps restarting because it ran out of memory:
  `docker inspect schema-studio-app-1 --format '{{.State.OOMKilled}}'` (or
  `schema-studio-db-1`) then prints `true`. By default the app may use 2 GB
  and the database 1 GB, so one of them running away cannot slow down the
  whole server.
- `DRIFT_SCHEDULER=off`, only on a copy of this server that should not check
  the tracked databases for drift by itself, such as a demo.
- `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL_FAST` and `AI_MODEL_SMART`, only if
  people should get AI help: the Compare summary, the migration review, drift
  explanations, SQL drafts from plain words and the schema chat. The address
  is the service's OpenAI-style one, ending in a slash, such as
  `https://generativelanguage.googleapis.com/v1beta/openai/` for Google
  Gemini. The fast model does the short jobs and the smart one the rest;
  either one alone is used for both. Each organization still starts with AI
  off until its Admin switches it on in Admin, AI. A free key may let the
  service learn from what it is sent, so use one only with test databases.
  `AI_DAILY_LIMIT` (calls per organization per day, 300 by default) and
  `AI_PER_MINUTE` (calls per person per minute, 10 by default) cap the use.

## 5. Start it once by hand

```bash
docker compose up -d --build
```

The first build takes a few minutes. Then:

```bash
docker compose ps
```

Both `app` and `db` should say `healthy`.

If `up` stops with "port is already allocated", another program on the server
already uses that port. In `.env`, change the port it names (`3000` to `3001`,
or `5433` to `5434`), then run `docker compose up -d` again. A new app port
also needs `AUTH_URL=http://localhost:3001` (with that port) in `.env`, and
the same address in the Entra redirect URI and in the browser.

### The first sign-in makes the admin

Open http://localhost:3000 in the server's browser, exactly that, not
127.0.0.1: Microsoft sends you back to the address in `AUTH_URL`, which
docker-compose.yml sets to http://localhost:3000, and the sign-in must start
from that same address. Choose Continue with Microsoft.

If Microsoft answers with a redirect URI error instead, its message names the
address the app asked for. That must be `AUTH_URL` followed by
`/api/auth/callback/microsoft-entra-id`, and it must be on the registration's
Web platform. An address with `0.0.0.0` in it means `AUTH_URL` is missing:
inside its container the app sees only `0.0.0.0`.

The first person from the registration's directory to sign in becomes the
Admin of the default organization, so make that you. Everyone after that gets
an account, and can make an organization of their own, but sees the default
one only once an admin invites them: Admin screen, Users, Invite people. A
Microsoft account from outside the directory must first be invited into it,
in the Azure portal under Microsoft Entra ID, Users, New user, Invite
external user.

## 6. Try the updater by hand

```bash
./deploy/auto-update.sh
```

It should print `Up to date at` and a commit id.

## 7. Turn it on

The updater deploys only commits signed with a key listed in
`/etc/schema-studio/allowed_signers`. Make that file first, with step 3 of
[HARDENING.md](HARDENING.md). The rest of that guide replaces this cron line
with a timer under an account of its own.

```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * $HOME/FYP/deploy/auto-update.sh >> $HOME/schema-studio-deploy.log 2>&1") | crontab -
```

Check it is there:

```bash
crontab -l
```

The line should be there exactly once.

## 8. Save a copy of the database every night

The app's database holds everything the app knows: the saved connections,
the organizations and their people, the scripts and the history. The
databases you compare are not in it. [`backup.sh`](backup.sh) saves a copy of
it in `~/FYP/backups` and keeps the newest 14. Try it once:

```bash
./deploy/backup.sh
ls -l backups
```

It should print `Saved backups/schema-studio-` and the date, and `ls` should
list that file. Then have cron run it every night at 02:30:

```bash
(crontab -l 2>/dev/null; echo "30 2 * * * $HOME/FYP/deploy/backup.sh >> $HOME/schema-studio-backup.log 2>&1") | crontab -
crontab -l
```

`crontab -l` should now list two lines: this one and the updater's.

Good to know:

- A copy is as secret as `.env`. The connection passwords and GitHub access
  tokens in it are encrypted with `APP_ENCRYPTION_KEY`, which is in `.env`,
  so a copy and that key together give everything away. Neither is ever
  committed: `backups/` is in `.gitignore` too.
- The copies sit on the same disk as the database. They help when data is
  deleted by mistake, not when the disk fails. For that, copy the newest one
  somewhere else now and then.
- The top of `deploy/backup.sh` shows how to look inside a copy and how to
  put one back.

## Watching it

After [HARDENING.md](HARDENING.md), the log is in the system journal, and the
commands below change as its step 4 lists.

```bash
tail -f ~/schema-studio-deploy.log
```

One line appears per event, for example:

```text
2026-09-21 14:05:01  Found 1a2b3c4 on main. Waiting for CI to pass before deploying it.
2026-09-21 14:10:01  Deploying 1a2b3c4: fix: something
2026-09-21 14:13:30  Deployed 1a2b3c4. The app is up and healthy.
2026-09-29 01:00:14  Weekly image check: node and postgres have nothing newer. Nothing to do.
```

The full output of the latest build, or of the latest weekly image change, is
in `~/FYP/deploy/last-build.log`. To deploy right away instead of waiting up
to five minutes, run `~/FYP/deploy/auto-update.sh` by hand. A run by hand
prints to the terminal, so what it did is not in the log.

When the log says something else:

| The log says | What to do |
| --- | --- |
| `Not deploying ...: there is no list of trusted signing keys` | Make it, with step 3 of [HARDENING.md](HARDENING.md). |
| `Skipping ...: it is not signed with a key listed in ...` | The commit was not signed with your key: made on another computer, or on GitHub's website. Push a signed commit after it. An empty one is enough. |
| `Skipping ...: CI failed on it` | Fix the code on your computer and push again. |
| `Deploy of ... failed (try 1 of 3)` | Nothing yet. The old version is still running, and the next run tries again. The reason is at the end of `deploy/last-build.log`. |
| `Skipping ...: it failed to deploy 3 times` | Read the end of `deploy/last-build.log`. Fix it and push, or if the cause has passed (say Docker Hub was down), push again as below. |
| `Not deploying ...: files were changed by hand` | In `~/FYP`, run `git checkout -- .` to undo them. |
| `Could not reach GitHub` or `Could not ask GitHub about CI` | Nothing, unless it lasts for hours. The network was down, or GitHub's limit of 60 questions an hour from one address was used up (everyone on the campus connection shares it). It asks again by itself, and `Reached GitHub again` says when the network is back. |
| `Skipping ...: the app was 'unhealthy' 3 minutes after it started` | The new version started but did not answer, so it was not kept. The line before says whether the old version was put back and is healthy. The new version's own log is at the end of `deploy/last-build.log`. Push a fix. |
| `Could not put the previous version (...) back` or `Could not put the old images back` | The app may be down. `docker compose ps` and `docker compose logs app` show what is running. `docker compose up -d --build` rebuilds and starts the version this copy is back on. |
| `Weekly image check: node and postgres have nothing newer` | Nothing. It looks again in a week. |
| `Weekly image check: moved onto the newer ...` | Nothing. The fixes in the newer image are live. |
| `Weekly image check: could not fetch ...` or `... the rebuild on the newer node image failed` | Nothing. The app keeps running as it was, and the check tries again the next night. If it says so night after night, read the end of `deploy/last-build.log`. |
| `Weekly image check: ... so the old images go back` | The app is back on the images it ran on before, and the check tries again in a week. The next line says whether the old images came back healthy, and the reason is at the end of `deploy/last-build.log`. If it happens two weeks in a row, the code may need a change for the newer image. |

A skipped commit stays skipped, even if you re-run its CI on GitHub and it
passes. To deploy it anyway, push again. An empty commit is enough:
`git commit --allow-empty -m "Redeploy"`, then push. Or, on the server, delete
the note that marks it skipped with `rm ~/FYP/.deploy-skipped`, and the next
run tries it again.

A new version that is healthy but wrong in some other way stays live. To undo
it, revert the commit on GitHub. The server follows `main`, so it takes the
revert like any other push.

## Turning it off

```bash
crontab -e
```

Delete the line that mentions `auto-update.sh`, save, and quit. The app keeps
running on whatever version it last deployed. Leave the `backup.sh` line in,
so the nightly copies of the database go on.

## Rules for this server

- **Never change the code in `~/FYP` on the server**, by hand or with git
  (`git pull` included). Change it on your own computer, push, and let the
  script bring it over and rebuild. A hand edit makes the script stop with a
  message saying so, until it is undone with `git checkout -- .`. The one
  file meant to be edited on the server is `.env`.
- **Never run `docker compose down -v`** here. The `-v` deletes the database
  volume, and with it every saved connection and all history.
- **One copy per server.** Set this up once, with one `~/FYP` and its two
  cron lines. A second copy would take over the same containers, since they
  share the name `schema-studio`, and its own passwords would lock the app
  out of its database.

## Before the link is made public

Sign-in is already on, so a public link lets in only people who sign in.
Microsoft needs the link to be `https`, because it accepts plain `http` only
for localhost. The app cannot see the link from inside its container, so
`AUTH_URL` tells it. Without that, Microsoft rejects the sign-in with a
redirect URI error. Once IT has made the link:

1. In the Entra app registration, under Authentication, add
   `https://<the link>/api/auth/callback/microsoft-entra-id` to the Web
   platform, beside the localhost one.
2. In `.env`, add `AUTH_URL=https://<the link>`, written exactly as people
   will open it, with no path and no `/` at the end. From then on sign-in
   works only from that address, not from http://localhost:3000.
3. If IT's proxy runs on another machine, the app must listen beyond this
   one: in `.env`, change `APP_PORT=127.0.0.1:3000` to `APP_PORT=3000`, and
   give the app's port a firewall rule like the one in step 5.2 of
   [HARDENING.md](HARDENING.md), so that only the proxy reaches it. If the
   proxy runs on this server, leave the line as it is.
4. Leave `ALLOW_PRIVATE_DB_HOSTS` off, so the public app cannot be pointed at
   machines inside the campus network.
5. Run `docker compose up -d`. The sign-in settings are read when the app
   starts, so no rebuild is needed.
