# Running Schema Studio on a server, kept up to date by itself

Once this is set up, every push to `main` that passes CI goes live on the
server by itself, usually within ten minutes: CI takes about two, the server
checks GitHub every five, and the rebuild takes a minute or two. Nobody has
to log in.

How it works: the server cannot be reached from GitHub (only through
Splashtop), so GitHub cannot push to it. Instead the server asks. cron runs
[`auto-update.sh`](auto-update.sh) every five minutes. When `main` on GitHub
has a new commit and CI passed on it, the script pulls it, rebuilds the app
container and waits for it to be healthy. Swapping the new container in takes
the app offline for about a second. If anything goes wrong, the old version
keeps running and the log says what happened. The database keeps its data
throughout.

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

If one is missing, ask IT to install it. On Ubuntu, Docker Compose is the
`docker-compose-v2` package.

Check your user can run Docker without `sudo`:

```bash
docker ps
```

If that says "permission denied", ask IT to add your user to the `docker` group.

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
git clone --branch main https://github.com/UmerNaseer2/FYP.git ~/FYP
cd ~/FYP
```

It must stay on `main`. The script follows `main` and refuses to run on any
other branch.

## 4. Make the server's own secrets

Compose reads a file called `.env` next to `docker-compose.yml`. Without it,
the stack starts with the demo defaults written in `docker-compose.yml`, which
are public on GitHub. Make fresh ones for the server:

```bash
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
NEXTAUTH_SECRET=$(openssl rand -hex 32)
APP_ENCRYPTION_KEY=$(openssl rand -hex 32)
POSTGRES_PORT=127.0.0.1:5433
APP_PORT=127.0.0.1:3000
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
- `APP_PORT=127.0.0.1:3000` does the same for the app: only the server's own
  browser can open it, at http://localhost:3000. The sign-in bypass is on
  (see the last section), so anyone who can open the app gets in without
  signing in. Keep this line until real sign-in is set up.

`.env` is in `.gitignore`, so it is never committed and the updater never
touches it.

### Optional lines

Add these with `nano .env` when you need them. If the app is already running,
apply them with `docker compose up -d`.

- For the Script Editor's push and pull to GitHub, copy `GITHUB_REPO_OWNER`
  and `GITHUB_REPO_NAME` from `my-app/.env.local` on your own computer, and
  give the server its own `GITHUB_PAT` instead of reusing yours. Make it on
  GitHub under Settings, Developer settings, Personal access tokens,
  Fine-grained tokens: access to the scripts repository only, with the
  permission Contents set to Read and write.
- `ALLOW_PRIVATE_DB_HOSTS=true`, only if you want to compare databases on the
  campus network or on this server. Without it the app refuses private
  addresses such as 10.x.x.x, 192.168.x.x and localhost, which protects a
  public server. Hosted databases such as Neon work either way.

## 5. Start it once by hand

```bash
docker compose up -d --build
```

The first build takes a few minutes. Then:

```bash
docker compose ps
```

Both `app` and `db` should say `healthy`. Open http://localhost:3000 in the
server's browser to see it.

## 6. Try the updater by hand

```bash
./deploy/auto-update.sh
```

It should print `Up to date at` and a commit id.

## 7. Turn it on

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
2026-09-21 14:10:01  Deploying 1a2b3c4: fix: something
2026-09-21 14:13:30  Deployed 1a2b3c4. The app is up and healthy.
```

The full output of the latest build is in `~/FYP/deploy/last-build.log`. To
deploy right away instead of waiting up to five minutes, run
`~/FYP/deploy/auto-update.sh` by hand. A run by hand prints to the terminal,
so what it did is not in the log.

When the log says something else:

| The log says | What to do |
| --- | --- |
| `Skipping ...: CI failed on it` | Fix the code on your computer and push again. |
| `Deploy of ... failed (try 1 of 3)` | Nothing yet. The old version is still running, and the next run tries again. The reason is at the end of `deploy/last-build.log`. |
| `Skipping ...: it failed to deploy 3 times` | Read the end of `deploy/last-build.log`. Fix it and push, or if the cause has passed (say Docker Hub was down), push again as below. |
| `Not deploying ...: files were changed by hand` | In `~/FYP`, run `git checkout -- .` to undo them. |
| `Could not reach GitHub` or `Could not ask GitHub about CI` | Nothing, unless it lasts for hours. The network was down, or GitHub's limit of 60 questions an hour from one address was used up (everyone on the campus connection shares it). It asks again by itself, and `Reached GitHub again` says when the network is back. |
| `the app is 'unhealthy' after 3 minutes` | The new version started but is not answering. `docker compose logs app` shows why. Push a fix, or revert the commit on GitHub. |

A skipped commit stays skipped, even if you re-run its CI on GitHub and it
passes. To deploy it anyway, push again. An empty commit is enough:
`git commit --allow-empty -m "Redeploy"`, then push. Or, on the server, delete
the note that marks it skipped with `rm ~/FYP/.deploy-skipped`, and the next
run tries it again.

To undo a bad deploy, revert the commit on GitHub. The server follows `main`,
so it takes the revert like any other push.

## Turning it off

```bash
crontab -e
```

Delete the line that mentions `auto-update.sh`, save, and quit. The app keeps
running on whatever version it last deployed.

## Rules for this server

- **Never change the code in `~/FYP` on the server**, by hand or with git
  (`git pull` included). Change it on your own computer, push, and let the
  script bring it over and rebuild. A hand edit makes the script stop with a
  message saying so, until it is undone with `git checkout -- .`. The one
  file meant to be edited on the server is `.env`.
- **Never run `docker compose down -v`** here. The `-v` deletes the database
  volume, and with it every saved connection and all history.

## Before the link is made public

The compose file turns the sign-in bypass on, so anyone who can open the app
is let in without a Microsoft account. That is fine while only the server
itself can open it (`APP_PORT=127.0.0.1:3000` above) and **not fine on a
public link**. Real sign-in needs the link to be `https`, because Microsoft
accepts plain `http` only for localhost. IT's proxy must also tell the app the
link is `https`, with the `X-Forwarded-Proto: https` header. Most proxies send
it by default. Without it, Microsoft rejects the sign-in with a redirect URI
error. Once IT has made the link:

1. In the Entra app registration, add the redirect URI
   `https://<the link>/api/auth/callback/microsoft-entra-id`.
2. Add to `.env`:

   ```text
   NEXT_PUBLIC_AUTH_BYPASS=false
   AZURE_AD_CLIENT_ID=...
   AZURE_AD_CLIENT_SECRET=...
   AZURE_AD_TENANT_ID=...
   ```

   If IT's link reaches the app from another machine, also delete the
   `APP_PORT=127.0.0.1:3000` line.
3. Run `docker compose up -d --build` once. The bypass is baked in at build
   time, so a restart alone does not change it.
