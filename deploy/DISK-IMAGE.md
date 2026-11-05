# Taking a disk image of the server

A disk image is a copy of the server's whole disk. Started on another
machine, it comes up as this server was: Ubuntu, Docker, Schema Studio with
all its data, and the schedule that updates it and saves copies of its
database. This guide says what the image holds, what to clean up before it is
taken, what to change on this server after, and what to know on a copy that
runs somewhere else.

To hand over only the app, without the server's secrets or data, a container
image is enough: see [CONTAINER-IMAGE.md](CONTAINER-IMAGE.md).

Every command runs on the server, in the folder this repo is in, `~/FYP`.
After step 4 of [HARDENING.md](HARDENING.md), the folder is
`/srv/schema-studio`, and the commands that work in it run as the app's own
account: put `sudo -u schemastudio` in front of them (the table at the end of
that step has the details).

## What the image holds

| What | Where | Secret |
| --- | --- | --- |
| Ubuntu, Docker and their settings | The whole disk | No |
| The app's code | `~/FYP`, a copy of `main` | No, it is public |
| The server's own secrets: the database password, the sign-in secret (`NEXTAUTH_SECRET`), the encryption key and the Microsoft client secret | `.env` in that folder | **Yes** |
| The app's database: saved connections, organizations and their people, scripts, history | The Docker volume `schema-studio_pgdata` | **Yes** |
| The nightly copies of that database | `backups/` in that folder | **Yes** |
| The schedule: an update check every five minutes, a copy every night | cron, or the systemd timers after HARDENING.md | No |
| The keys whose signed commits it deploys | `/etc/schema-studio/allowed_signers` | No, they are public keys |
| Whatever people left behind: browser sign-ins, saved passwords, terminal history | The home folders | **Yes** |

The saved connection passwords and GitHub access tokens are encrypted in the
database, with `APP_ENCRYPTION_KEY`. That key is in `.env` on the same disk,
so whoever has the image can open them all. Treat the image like `.env`:
give it only to people who may see every saved password, and keep it where
only they can reach it.

## Before it is taken

### 1. Check it is healthy and up to date

```bash
docker compose ps
git log -1 --format='%h %s'
```

Both `app` and `db` should say `healthy`, and the commit should be the newest
one on `main` on GitHub. If it is not, the deploy log says why (README.md,
"Watching it").

### 2. Save a copy of the database

So the image holds one from just before it was taken:

```bash
./deploy/backup.sh
```

It should print `Saved backups/schema-studio-` and the date.

### 3. Remove what belongs to you, not to the server

- **Saved connections.** On the Connections screen of each organization,
  delete every connection the image's new owner should not reach, such as
  your own test databases. Or keep them, and change those databases'
  passwords after the image is taken, so the ones inside it stop working.
- **The browser.** In the server's browser, sign out of every site you used
  (GitHub, Microsoft, Vercel, Cloudflare, Supabase, email), and delete the
  passwords it saved.
- **git's saved password.** The updater reads GitHub without one, since the
  repository is public. Check that git did not keep one anyway:

  ```bash
  ls -l ~/.git-credentials
  ```

  "No such file or directory" is what you want. If the file is there, delete
  it with `rm ~/.git-credentials`, then delete the token it held on GitHub
  (Settings, Developer settings, Personal access tokens).
- **Terminal history.** The terminal keeps every command typed or pasted into
  it. Close every terminal window but one, then:

  ```bash
  history -c && rm -f ~/.bash_history
  ```

Leave the Splashtop and Portainer accounts as they are. They belong to IT.

### 4. Check what is in `.env`

```bash
awk -F= '{print $1, length($2)}' .env
```

This prints each name and the length of its value, never the value. It
should list the six names from step 4 of [README.md](README.md), the three
`AZURE_AD_` lines, and any optional line you added on purpose. A copy needs
all of them to run, so leave them in. If it lists `GITHUB_PAT`, that token
goes with the image too: see "After it is taken", below.

### 5. Keep the secrets somewhere safe

Save the values in `.env` in a password manager. Without `APP_ENCRYPTION_KEY`,
nobody can open the saved passwords and tokens again, in the database or in
any of its copies.

## After it is taken

Every copy of the image can use what is in it. This server keeps running and
keeps updating itself, so take back what copies should no longer use:

- **The sign-in secret.** Whoever has the image has `NEXTAUTH_SECRET`, and
  with it they could make a sign-in cookie this server accepts, as anyone,
  once other machines can reach it. Give this server a new one before it gets
  a public link, and preferably right away:

  ```bash
  sed -i "s/^NEXTAUTH_SECRET=.*/NEXTAUTH_SECRET=$(openssl rand -hex 32)/" .env
  docker compose up -d
  ```

  It signs everyone out, nothing more, because the saved passwords are
  locked with `APP_ENCRYPTION_KEY`. Only if `awk` showed no
  `APP_ENCRYPTION_KEY` line, leave `NEXTAUTH_SECRET` alone: the key is then
  made from it, and changing it would lock the saved passwords away.
- **The Microsoft client secret.** Copies sign people in through your app
  registration with it. To stop that, make a new client secret for this
  server, the same way as in step 4 of [README.md](README.md), put its Value
  after `AZURE_AD_CLIENT_SECRET=` with `nano .env`, run `docker compose up -d`,
  sign in once to check, and then delete the old secret in the Azure portal
  (the app registration, Certificates & secrets). Copies then show a sign-in
  error until their owners put their own registration's values in their
  `.env`.
- **The GitHub access token.** If the token saved on the Admin screen, under
  GitHub, is your own, every copy has it. Make a new one, save it there on
  this server, and delete the old one on GitHub. If `.env` has a
  `GITHUB_PAT` line, do the same: save a new token on the Admin screen,
  delete the line with `nano .env`, run `docker compose up -d`, and delete
  the old token on GitHub.
- **Database passwords.** For each saved connection you kept, change that
  database's password, then update the connection on the Connections screen.

Leave `APP_ENCRYPTION_KEY` and `POSTGRES_PASSWORD` as they are. The database
answers only on the machine itself (`POSTGRES_PORT=127.0.0.1:5433`), and
neither can simply be changed: a new `APP_ENCRYPTION_KEY` could not open the
saved passwords, and `POSTGRES_PASSWORD` is read only when the database is
first made (step 4 of [README.md](README.md) says why).

## On a copy that runs somewhere else

- **It keeps updating itself** from GitHub `main`, with the commits signed by
  a key in `/etc/schema-studio/allowed_signers` that pass CI, and once a week
  it moves onto newer `node` and `postgres` images. To stop that, run
  `crontab -e` and delete the line that mentions `auto-update.sh`, or, after
  HARDENING.md, run
  `sudo systemctl disable --now schema-studio-update.timer`. Ubuntu's own
  security updates (step 2 of [HARDENING.md](HARDENING.md)) carry on either
  way.
- **To follow another repository**, such as a fork, point git at it with
  `git remote set-url origin` and the repository's https address, and replace
  the keys in `allowed_signers` with the ones its commits are signed with
  (step 3 of [HARDENING.md](HARDENING.md)). The updater reads the repository
  and its CI results without a token, so the repository must be public, and
  CI must run there: on a fork, turn it on under the Actions tab.
- **Drift checks run twice.** A copy checks the tracked databases for drift by
  itself, as this server does. On a copy that is only for looking around,
  add `DRIFT_SCHEDULER=off` to `.env` with `nano .env`, then run
  `docker compose up -d`.
- **Signing in.** On the copy's own machine, http://localhost:3000 works with
  the same app registration until its client secret is changed (see above).
  To use a registration of their own, the owner puts its three values in
  `.env` (step 4 of [README.md](README.md), Microsoft sign-in) and runs
  `docker compose up -d`. For a public link, see the last section of
  [README.md](README.md).
- **Its own sign-in secret.** Give the copy a new `NEXTAUTH_SECRET` with the
  same two commands as above, so the two cannot accept each other's cookies.
  Keep `APP_ENCRYPTION_KEY`: it is the only key to the saved passwords.

## Putting a backup back

The steps are at the top of [`backup.sh`](backup.sh). CI runs them on every
push, against the real Docker stack, so they are known to work. A backup
opens only together with the `APP_ENCRYPTION_KEY` of the server that made it.
