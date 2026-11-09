# Handing over the app as a container image

A container image is the app packed the way Docker runs it: the built app and
everything it needs to start, in one file. Whoever gets the file loads it into
their own Docker and runs Schema Studio from it, without building anything
from the source code. This guide says what the image holds, how to make the
file on the server, and how to start it on another machine.

To hand over the whole server instead, with Ubuntu, the data and the secrets,
see [DISK-IMAGE.md](DISK-IMAGE.md).

## What the image holds

| What | In the image? |
| --- | --- |
| The app, built from one commit of `main` | Yes |
| Node.js 22 on Debian (`node:22-slim`), which the app runs on | Yes |
| The app's public files, such as its icons and the phone app's service worker | Yes |
| The server's secrets in `.env`: the database password, `NEXTAUTH_SECRET`, `APP_ENCRYPTION_KEY`, the Microsoft client secret | No. `my-app/.dockerignore` keeps `.env` files out of every build |
| The app's database: saved connections, organizations and their people, scripts, history | No. It lives in the Docker volume `schema-studio_pgdata` |
| PostgreSQL itself | No. The database runs from the public `postgres:17-alpine` image, which Docker downloads by itself |

So the file is safe to hand over: nothing in it is secret. It is built only
from this repository's code and public software. Inside the container the app runs as an ordinary account,
`nextjs`, not as root, and listens on port 3000.

One setting is baked in when the image is built: the sign-in bypass, which
lets anybody in as an admin without signing in. Each image carries a label
that says how it was built, and the script below saves only an image whose
label says `false`, which means real Microsoft sign-in. Anyone can check a
loaded image:

```bash
docker image inspect -f '{{index .Config.Labels "org.schema-studio.sign-in-bypass"}}' schema-studio-app:<commit>
```

It should print `false`.

## Making the file on the server

The script saves the image the server runs now. That image must come from a
commit that labels its images. The server deploys one by itself once step 3
of [HARDENING.md](HARDENING.md) is done, and the deploy log then says
`Deployed` and the commit. Until then the script stops and says the image was
built before images said whether their bypass is on.

On the server, in the folder this repo is in:

```bash
cd ~/FYP
./deploy/export-image.sh
```

After step 4 of HARDENING.md the folder is `/srv/schema-studio`, and the
script runs as the app's own account:

```bash
cd /srv/schema-studio
sudo -u schemastudio ./deploy/export-image.sh
```

It takes a minute or two and ends with the file's name and size, such as
`images/schema-studio-app-0123456789ab.tar.gz`. The twelve characters at the
end are the commit the image was built from. Beside it is a small checksum
file, the same name with `.sha256` added.

Before it saves anything, the script checks that:

- the app is running and healthy,
- its image has the sign-in bypass off,
- nobody changed the files in the folder by hand, so the commit in the file
  name is the code in the image.

If a deploy or a backup is running, it says so and stops: run it again a few
minutes later. While it saves, no deploy can swap the image.

## What to hand over

Both files: the `.tar.gz` and its `.sha256`. Copy them off the server the
way you move other files from it, for example with Splashtop's file
transfer.

Never hand over `.env`. Leave out `backups/` too, unless the data is meant
to go (see the last section).

Old files stay in `images/` until you delete them with `rm`.

## Loading it on another machine

The other machine needs Docker. In the folder the two files are in:

1. Check the file arrived whole:

   ```bash
   sha256sum -c schema-studio-app-<commit>.tar.gz.sha256
   ```

   It should print the file name and `OK`. On a Mac, use
   `shasum -a 256 -c` instead of `sha256sum -c`.

2. Load it into Docker:

   ```bash
   docker load -i schema-studio-app-<commit>.tar.gz
   ```

   It should end with `Loaded image: schema-studio-app:<commit>`.

## Starting it with docker-compose.yml

This is how the server runs it, and CI starts the app from such a file the
same way on every push, so this is the tested route. It needs a copy of this
repository for `docker-compose.yml`, ideally at the commit in the file name
(`git checkout <commit>` in the copy gets it).

1. Give the image the name `docker-compose.yml` looks for:

   ```bash
   docker tag schema-studio-app:<commit> schema-studio-app
   ```

2. In the copy of the repository, make `.env` as in step 4 of
   [README.md](README.md), with fresh secrets. Keep its line
   `COMPOSE_PROJECT_NAME=schema-studio`: it is what makes compose look for
   the name above. Add the Microsoft sign-in lines from that step too, with a
   client secret made for this machine.

3. Start it without building:

   ```bash
   docker compose up -d --no-build
   docker compose ps
   ```

   `--no-build` makes compose use the loaded image instead of building one
   from the source. Both containers should say `healthy` within two minutes.
   Then open http://localhost:3000. The first person to sign in becomes the
   Admin, as "The first sign-in makes the admin" in README.md explains.

The database starts empty, and the app makes its tables when it starts.
Leave `DATABASE_URL_A` and `LOCAL_DATABASE_URL` out of `.env`: the copy then
keeps everything in its own database.

## Running it some other way

With plain `docker run`, Portainer or Kubernetes instead, the container needs:

- A PostgreSQL 17 database it can reach, given as `DATABASE_URL_A`, a
  connection string such as
  `postgres://<user>:<password>@<host>:5432/<database>`. Add
  `?sslmode=disable` at the end if the database serves no SSL, as the
  `postgres` image does not.
- `NEXTAUTH_SECRET` and `APP_ENCRYPTION_KEY`: long random values, made with
  `openssl rand -hex 32` and kept the same from then on. A new
  `APP_ENCRYPTION_KEY` makes every saved connection password and GitHub
  access token unreadable.
- `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET` and `AZURE_AD_TENANT_ID`,
  for Microsoft sign-in, with the redirect URI
  `<the address>/api/auth/callback/microsoft-entra-id` on the registration's
  Web platform.
- `AUTH_URL`: that address, such as `http://localhost:3000` or
  `https://<the link>`, with no path. Sign-in builds Microsoft's return
  address from it, because inside the container the app sees only
  `0.0.0.0`. Compose sets `http://localhost:3000` by itself.
- Port 3000 published, with `https` in front of it for any address but
  localhost (see "Before the link is made public" in README.md).

The optional settings are the other names under `app`, `environment` in
`docker-compose.yml`. The container's own health check loads `/login`.

## Updating it later

The image is one version, frozen: unlike the server, it does not update
itself. For a newer version, make a new file on the server, load and tag it
the same way, and run `docker compose up -d --no-build` again. The data stays
in its volume across the swap.

## Bringing the data along

Only if the other machine should start with this server's data instead of an
empty database. A copy of the database (`./deploy/backup.sh`, see step 8 of
README.md) goes in with the steps at the top of [backup.sh](backup.sh). That
copy is as secret as `.env`: it holds everyone's accounts and saved
connections. The connection passwords and GitHub access tokens in it open
only with this server's `APP_ENCRYPTION_KEY`. Without that key the other
machine still gets everything else, and those passwords and tokens have to be
entered again there. If the key goes too, send it apart from the copy, never
in the same place.
