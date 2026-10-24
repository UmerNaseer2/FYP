# Schema Studio for Ubuntu

The desktop version of Schema Studio: the same app as the web version
(`my-app`), running on the computer itself in a window of its own, installed
from a `.deb` package.

## What it does

- Runs Schema Studio's server on the computer, where only the app itself can
  reach it.
- Keeps its own data (connections, saved scripts, version history) in a
  PostgreSQL 17 of its own, which it starts and stops itself. Nothing has to
  be installed or set up first.
- Finds the PostgreSQL databases already running on the computer, on ports
  5432 to 5439 and in Docker, and fills in the connection form for them
  (Connections, then Find databases). It never reads a password: that is
  still typed in by hand.
- Signs in with Microsoft in the computer's own web browser. After that it
  keeps working offline for up to 30 days. Whenever it is online it checks
  with Microsoft every few hours, so an account that has been disabled is
  signed out.
- The first person to sign in becomes the admin, as on the web version.
  Everyone after them starts as a viewer.
- Makes its own secret keys the first time it starts, so the installer holds
  no secrets at all. They are kept in files only the account can read and,
  where there is a login keyring (GNOME Keyring or KWallet), locked with it
  as well.
- The GitHub token, for keeping schemas in a GitHub repository, is typed into
  Settings (File, then Settings) and kept the same way.
- Lets phones you pair see the schemas of the saved connections you choose,
  while Schema Studio is running (File, then Settings, then Phone). A phone
  pairs by pointing its camera at a code the app shows. What the two send each
  other is encrypted end to end and goes through a relay your team runs (see
  `relay/README.md`), which passes it on but cannot read it. The phone link's
  keys are kept the same way as the others. The page the phones open is still
  being built.
- Can keep running with its window closed, so paired phones can still reach
  it (File, then Settings, then Background). Its icon in the top bar opens
  the window again and quits the app, and opening Schema Studio from the app
  grid brings the window back too. It can also start when you sign in to
  Ubuntu, and with Keep running on as well it then starts with only its icon
  showing.
- Shows a notification when a scheduled drift check finds new drift, finds
  it fixed, or cannot reach the database, and opens that schema on the
  Drift page when you click it. A notification names the schema and its
  connection, never a host or an error message. With Keep running on, this
  works with the window closed too. It can be turned off (File, then
  Settings, then Notifications).
- Saves everything Schema Studio keeps (the saved connections and the key
  that unlocks their passwords, the comparison and drift history, the
  people and their roles, and the GitHub registry and its token) into one
  file locked with a passphrase, and restores such a file on this computer
  or another one (File, then Settings, then Backup). A wrong passphrase or
  a damaged file is found before anything changes. After a restore the app
  starts again, everyone signs in again, and paired phones see no
  connections until you choose them again.

## Supported systems

Ubuntu 20.04, 22.04, 24.04 and 26.04, and the newest Ubuntu release that is
not an LTS, on amd64 (most PCs) and on arm64. Each processor has its own
`.deb`. The desktop workflow installs each one on every one of these versions
and runs its self-test there.

## Installing and removing

Each run of the desktop workflow on GitHub keeps the two `.deb` files it
built, under Artifacts on the run's page. Each one downloads as a zip file
with the `.deb` inside. To make one by hand, see Building the .deb below.

```bash
sudo apt install ./schema-studio_2.0.0_amd64.deb
```

On an arm64 computer the file is `schema-studio_2.0.0_arm64.deb`. The `./`
matters: it tells apt to install that file rather than look for a package
online. Schema Studio is then in the app grid, and `schema-studio` starts it
from a terminal.

```bash
sudo apt remove schema-studio
```

Removing it leaves the data where it is (see below), so installing it again
carries on where it left off.

## Where it keeps things

| Folder | What is in it |
| --- | --- |
| `~/.config/schema-studio` | Settings (`config.json`), the saved Microsoft sign-in (`auth.json`), the phone link's keys and paired phones (`phone-link.json`) and the window's own browser profile |
| `~/.local/share/schema-studio` | The app's own PostgreSQL database and the keys that protect what is saved in it (`secrets.json`) |
| `~/.local/state/schema-studio/logs` | Logs, which can be deleted at any time |
| `~/.config/autostart` | Only while start at sign-in is on: `io.github.umernaseer2.SchemaStudio.desktop`, the file that has Ubuntu start Schema Studio when you sign in. The folder is Ubuntu's, and other apps keep files in it too |

Back up or move `~/.local/share/schema-studio` as a whole: the database is no
use without its keys. The folders follow `XDG_CONFIG_HOME`, `XDG_DATA_HOME`
and `XDG_STATE_HOME` when those are set. To start completely fresh, quit
Schema Studio and delete the three `schema-studio` folders. Removing the app
leaves the start-at-sign-in file behind if start at sign-in was on, but
Ubuntu skips the file once the app is gone. Turning start at sign-in off
before removing the app takes the file away.

## When something goes wrong

- **Help, then Open Logs** opens the logs folder.
- **Help, then Copy Diagnostics** copies a report to paste into an email or a
  message: the version, what it runs on, how far the app got, where its files
  are and the end of each log. The app's keys and tokens, passwords inside
  database addresses and email addresses are taken out first.
- **Help, then About Schema Studio** shows the version and the commit it was
  built from.

**View, then Appearance** chooses Match Ubuntu, Light or Dark.

## Building the .deb

Build on Ubuntu, with Node.js 22, npm, git, about 4 GB of free space and an
internet connection (for the npm packages, Electron, PostgreSQL and the fonts
the web app uses).

```bash
cd desktop
npm ci
npm run dist:deb
```

The `.deb` is then in `desktop/dist`, for the processor of the computer that
built it. `npm run dist:deb` runs these steps in order, and each can be run on
its own:

1. `npm run build:ts` compiles the TypeScript in `src` into `out`.
2. `npm run build:config` writes the Microsoft sign-in IDs (next section) into
   `out/build-config.json`.
3. `npm run build:server` builds the web app as a standalone Next.js server in
   `build/server`. It works from a clean copy of the files git knows about,
   leaves every `.env` file out, and throws the result away if a secret from
   one, or anything that looks like a token or a private key, turns up in it
   anyway.
4. `npm run fetch:postgres` puts PostgreSQL 17 in `build/postgres`, after
   checking the download against its pinned checksum.
5. electron-builder packs it all into the `.deb`, and
   `scripts/after-pack.cjs` puts the server and PostgreSQL next to the app,
   checking that the programs in it are built for the right processor.

## Setting up Microsoft sign-in

The desktop app signs in with the same Microsoft Entra app registration as the
web version. It needs one addition there, made once:

1. In [portal.azure.com](https://portal.azure.com), open Microsoft Entra ID,
   then App registrations, then Schema Studio.
2. Open Authentication, choose Add a platform, then Mobile and desktop
   applications.
3. Add `http://localhost` as a custom redirect URI, and save.

Then give the build the registration's two IDs, from its Overview page. They
are public IDs, not secrets. Put them in `desktop/.env.desktop`, which git
ignores:

```text
AZURE_AD_CLIENT_ID=<the Application (client) ID>
AZURE_AD_TENANT_ID=<the Directory (tenant) ID>
```

For the desktop workflow, add the same two names as repository variables in
GitHub (Settings, then Secrets and variables, then Actions, then Variables).

There is no client secret to add. The desktop app signs in the way Microsoft
asks desktop apps to, with PKCE: a one-time secret it makes for each sign-in.
A build without the IDs still starts, but signing in then says that sign-in
is not set up in that copy.

## Trying it while developing

This works on Ubuntu and on a Mac:

```bash
cd desktop
npm ci
npm run build:server
npm run fetch:postgres
npm start
```

`build:server` and `fetch:postgres` only need running again after `my-app`
changes or PostgreSQL's version does. `npm start` compiles the app and opens
it.

## Tests

```bash
npm test
```

compiles everything and runs the unit tests. An installed copy can also check
itself, with no screen or person needed:

```bash
schema-studio --self-test
```

It runs the same steps as a normal start, in folders of its own that are
removed afterwards: it makes the app's keys, starts the database and the
server, checks that the server turns away a request that is not from the app,
loads the sign-in page, waits for the tables, and turns start at sign-in on
and off in its own folders. It prints a JSON report and exits with 0 only
when every step worked. It leaves the keyring alone. On a computer without a
screen, run it under `xvfb-run`.

## The icon

`assets/icon.svg` is the picture. `assets/icon.png`, which Ubuntu shows, is
drawn from it. After changing the SVG, run `npm run make-icon` and commit
both.

## How it fits together

- `src/main` is the app itself: its windows, menus and top bar icon, the
  sign-in, the keyring, and starting PostgreSQL and the server.
- `src/server` runs inside the server's own process. `desktop-gate.ts` turns
  away every request that does not come from this computer, is not addressed
  to `127.0.0.1` on the app's port, or does not carry the token the app made
  when it started, before Next.js sees it.
- `src/core` holds the parts with no Electron in them, which the unit tests
  try directly.
- `src/shared` describes what the windows and the app say to each other.
  `my-app/lib/desktop-bridge.ts` is an exact copy of `bridge.ts`, which is how
  the web app talks to the desktop app, and a test fails if the two differ.
- `src/preload`, `src/renderer` and `renderer` are the splash and Settings
  windows.
- `scripts` holds the build steps above.

The installed app is locked down as well: the server listens on `127.0.0.1`
only, and the app cannot be made to run code other than its own (as a plain
Node.js, through `NODE_OPTIONS`, with a debugger attached from the command
line, or from anything but its own `app.asar`).
