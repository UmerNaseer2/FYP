# Running Schema Studio on a server, kept up to date by itself

Once this is set up, every push to `main` that passes CI reaches the server
within about five minutes, with nobody logging in.

How it works: the server cannot be reached from GitHub (only through
Splashtop), so GitHub cannot push to it. Instead the server asks. cron runs
[`auto-update.sh`](auto-update.sh) every five minutes. When `main` on GitHub
has a new commit and CI passed on it, the script pulls it, rebuilds the app
container and waits for it to be healthy. The database container and its data
are never touched. A failed build leaves the old version running.

All commands below are run on the server, in its terminal.

## 1. Check the server has what it needs

```bash
docker compose version
git --version
python3 --version
```

Also check your user can run Docker without `sudo`:

```bash
docker ps
```

If that says "permission denied", ask IT to add your user to the `docker` group.

## 2. Get the code

```bash
git clone https://github.com/UmerNaseer2/FYP.git ~/FYP
cd ~/FYP
```

It must stay on `main`. The script follows `main` and refuses to run on any
other branch.

## 3. Make the server's own secrets

Compose reads a file called `.env` next to `docker-compose.yml`. Without it,
the stack starts with the demo defaults written in `docker-compose.yml`, which
are public on GitHub. Make fresh ones for the server:

```bash
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
NEXTAUTH_SECRET=$(openssl rand -hex 32)
APP_ENCRYPTION_KEY=$(openssl rand -hex 32)
POSTGRES_PORT=127.0.0.1:5433
EOF
chmod 600 .env
```

Why each line:

- `POSTGRES_PASSWORD` is only read the first time the database is created.
  Set it before the first `up`. Changing it later does nothing unless the
  database volume is deleted too.
- `APP_ENCRYPTION_KEY` encrypts the saved connection passwords. Keep a copy
  somewhere safe: lose it and every saved connection has to be entered again.
- `POSTGRES_PORT=127.0.0.1:5433` lets only the server itself reach the
  database port, not the rest of the network.

`.env` is in `.gitignore`, so it is never committed and `git pull` never
touches it.

## 4. Start it once by hand

```bash
docker compose up -d --build
```

The first build takes a few minutes. Then:

```bash
docker compose ps
```

Both `app` and `db` should say `healthy`. The app is on port 3000 of the
server.

## 5. Try the updater by hand

```bash
./deploy/auto-update.sh
```

It should print `Up to date at` and a commit id.

## 6. Turn it on

```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * $HOME/FYP/deploy/auto-update.sh >> $HOME/schema-studio-deploy.log 2>&1") | crontab -
```

Check it is there:

```bash
crontab -l
```

## Watching it

```bash
tail -f ~/schema-studio-deploy.log
```

One line appears per event, for example:

```text
2026-09-21 14:05:01  Found 1a2b3c4 on main. Waiting for CI to pass before deploying it.
2026-09-21 14:15:01  Deploying 1a2b3c4: fix: something
2026-09-21 14:16:10  Deployed 1a2b3c4. The app is up and healthy.
```

The full output of the latest build is in `~/FYP/deploy/last-build.log`.

## Turning it off

```bash
crontab -e
```

Delete the line that mentions `auto-update.sh`, save, and quit. The app keeps
running on whatever version it last deployed.

## Rules for this server

- **Never edit files in `~/FYP` on the server.** Change them on your own
  computer, push, and let the script bring them over. A hand edit makes the
  script stop with a message telling you so, until the edit is undone with
  `git checkout -- .`.
- **Never run `docker compose down -v`** here. The `-v` deletes the database
  volume, and with it every saved connection and all history.

## Before the link is made public

The compose file turns the sign-in bypass on, so anyone who can open the app
is let in without a Microsoft account. That is fine on a private test server
and **not fine on a public link**. Before IT opens it up, add to `.env`:

```text
NEXT_PUBLIC_AUTH_BYPASS=false
AZURE_AD_CLIENT_ID=...
AZURE_AD_CLIENT_SECRET=...
AZURE_AD_TENANT_ID=...
```

then run `docker compose up -d --build` once. The bypass is baked in at build
time, so a restart alone does not change it.
