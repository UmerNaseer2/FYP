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
  keys are kept the same way as the others. The phones open the phone app,
  which the relay serves too, and can add it to their Home Screen.
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
- Sends the same drift alerts to each paired phone that turned them on,
  while Schema Studio is running here. They go from this computer straight
  to the push service of the phone's browser (Google's, Apple's, Mozilla's
  or Microsoft's), locked so that only that phone can read them, and the
  phone shows them even when it does not have Schema Studio open. A phone
  only hears about the connections chosen for phones, and only while the
  person signed in here may see drift. Each phone turns its own alerts on
  and off in the phone app's Settings, so the Notifications setting is for
  this computer alone.
- Lets a paired phone approve or reject the deploy and rollback requests
  waiting on the connections chosen for phones, after reading their exact
  SQL on the phone. Each decision is signed by a passkey on the phone (Face
  ID, a fingerprint or the phone's code), and this computer checks the
  signature and the SQL before passing the decision on. A phone may set up
  its passkey only in the 5 minutes after Allow approvals is pressed for it
  (File, then Settings, then Phone), and it then decides as the person
  signed in here at that time, and as nobody else. Turn off approvals stops
  it, and so does moving the phone link to another relay, since a passkey
  only signs for the relay it was made at.
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
`.deb`. The desktop workflow installs each one on every one of these versions,
runs its self-test there and updates it through a signed apt source, the way
a published version arrives.

## Installing and removing

Each published version is a GitHub release, under Releases on the
repository's page, with two `.deb` files: one for amd64 and one for arm64.
Publishing a new version below says how one is made. Download the one for
the computer's processor, then install it from the folder it went to:

```bash
sudo apt install ./schema-studio_2.0.0_amd64.deb
```

On an arm64 computer the file is `schema-studio_2.0.0_arm64.deb`. The `./`
matters: it tells apt to install that file rather than look for a package
online. Schema Studio is then in the app grid, and `schema-studio` starts it
from a terminal. From then on it gets each new version with the rest of the
computer's updates (see Updates through apt below).

Each run of the desktop workflow on GitHub also keeps the two `.deb` files
it built, under Artifacts on the run's page. Each one downloads as a zip
file with the `.deb` inside. They install the same way but carry no update
source, so a copy installed from one never updates itself. To make one by
hand, see Building the .deb below.

To remove it:

```bash
sudo apt remove schema-studio
```

Removing it leaves the data where it is (see below), so installing it again
carries on where it left off.

## Updates through apt

Each published `.deb` brings two files along with the app:

- `/etc/apt/sources.list.d/schema-studio.sources` tells apt to look for new
  versions in this project's latest GitHub release.
- `/usr/share/keyrings/schema-studio-archive-keyring.gpg` is the public half
  of the key that signs those releases. apt uses it for this source alone,
  never for Ubuntu's own packages.

So a new version shows up in Software Updater, or with

```bash
sudo apt update && sudo apt upgrade
```

apt checks the signature and the hash of every file, and stops if anything
changed on the way. Automatic security updates (unattended-upgrades) leave
Schema Studio alone, so a new version waits until someone accepts it. To
stay on the installed version, hold it:

```bash
sudo apt-mark hold schema-studio
```

and `sudo apt-mark unhold schema-studio` lets it update again. Removing
Schema Studio removes both files, and each new version replaces them, so
changes made to them do not last.

If `apt update` or `apt upgrade` reports an error for the Schema Studio
source, such as a 404 or a hash mismatch, a new version was most likely
being published at that moment. Run both commands again a minute later.

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

## Publishing a new version

`.github/workflows/desktop-release.yml` adds the apt source to both `.deb`
files, signs the apt index files and puts them all in a new GitHub release,
which every installed copy then updates from. Pushing a tag starts it.

### Making the signing key (once)

apt only installs what a key it trusts has signed, so publishing needs a
signing key. Make one on any computer with gpg, in a folder of its own:

```bash
export GNUPGHOME="$(mktemp -d)"
gpg --batch --pinentry-mode loopback --passphrase '' --quick-generate-key "Schema Studio releases" ed25519 sign never
gpg --armor --export-secret-keys > apt-signing-key.asc
```

In GitHub, open the repository's Settings, then Environments, and add an
environment named `desktop-release`. Give it a secret named
`APT_SIGNING_KEY` that holds the whole of `apt-signing-key.asc`. Keep a copy
of that file, and of the `openpgp-revocs.d` folder in `$GNUPGHOME`, offline,
for example on a USB stick. Then remove them from the computer:

```bash
gpgconf --kill all
rm -rf "$GNUPGHOME" apt-signing-key.asc
```

The key has no passphrase, since nobody is there to type one when the
workflow signs, and it never expires, since every installed copy carries it
and an expired key would stop them all updating. The environment's Required
reviewers and Deployment branches and tags settings can also limit who
publishes, and from which tags.

### Publishing

1. Raise `version` in `desktop/package.json` (the first release can keep
   2.0.0). It must be three plain numbers like 2.1.0, and newer than the
   latest release.
2. Commit and push it, and wait for the desktop workflow to pass.
3. Tag that commit with `desktop-v` and the version, and push the tag:

   ```bash
   git tag desktop-v2.1.0
   git push origin desktop-v2.1.0
   ```

The tag starts Publish the desktop app, under Actions. It runs every check
of the desktop workflow again, then makes the tag's release as a draft, adds
all its files, and only then makes it the latest release, so an installed
copy never sees half a release. Last, it checks that apt finds the new
version there and fetches the very file it published. Installed copies
always look in the latest release, so only desktop releases may be marked as
latest on the Releases page.

### If something goes wrong

If the workflow stops before it makes the release, for example because
`APT_SIGNING_KEY` is missing, fix that and choose Re-run all jobs on the
run's page. If the code or the version has to change instead, delete the
tag and start again from step 1:

```bash
git push --delete origin desktop-v2.1.0
git tag -d desktop-v2.1.0
```

If it stops after it made the release, delete that release on the Releases
page, check that the previous desktop release shows as the latest again,
then read the run's log before trying again.

If the signing key is lost or leaks, make a new one as above, replace
`APT_SIGNING_KEY` with it and publish a new version. Copies installed
before still trust only the old key, so install the new `.deb` by hand once
on each computer (Installing and removing above). Someone with the old key
would also need write access to this repository's releases to publish
anything.

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

The desktop workflow also checks the shell scripts in `scripts` with
shellcheck, and fails on any finding.

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
- `scripts` holds the build steps above, and `add-apt-source.sh` and
  `make-apt-repo.sh`, which publishing uses (Publishing a new version).

The installed app is locked down as well: the server listens on `127.0.0.1`
only, and the app cannot be made to run code other than its own (as a plain
Node.js, through `NODE_OPTIONS`, with a debugger attached from the command
line, or from anything but its own `app.asar`).

`SECURITY.md` says what the app protects, from whom and how, and what it
does not protect against. `DEMO.md` is a walkthrough for showing the app to
someone.
