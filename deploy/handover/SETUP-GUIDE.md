# Schema Studio setup guide

This guide takes one Ubuntu machine (Ubuntu on WSL counts) from nothing to a
running Schema Studio that you sign in to with your own Microsoft account. It
assumes Docker Engine and PostgreSQL 16 on that machine.

The quick way is one script, `setup.sh`, that does most of the work for you:
see [The quick way: one command](#the-quick-way-one-command). Allow about 20
minutes, most of it in the Microsoft screens. Every step also has its exact
commands, for doing it by hand or for seeing exactly what the script does.

What you end up with:

* the Schema Studio web app, running in one Docker container, at
  http://localhost:3000;
* its own data (organizations, people, roles, saved connections, script
  versions, approvals, history) in a database called `schema_studio` on your
  PostgreSQL 16, owned by a login that can do nothing else;
* sign-in through your own Microsoft Entra ID app registration;
* optionally, every deployed script kept in your own private GitHub
  repository.

Nothing in this kit points at our accounts. Every ID, secret and address is
yours.

## Contents

**Quick way:** [one command](#the-quick-way-one-command) does steps 2 to 5
and 7 for you.

**Step by step:**

1. [Check Docker and PostgreSQL](#1-check-docker-and-postgresql)
2. [Put the files in place and load the image](#2-put-the-files-in-place-and-load-the-image)
3. [Make the database and its login](#3-make-the-database-and-its-login)
4. [Create the tables](#4-create-the-tables)
5. [Fill in the settings file](#5-fill-in-the-settings-file)
6. [Register the app with Microsoft](#6-register-the-app-with-microsoft)
7. [Start Schema Studio](#7-start-schema-studio)
8. [Sign in and set up your organization](#8-sign-in-and-set-up-your-organization)
9. [Connect a GitHub repository for scripts](#9-connect-a-github-repository-for-scripts)
10. [Add your first database](#10-add-your-first-database)

Then: [Who can read what](#who-can-read-what),
[Using your own Supabase instead](#using-your-own-supabase-instead),
[Day to day](#day-to-day), [Settings reference](#settings-reference),
[Common problems](#common-problems), [For developers](#for-developers).

## How it fits together

```
 Your browser
     |  http://localhost:3000
     v
 +------------------------------+         +-----------------------------+
 | schema-studio container      |  SQL    | PostgreSQL 16 on this       |
 | (Next.js server, port 3000,  |-------->| machine: database           |
 |  runs as an unprivileged     |         | schema_studio, the app's    |
 |  user, read-only files)      |         | own data                    |
 +------------------------------+         +-----------------------------+
     |            |           |
     |            |           +--> the databases you compare and deploy to
     |            |                (added on the Connections screen)
     |            +--> Microsoft Entra ID, for sign-in
     +--> GitHub (optional), a private repository of deployed scripts
```

The container shares the machine's network (Docker's "host" networking), so
from inside it, `127.0.0.1` is this machine. That is why PostgreSQL needs no
network changes: the app reaches it at `127.0.0.1:5432` exactly as `psql`
does.

## What is in this folder

| File | What it is |
| --- | --- |
| `SETUP-GUIDE.md` | This guide. |
| `setup.sh` | Does steps 2 to 5 and 7 in one go, and asks for the values from step 6 ([The quick way](#the-quick-way-one-command)). |
| `docker-compose.yml` | Runs the app container. The only service; there is no database container. |
| `example.env` | Every setting the app reads, with notes. Copied to `.env` in step 5. |
| `sql/01-database-and-login.sql` | Makes the login and the database, with its privileges (step 3). |
| `sql/02-schema-studio-tables.sql` | Every table, index and constraint the app uses, as plain SQL (step 4). |
| `docker-compose.docker-desktop.yml` | Only for Docker Desktop on a Mac. Not used on Ubuntu. |
| `make-sql.sh` | For developers: makes `02` again after a change to the app's tables. |
| `schema-studio-app-<version>.tar.gz` | The app image, with a `.sha256` file to check it. In the download, not in the repository. |

The download has two more things beside this `kit` folder: the image file
above, and `source/`, the code at the same version as the image. In it,
`docs/DEVELOPER-MANUAL.md` explains how the app is built; see [For
developers](#for-developers).

## The quick way: one command

`setup.sh` does steps 2 to 5 and 7 for you, and asks for the three values
from step 6. In this order:

1. Do [step 1](#1-check-docker-and-postgresql): Docker Engine and PostgreSQL
   16 installed.
2. Do [step 6](#6-register-the-app-with-microsoft), the Microsoft app
   registration, and keep its three values at hand: the **Application
   (client) ID**, the **Directory (tenant) ID** and the client secret's
   **Value**. Skip its last part (putting them in `.env` with `nano`); the
   script does that.
3. Download the zip and copy it into your Ubuntu home folder, as in the first
   part of [step 2](#2-put-the-files-in-place-and-load-the-image) (up to the
   `cp` command). Then unzip it:

   ```bash
   mkdir -p ~/schema-studio-download && cd ~/schema-studio-download && unzip -o ~/schema-studio-handover.zip
   ```

4. Run the script as yourself, not with `sudo`:

   ```bash
   bash ~/schema-studio-download/kit/setup.sh
   ```

   It asks for your sudo password, then for the three Microsoft values (the
   secret stays hidden while you paste it). It ends with `Schema Studio is
   running`.
5. Carry on with [step 8](#8-sign-in-and-set-up-your-organization), and sign
   in first yourself.

What it does, and the step that does the same by hand:

| The script | By hand |
| --- | --- |
| Starts PostgreSQL and Docker if they are stopped, and finds PostgreSQL 16's port | step 1 |
| Checks the image file against its `.sha256` and loads it into Docker | step 2 |
| Makes `/opt/schema-studio`, which only you can open, and copies the kit into it | step 2 |
| Makes the login `schema_studio` and its database with a random password (`sql/01`, run as `postgres`), and checks the login works | step 3 |
| Loads `sql/02` as that login, so it owns every table | step 4 |
| Makes `.env`, which only you can read, with the database address and two random keys | step 5 |
| Asks for the three Microsoft values and puts them in `.env` | step 6, last part |
| Starts the app and waits until it answers | step 7 |

Good to know:

* It never prints a password, a key or the secret. They live in
  `/opt/schema-studio/.env` only.
* Press Enter at a Microsoft question to skip the questions. It then sets up
  everything else and stops before starting the app. Do step 6, then run
  `bash /opt/schema-studio/setup.sh`.
* Running it again is safe. It keeps what is done already, above all the
  password and the keys in `.env`, and does only what is missing. So it is
  also how to start everything after Windows restarts, and, run from a newer
  download, how to [install a new version](#day-to-day).
* If `docker` needs `sudo` on your machine, the script uses `sudo` for it. It
  stops on Docker Desktop (see [Docker Desktop instead of Docker
  Engine](#docker-desktop-instead-of-docker-engine)).
* When something stops it, it says what, and what to do or which part of this
  guide helps. Fix that and run it again.
* For your own Supabase as the app's database, see [Using your own Supabase
  instead](#using-your-own-supabase-instead).

Steps 2 to 7 below are the same work by hand. Read them to see exactly what
the script did, or follow them instead of it.

## 1. Check Docker and PostgreSQL

Docker Engine with the Compose plugin:

```bash
docker version --format 'Docker {{.Server.Version}}'
```

```bash
docker compose version
```

```bash
docker info --format '{{.OperatingSystem}}'
```

You need Docker 24 or newer and Compose 2.20 or newer. The last command must
name your Ubuntu (for example `Ubuntu 24.04.1 LTS`). If it says `Docker
Desktop`, see [Docker Desktop instead of Docker
Engine](#docker-desktop-instead-of-docker-engine).

**If a `docker` command says "permission denied while trying to connect to the
Docker daemon socket"**, your user may not use Docker yet. Pick one way and
keep to it for the whole guide:

* put `sudo` in front of every `docker` command in this guide, for example
  `sudo docker compose ps`; or
* add yourself to the `docker` group once, then sign out of Ubuntu and back
  in (on WSL: close Ubuntu, run `wsl --shutdown` in Windows PowerShell, open
  Ubuntu again). Read [Who can read what](#who-can-read-what) first: that
  group is as strong as root.

```bash
sudo usermod -aG docker "$USER"
```

After signing back in, `docker info` works without `sudo`.

PostgreSQL 16:

```bash
sudo -u postgres psql -tAc 'SHOW server_version'
```

It must start with `16`. On WSL, PostgreSQL does not start on its own; if the
command above cannot connect, start it and try again:

```bash
sudo service postgresql start
```

If there is more than one PostgreSQL on the machine, list them and note the
port of the 16 one:

```bash
pg_lsclusters
```

This guide uses port 5432. If yours is different, put `-p <port>` after
`psql` in steps 3 and 4 and use that port in step 5. (`setup.sh` finds the
port itself.)

No PostgreSQL 16 yet? On Ubuntu 24.04 it is the standard package:

```bash
sudo apt update && sudo apt install -y postgresql-16
```

On Ubuntu 22.04, add PostgreSQL's own package source first:

```bash
sudo apt install -y postgresql-common && sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y && sudo apt install -y postgresql-16
```

The commands also need `openssl`, `sha256sum` and `unzip`, which Ubuntu
normally has. If one is missing: `sudo apt install -y openssl coreutils unzip`.

## 2. Put the files in place and load the image

You get the image and this kit as one file, `schema-studio-handover.zip`
(about 107 MB), from the Google Drive link you were sent.

1. Open the link and download the zip. Drive may say it cannot scan the file
   for viruses because it is large; choose **Download anyway**. The check
   below confirms the image arrived intact.
2. Copy the zip into your Ubuntu home folder. On WSL, Windows downloads are
   at `/mnt/c/Users/<your Windows name>/Downloads/`, so for example:

```bash
cp "/mnt/c/Users/<your Windows name>/Downloads/schema-studio-handover.zip" ~/
```

If the link no longer works, ask for a new one, or build the image yourself
("For developers" at the end).

Taking the quick way? Go back to [The quick way](#the-quick-way-one-command)
now. By hand, carry on here.

Unzip it into a new folder and check the image arrived intact:

```bash
mkdir -p ~/schema-studio-download && cd ~/schema-studio-download && unzip -o ~/schema-studio-handover.zip
```

```bash
sha256sum -c schema-studio-app-*.tar.gz.sha256
```

It must print `OK`. If it prints `FAILED`, download the zip again.

Make the folder the app will run from. Only you can open it:

```bash
sudo install -d -m 700 -o "$USER" -g "$USER" /opt/schema-studio
```

```bash
cp -r ~/schema-studio-download/kit/. /opt/schema-studio/
```

```bash
cd /opt/schema-studio && ls
```

Load the image into Docker, then check its name (if `docker` needs `sudo` for
you, put it in front, as [step 1](#1-check-docker-and-postgresql) says):

```bash
docker load -i ~/schema-studio-download/schema-studio-app-*.tar.gz
```

```bash
docker image ls schema-studio-app
```

You see the image twice, as `handover` and as a 12 character version, both
with the same IMAGE ID. `docker-compose.yml` uses `handover`. Once loaded,
the download is no longer needed. Its `source/` folder has the code and the
developer manual; to keep it, move it out first:

```bash
mv ~/schema-studio-download/source ~/schema-studio-source
```

Then delete the rest:

```bash
rm -r ~/schema-studio-download ~/schema-studio-handover.zip
```

## 3. Make the database and its login

The app keeps its own data in a database of its own, reached with a login of
its own. Make a long random password for that login. It stays in this
terminal only, so do steps 3, 4 and 5 in the same terminal window:

```bash
export SS_DB_PASSWORD="$(openssl rand -hex 24)"
```

Run the first SQL file as the `postgres` superuser:

```bash
cd /opt/schema-studio && sudo --preserve-env=SS_DB_PASSWORD -u postgres psql -v ON_ERROR_STOP=1 -f - < sql/01-database-and-login.sql
```

It ends with `Done: login schema_studio and database schema_studio are
ready.` A line saying `could not change directory to "/opt/schema-studio"` is
harmless: the `postgres` user cannot open your folder, which is the point.

What the file does, in plain words (open it to read the SQL):

| Command | Why |
| --- | --- |
| `CREATE ROLE schema_studio LOGIN ... NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ...` | The app's login. It can sign in and nothing more. |
| `CREATE DATABASE schema_studio OWNER schema_studio` | The app's database. The owner may create and change tables in it. |
| `REVOKE ALL ON DATABASE schema_studio FROM PUBLIC` | Other logins on this PostgreSQL can no longer even connect to it. |
| `ALTER SCHEMA public OWNER TO schema_studio` | The app's tables live in `public`, and it belongs to the app's login. |
| `REVOKE ALL ON SCHEMA public FROM PUBLIC` | Nobody else can create objects in it or look into it. |

The app needs no superuser, no extensions and no other database. On every
start it adds any table or column a newer version needs, which is why its
login owns the tables rather than only being allowed to use them.

Check the login works, over the network port the app will use:

```bash
PGPASSWORD="$SS_DB_PASSWORD" psql -h 127.0.0.1 -U schema_studio -d schema_studio -tAc 'SELECT current_user'
```

It prints `schema_studio`.

## 4. Create the tables

Load the second file as the app's own login, so that login owns every table:

```bash
cd /opt/schema-studio && PGPASSWORD="$SS_DB_PASSWORD" psql -h 127.0.0.1 -U schema_studio -d schema_studio -v ON_ERROR_STOP=1 -q -f sql/02-schema-studio-tables.sql
```

It prints one small table with an empty `set_config` column and `(1 row)`.
That is normal: it comes from a setting at the top of the file. Any `ERROR`
line means it stopped; nothing after the error was created.

Check:

```bash
PGPASSWORD="$SS_DB_PASSWORD" psql -h 127.0.0.1 -U schema_studio -d schema_studio -c '\dt'
```

You see the app's tables, all owned by `schema_studio`.

This step is optional. On an empty database the app creates exactly the same
tables itself on its first start (our CI checks that the two match). Loading
the file first lets you, or your database administrator, read and approve
every table before the app runs. On its first start the app then adds only
the rows it needs: the default organization and its built-in roles.

## 5. Fill in the settings file

Make `.env` from the template, readable by you only, and fill in the values
that are generated rather than chosen:

```bash
cd /opt/schema-studio && cp example.env .env && chmod 600 .env
```

```bash
sed -i "s|^DATABASE_URL_A=.*|DATABASE_URL_A=postgres://schema_studio:${SS_DB_PASSWORD}@127.0.0.1:5432/schema_studio|" .env
```

```bash
sed -i "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=$(openssl rand -hex 32)|" .env
```

```bash
sed -i "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=$(openssl rand -hex 32)|" .env
```

The database password now lives in `.env` only. Clear it from the terminal:

```bash
unset SS_DB_PASSWORD
```

Check the three lines are filled in (this prints the names only, not the
values):

```bash
grep -E '^(DATABASE_URL_A|NEXTAUTH_SECRET|APP_ENCRYPTION_KEY)=.+' .env | cut -d= -f1
```

It lists all three names.

Keep a copy of the `APP_ENCRYPTION_KEY` line in your password manager. The
app encrypts every saved database password and GitHub token with it. If it is
lost or changed, those saved secrets cannot be read and have to be typed in
again. `NEXTAUTH_SECRET` matters less: changing it only signs everyone out.

The Microsoft values come next, in step 6.

## 6. Register the app with Microsoft

You need an account that may register applications in your Microsoft Entra
ID directory (by default every member may; otherwise ask your Entra admin for
the Application Developer role, or to do this step).

1. Go to https://entra.microsoft.com and choose **Entra ID**, then **App
   registrations**, then **New registration**.
2. **Name:** `Schema Studio` (people see it on the Microsoft sign-in page).
3. **Supported account types:** *Accounts in this organizational directory
   only (single tenant)*.
4. **Redirect URI:** choose the platform **Web** (not "Single-page
   application") and enter exactly:

   ```
   http://localhost:3000/api/auth/callback/microsoft-entra-id
   ```

   Microsoft accepts `http` only for `localhost`. Any other address must be
   `https`; see [Reaching it from another
   computer](#reaching-it-from-another-computer).
5. Press **Register**. On the **Overview** page copy the **Application
   (client) ID** and the **Directory (tenant) ID**.
6. Open **Certificates & secrets**, then **Client secrets**, then **New
   client secret**. Give it a description and an expiry (the app stops
   signing people in when it expires; note the date). Press **Add** and copy
   the **Value** column straight away. Microsoft shows it only once. The
   **Secret ID** column is not the secret.
7. **API permissions:** leave it as it is. The app asks only for your name and
   email address (`openid`, `profile`, `email` and Microsoft Graph
   `User.Read`, which is there already). If your directory requires admin
   consent for apps, an Entra admin presses **Grant admin consent** here.

Taking the quick way? Stop here: `setup.sh` asks for the three values and
puts them in `.env` itself. By hand, put them into `.env` with an editor, so
the secret never lands in your shell history:

```bash
nano /opt/schema-studio/.env
```

Fill in `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET` and
`AZURE_AD_TENANT_ID`. Leave `AZURE_AD_ANY_ACCOUNT` empty. Save with Ctrl+O,
Enter, and leave with Ctrl+X.

Optional: to choose who may sign in at all, open **Enterprise applications**,
then **Schema Studio**, then **Properties**, set **Assignment required** to
**Yes**, and add people under **Users and groups**. Without it, anyone in your
directory can sign in, but they see nothing until an Admin invites them
(step 8).

## 7. Start Schema Studio

```bash
cd /opt/schema-studio && docker compose up -d --wait
```

`--wait` returns once the app answers its health check, usually within 30
seconds. If Compose names a missing setting instead, fill it in `.env` and run
the command again. If it says "permission denied" on the Docker socket, run it
as `sudo docker compose up -d --wait` (see [step 1](#1-check-docker-and-postgresql)). Then:

```bash
docker compose ps
```

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
```

The first shows the `app` service as `healthy`; the second prints `200`. To
watch what the app prints (Ctrl+C stops watching, not the app):

```bash
docker compose logs -f app
```

It restarts on its own after a crash or a reboot, as long as Docker starts at
boot (`sudo systemctl enable docker`; on WSL, Docker starts when the
distribution does, if systemd is on).

## 8. Sign in and set up your organization

Open http://localhost:3000 in a browser on this machine (on WSL, a Windows
browser works too), press **Log in**, then **Continue with Microsoft**.

* **The first person from your directory to sign in becomes the Admin of the
  default organization.** That is Admin of that organization only. There is
  no app-wide administrator: every organization is run by its own Admins.
* Everyone after that lands on **Your organizations** with nothing in it,
  until an Admin invites them. Sign in first yourself.

Then, as the Admin:

1. **Admin, Organization:** the default organization is called "Swinburne
   FYP". Rename it to your team's name.
2. **Admin, Users, Invite people:** invite your team. Either to one email
   address, with any role, or as a link anyone can use, always as a Viewer.
   The app sends no email: it shows you the link once, and you send it.
3. **Admin, Roles & permissions:** what each role may do. The built-in roles
   are a sensible start; change them later if you need to.

Anyone signed in can also make a new organization of their own on the **Your
organizations** page, and is its Admin.

## 9. Connect a GitHub repository for scripts

Optional, but recommended: every script deployed through the app is then
also saved, with its version and who approved it, in a private GitHub
repository. You can give the app either a repository that already exists, or
a name for one it makes for you.

**Make the token.** Pick one of three.

**A. Simplest, the app makes the repository.** A classic token:

1. https://github.com/settings/tokens, then **Generate new token (classic)**.
2. Note: `Schema Studio`. Expiration: your choice (the push stops working
   when it expires).
3. Scope: tick **repo** (full control of private repositories, which
   includes creating them). Nothing else.
4. **Generate token** and copy it.

**B. Fine-grained, the app makes the repository.**

1. https://github.com/settings/personal-access-tokens/new
2. **Resource owner:** your account, or your GitHub organization if the
   repository should live there (the organization may need to approve
   fine-grained tokens first).
3. **Repository access:** *All repositories* (a token limited to chosen
   repositories cannot make a new one).
4. **Repository permissions:** **Administration**: Read and write (to make the
   repository), **Contents**: Read and write (to save scripts). **Metadata**:
   Read-only is added on its own.
5. **Generate token** and copy it.

**C. Least access: you make the repository, the token can touch only that
one.**

1. Make a new **private** repository on GitHub, for example
   `schema-scripts`.
2. https://github.com/settings/personal-access-tokens/new, **Repository
   access:** *Only select repositories*, and pick that repository.
3. **Repository permissions:** **Contents**: Read and write. **Metadata**:
   Read-only is added on its own. Nothing else.
4. **Generate token** and copy it.

**Give it to the app.** In Schema Studio, open **Admin, GitHub**. Enter the
repository as `owner/name` (for example `your-team/schema-scripts`) and paste
the token. Press **Save**. The app checks the token can reach the
repository, makes it if it does not exist (A and B only), and says which. The
token is stored encrypted with `APP_ENCRYPTION_KEY` and never shown again.

Each organization has its own repository and token. The `GITHUB_*` lines in
`.env` are only a fallback for the default organization; leave them empty and
use this screen.

## 10. Add your first database

These are the databases you compare and deploy to, not the app's own
`schema_studio` database. Give Schema Studio its own login on each one, with
only what you want it to do there.

**Make a login that can read.** This is enough to compare schemas, write
scripts and watch for drift. On the machine with that database, open `psql`
on it (here the database is called `mydb`; use yours):

```bash
sudo -u postgres psql -d mydb
```

Then, inside `psql`, make the login and set its password (`\password` asks
for it twice and does not show it):

```sql
CREATE ROLE ss_reader LOGIN;
```

```sql
\password ss_reader
```

Let it read each schema you want to compare (here `app_v1`; repeat the
three lines for every schema):

```sql
GRANT CONNECT ON DATABASE mydb TO ss_reader;
GRANT USAGE ON SCHEMA app_v1 TO ss_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA app_v1 TO ss_reader;
```

Leave with `\q`.

**To deploy scripts as well,** the login needs the rights the scripts need:
usually it must own the tables it changes, and it needs `CREATE` on the
schema, because the app keeps a small `script_patch` table there that
records which scripts ran. The simplest choice is the login your own
application already uses for that schema.

**Add it in the app.** Open **Connections**, then **Add connection**, and fill
in:

| Field | For a PostgreSQL on this machine |
| --- | --- |
| Quick start | Press **Local Postgres** first. It fills in a name, `localhost`, port 5432 and the security setting; then change the fields below to yours. |
| Friendly name | Anything you will recognise, for example `mydb (test)`. |
| Host | `localhost`. The container shares this machine's network, so this is the same address `psql` uses. A database elsewhere on your network: its name or address. |
| Port | `5432` |
| Database | `mydb` |
| User | `ss_reader` |
| Password | The one you just set. It is saved encrypted with `APP_ENCRYPTION_KEY`. |
| Security | **Off** for a database on this machine. **Require** for a hosted one (Supabase, Neon, RDS). |
| Who may run migrations here | Leave it as it is. It only decides who may deploy here, and **Read-only** stops everyone. |
| Application table | Leave it empty. |

Press **Test connection**, then **Save connection**. If it says the address
is private, see [Common problems](#connecting-to-a-database-says-the-address-is-private).

Then try **Compare & Author** on two schemas, and **Take the tour** in the
account menu.

## Who can read what

This is the file and access setup from steps 2, 3 and 5 (which `setup.sh`
does the same way), in one place.

| What | Who can read it | Set by |
| --- | --- | --- |
| `/opt/schema-studio` | Only you (mode 700). Root can, as always. | step 2, `install -d -m 700` |
| `/opt/schema-studio/.env`, all secrets | Only you (mode 600) | step 5, `chmod 600 .env` |
| The app's database | The `schema_studio` login and superusers only | step 3, `REVOKE ALL ... FROM PUBLIC` |
| Saved database passwords and GitHub tokens | Encrypted in the database; readable only with `APP_ENCRYPTION_KEY` | the app |

The container:

* runs as an unprivileged user (uid 1001), never as root;
* holds no Linux capabilities and cannot gain any (`cap_drop: ALL`,
  `no-new-privileges`);
* cannot change its own files: its whole filesystem is read-only apart from
  two small in-memory folders, emptied whenever it stops;
* has no folder of this machine mounted into it, so it cannot read your files,
  `.env` included (Compose hands it the settings when it starts);
* is capped at 2 GB of memory and 200 processes.

Membership of the `docker` group is the same as root on this machine: anyone
in it can start a container that reads any file. Add only people who already
have `sudo`:

```bash
getent group docker
```

Check the permissions at any time:

```bash
stat -c '%a %U %n' /opt/schema-studio /opt/schema-studio/.env
```

It prints `700` and `600` with your user name.

## Using your own Supabase instead

The app's own database can be a Supabase project of yours instead of the
PostgreSQL on this machine. In your Supabase project press **Connect** and
copy the **Transaction pooler** string (port 6543). Put your database
password in place of `[YOUR-PASSWORD]`.

**Quick way:** give the string to `setup.sh` the first time it runs. Type
this, paste the string (it stays hidden) and press Enter:

```bash
read -rs DATABASE_URL_A && export DATABASE_URL_A
```

Then, in the same terminal:

```bash
bash ~/schema-studio-download/kit/setup.sh
```

It puts the string in `.env` and leaves PostgreSQL on this machine alone (you
do not even need one). In the password, write `@`, `#`, a quote or a space as
`%40`, `%23`, `%27` or `%20`, or the string does not work.

**By hand:** skip steps 3 and 4, and in step 5 put that string in `.env` as
`DATABASE_URL_A` (with `nano`, instead of the first `sed` line).

The app creates its tables on its first start. To create them yourself
first, paste `sql/02-schema-studio-tables.sql` into Supabase's **SQL Editor**
and run it. The app uses SSL for every database that is not on this machine,
and on start it closes its tables to Supabase's Data API (the `anon` and
`authenticated` roles), so they are reachable only through the app.

Everything else in this guide is the same.

## Day to day

| Task | Command (in `/opt/schema-studio`) |
| --- | --- |
| Stop | `docker compose down` |
| Start | `docker compose up -d --wait` |
| Is it up? | `docker compose ps` |
| What did it print? | `docker compose logs --tail 200 app` |
| Change a setting | edit `.env`, then `docker compose up -d --wait` |
| Start everything after Windows or the machine restarts | `bash /opt/schema-studio/setup.sh` |

If `docker` needs `sudo` for you (see [step 1](#1-check-docker-and-postgresql)),
put `sudo` in front of each `docker` command, for example `sudo docker compose ps`.

**Install a new version:** download the new `schema-studio-handover.zip`,
copy it into your Ubuntu home folder as in step 2, unzip it into an empty
folder and run the `setup.sh` inside it:

```bash
rm -rf ~/schema-studio-download && mkdir ~/schema-studio-download && cd ~/schema-studio-download && unzip ~/schema-studio-handover.zip
```

```bash
bash ~/schema-studio-download/kit/setup.sh
```

It checks and loads the new image, copies the new kit files into
`/opt/schema-studio` (your `.env` stays as it is) and restarts the app on the
new image. The app adds any new tables or columns itself when it starts. Your
data and settings stay.

By hand: check and load the image as in step 2 (`sha256sum -c`, `docker
load`), copy the new kit files over the old ones (`cp -r
~/schema-studio-download/kit/. /opt/schema-studio/`, which leaves `.env`
alone), then `docker compose up -d --wait`.

**Back up the app's data** (run it on a schedule, keep copies off this
machine):

```bash
sudo -u postgres pg_dump -Fc schema_studio > ~/schema-studio-$(date +%F).dump
```

**Restore** into an empty `schema_studio` database made by step 3:

```bash
sudo -u postgres pg_restore --no-owner --role=schema_studio -d schema_studio < ~/schema-studio-YYYY-MM-DD.dump
```

A backup is only half of it: keep `.env` (above all `APP_ENCRYPTION_KEY`)
safe too, or the saved passwords inside the backup cannot be read.

## Settings reference

Every setting lives in `.env`. Restart with `docker compose up -d --wait`
after a change.

| Setting | Needed | What it does |
| --- | --- | --- |
| `DATABASE_URL_A` | yes | The app's own database. SSL is used unless the host is `localhost`, `127.0.0.1` or `::1`, or the address ends in `?sslmode=disable`. |
| `NEXTAUTH_SECRET` | yes | Signs the sign-in cookie. Changing it signs everyone out. |
| `APP_ENCRYPTION_KEY` | yes | Encrypts saved passwords and tokens. Never change it once set. |
| `AZURE_AD_CLIENT_ID` | yes | Application (client) ID from the app registration. |
| `AZURE_AD_CLIENT_SECRET` | yes | The client secret's Value. |
| `AZURE_AD_TENANT_ID` | yes | Directory (tenant) ID. Its people are the "home directory": the first of them to sign in becomes Admin. |
| `AZURE_AD_ANY_ACCOUNT` | no | `true` lets accounts from any Microsoft directory sign in. Only with a registration set to *Accounts in any organizational directory*; otherwise sign-in fails for everyone. They still see nothing until invited. |
| `AUTH_URL` | no | The address people open, default `http://localhost:3000`. Must match the redirect URI on the registration. |
| `APP_BIND` | no | `127.0.0.1` (default, this machine only) or `0.0.0.0` (other computers too). |
| `APP_PORT` | no | The port, default 3000. Change `AUTH_URL` and the redirect URI with it. |
| `APP_IMAGE` | no | The image to run, default `schema-studio-app:handover`. |
| `ALLOW_PRIVATE_DB_HOSTS` | no | `true` (default here) allows databases at private addresses: `localhost`, `10.x`, `172.16.x` to `172.31.x`, `192.168.x`. |
| `GITHUB_PAT`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME` | no | A fallback repository for the default organization. Use **Admin, GitHub** instead. |
| `DRIFT_SCHEDULER` | no | `off` stops the background drift checks. **Check drift now** still works. |
| `AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL_FAST`, `AI_MODEL_SMART` | no | AI help (SQL from a description, explanations, summaries) through any service with an OpenAI-style API. Off unless the address, key and a model are set, and then off for each organization until its Admin turns it on in **Admin, AI**. An Admin can save the organization's own key there instead. |
| `AI_REASONING_EFFORT`, `AI_TIMEOUT_MS`, `AI_DAILY_LIMIT`, `AI_PER_MINUTE` | no | AI tuning: `low`/`medium`/`high`; time per call (default 90000 ms); calls per organization per day (default 300); calls per person per minute (default 10). |
| `APP_MEMORY_LIMIT` | no | The container's memory cap, default `2g`. |

## Common problems

Start with what the app printed:

```bash
cd /opt/schema-studio && docker compose logs --tail 100 app
```

### setup.sh stopped with a message

Its last lines say what went wrong and, under it, what to do or which part of
this guide helps. Fix that and run it again: it keeps what is done already
and carries on. The headings it prints name the matching step of this guide.

### "permission denied while trying to connect to the Docker daemon socket"

Your user may not use Docker yet. Put `sudo` in front of the command (`sudo
docker compose ps`), or add yourself to the `docker` group with `sudo usermod
-aG docker "$USER"` and sign out and back in. The [step 1](#1-check-docker-and-postgresql)
note has both ways, and the WSL restart.

### Compose says "required variable ... is missing a value"

That line in `.env` is empty. Fill it in (steps 5 and 6) and run `docker
compose up -d --wait` again.

### "password authentication failed for user schema_studio"

The password in `DATABASE_URL_A` does not match the login's. The quick fix:
empty that line and run the script, which gives the login a new random
password and puts it in `.env`:

```bash
sed -i 's|^DATABASE_URL_A=.*|DATABASE_URL_A=|' /opt/schema-studio/.env && bash /opt/schema-studio/setup.sh
```

By hand, set a new one and put it in `.env`:

```bash
export SS_DB_PASSWORD="$(openssl rand -hex 24)"
```

```bash
sudo --preserve-env=SS_DB_PASSWORD -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
\getenv p SS_DB_PASSWORD
ALTER ROLE schema_studio PASSWORD :'p';
SQL
```

```bash
cd /opt/schema-studio && sed -i "s|^DATABASE_URL_A=.*|DATABASE_URL_A=postgres://schema_studio:${SS_DB_PASSWORD}@127.0.0.1:5432/schema_studio|" .env && unset SS_DB_PASSWORD && docker compose up -d --wait
```

### "connect ECONNREFUSED 127.0.0.1:5432"

PostgreSQL is not running, or listens on another port. `sudo service
postgresql start`, and `pg_lsclusters` for the port.

### Step 3 says "role "schema_studio" already exists" or "database ... already exists"

Step 3 already ran. If the earlier run worked, carry on with a new password
as in "password authentication failed" above. To start over on a new install
(this deletes the app's data):

```bash
sudo -u postgres psql -c 'DROP DATABASE IF EXISTS schema_studio' -c 'DROP ROLE IF EXISTS schema_studio'
```

### "permission denied for schema public" or "must be owner of table"

`02` was loaded as `postgres` instead of `schema_studio`, so the app does not
own its tables. On a new install, drop both as above and do steps 3 and 4
again, loading `02` with the exact command in step 4.

### "The server does not support SSL connections"

The app uses SSL for any database host other than `localhost`, `127.0.0.1`
and `::1`. For a PostgreSQL without SSL reached by another name, end
`DATABASE_URL_A` with `?sslmode=disable`.

### Microsoft says AADSTS50011 (redirect URI mismatch)

The address you opened, `AUTH_URL` and the redirect URI on the registration
must be the same. Open `http://localhost:3000`, not `http://127.0.0.1:3000`.
If you changed the port or address, add the new redirect URI under
**Authentication** on the registration.

### Microsoft says invalid_client, AADSTS7000215 or AADSTS7000218

The secret is wrong or missing. Check `AZURE_AD_CLIENT_SECRET` is the
secret's **Value**, not its **Secret ID**, that it has not expired, and that
the redirect URI is under the **Web** platform, not "Single-page
application".

### Microsoft says AADSTS700016 or AADSTS90002

The client ID or tenant ID is wrong. Copy both again from the registration's
**Overview** page.

### Microsoft says AADSTS50194

`AZURE_AD_ANY_ACCOUNT=true` with a single tenant registration. Empty the
setting, or change the registration's supported account types.

### Signed in, but "Your organizations" lists nothing

Somebody signed in before you and became the Admin, or your account is from
another directory. Ask the Admin for an invitation. If the wrong person became
Admin of a new install, make yourself Admin too. Sign in once first, then run
this with the email address you signed in with:

```bash
sudo -u postgres psql -d schema_studio -v ON_ERROR_STOP=1 -v email='you@example.com' <<'SQL'
INSERT INTO memberships (org_id, profile_id, role)
SELECT o.id, p.id, 'admin'
  FROM organizations o, profiles p
 WHERE o.is_default AND lower(p.email) = lower(:'email')
ON CONFLICT (org_id, profile_id) DO UPDATE SET role = 'admin';
SQL
```

It prints `INSERT 0 1`. `INSERT 0 0` means no account with that address has
signed in yet.

### Connecting to a database says the address is private

Set `ALLOW_PRIVATE_DB_HOSTS=true` in `.env` (it is the default in this kit)
and restart.

### Port 3000 is already in use

Set `APP_PORT=3001` and `AUTH_URL=http://localhost:3001` in `.env`, add
`http://localhost:3001/api/auth/callback/microsoft-entra-id` as a redirect
URI on the registration, and restart.

### On WSL, the Windows browser cannot open localhost:3000

WSL normally passes `localhost` through to Windows. In PowerShell, run `wsl
--shutdown`, open Ubuntu again, start PostgreSQL and the app, and try again.
If it still fails, check `%UserProfile%\.wslconfig` does not set
`localhostForwarding=false`, or open the page with a browser inside WSL.

### Reaching it from another computer

Microsoft allows plain `http` only for `localhost`. For other computers, put
the app behind an HTTPS reverse proxy (nginx or Caddy) with a certificate for
its name, set `AUTH_URL=https://<that name>`, add
`https://<that name>/api/auth/callback/microsoft-entra-id` as a redirect URI,
and keep `APP_BIND=127.0.0.1` so only the proxy reaches the app. `APP_BIND`
other than `127.0.0.1` or `0.0.0.0` stops the health check working.

### Docker Desktop instead of Docker Engine

This kit is made for Docker Engine on Ubuntu, and on Windows the easiest way
to get it is inside your WSL Ubuntu
(https://docs.docker.com/engine/install/ubuntu/). Docker Desktop runs
containers in a separate virtual machine, so `127.0.0.1` inside the
container is not your machine. On a Mac with Docker Desktop:

1. Uncomment the `COMPOSE_FILE=` line at the bottom of `.env`.
2. Use `host.docker.internal` as the host, both in `DATABASE_URL_A` (ending
   with `?sslmode=disable`) and for databases you add in the app (there, set
   **Security** to **Off**).

PostgreSQL on the Mac sees these connections coming from `127.0.0.1`, so a
PostgreSQL that only listens on `localhost` (the default) accepts them with no
change to its settings.

We have tested Docker Desktop only on a Mac (with PostgreSQL 16 from
Homebrew).

### The app keeps restarting

`docker compose logs app` says why, almost always a database address or
password. A line with `tick failed` in it is the background drift check
failing to reach the app's database; it tries again on its next round.

## For developers

The code comes in the download, in `source/` beside `kit/`: the whole
repository at the version of the image, without its history. The app is in
`source/my-app` (Next.js 16, React 19, TypeScript, PostgreSQL through `pg`
and Sequelize). Start with `source/docs/DEVELOPER-MANUAL.md`, the design
document: how the app is built, where each feature lives, how roles work, the
data model, and step by step recipes for common changes. Next to it,
`source/docs/RAW-SQL.md` explains why most of the SQL is written by hand.
The commands below run from the repository root, or from `source/`, which is
the same files.

Every green CI run on the `handover` branch also offers the same zip:
open the repository's **Actions** tab, the **CI** workflow, the run, then
**Artifacts**, `schema-studio-handover` (you must be signed in to GitHub;
each run's download is kept for 90 days). That is where the Drive copy comes
from. Use the CI one rather than an image built on an Apple Silicon Mac, which
is made for ARM and will not run properly on an ordinary Intel or AMD PC.
CI also runs `setup.sh` from that same download on a fresh Ubuntu with
PostgreSQL 16 (the `handover-script` job): before the Microsoft values, with
them, again with nothing to do, and after a restart.

Build the image yourself, from the repository root:

```bash
docker build -t schema-studio-app:handover my-app
```

With no image file beside the kit, `setup.sh` uses the
`schema-studio-app:handover` already in Docker, so `bash
deploy/handover/setup.sh` from the repository root sets up a locally built
image the same way.

After any change to the app's tables (`my-app/lib/db/models`,
`my-app/lib/db/bootstrap.ts`), make `sql/02` again from the new image and
commit it. CI fails while the committed file is out of date.

```bash
bash deploy/handover/make-sql.sh schema-studio-app:handover
```

Run it without Docker while you work on it:

```bash
cd my-app && npm ci && cp .env.local.example .env.local
```

Point `DATABASE_URL_A` in `.env.local` at a database of your own (a second
one, not the live `schema_studio`), add the Microsoft values, then:

```bash
npm run dev
```

`npm test`, `npm run lint` and `npm run typecheck` are what CI runs.
