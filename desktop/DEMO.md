# Showing Schema Studio for Ubuntu

A walkthrough for showing the desktop app to someone, in about 15 minutes.
Each step says what to do and what to point out. `README.md` has the details
behind each step, and `SECURITY.md` the reasons behind the security points.

## Before the demo

- An Ubuntu computer, 20.04 or newer, amd64 or arm64.
- The app's `.deb` for that computer: from a release once one is published,
  or from the Artifacts of a passing run of the desktop workflow on GitHub.
  Only a release's `.deb` brings the apt source that updates come through
  (the last step).
- Microsoft sign-in set up in that build (`README.md`, Setting up Microsoft
  sign-in). Without it the sign-in page says that single sign-on is not set
  up, and the demo cannot go past it.
- A PostgreSQL database on the same computer, for the app to find, compare
  and watch: one listening on a port from 5432 to 5439, or one in Docker.
  For example, with Docker:

  ```bash
  docker run -d --name demo-db -e POSTGRES_PASSWORD='<a password you choose>' -p 5432:5432 postgres:17
  ```

  Give it a few seconds to start, then give it two schemas that differ a
  little:

  ```bash
  docker exec -i demo-db psql -U postgres <<'SQL'
  CREATE SCHEMA shop;
  CREATE TABLE shop.customers (id serial PRIMARY KEY, name text NOT NULL);
  CREATE SCHEMA shop_dev;
  CREATE TABLE shop_dev.customers (id serial PRIMARY KEY, name text NOT NULL, email text);
  SQL
  ```

- For the phone part, the deployed relay's https:// address
  (`relay/README.md` says how to deploy it), and a phone with a screen lock
  set: an iPhone with iOS 17 or later, or an Android phone with Chrome 133
  or later. On an iPhone, open the relay's address in Safari, add it to the
  Home Screen (Share, then Add to Home Screen) and open it from there before
  the demo, because Safari and the Home Screen app keep separate storage.
- For the approval part, a deploy request on a connection chosen for
  phones, asked for by someone other than the person signed in on the
  computer, since nobody may decide their own request.

## Install it

In the folder the `.deb` is in (on an arm64 computer, the `_arm64.deb`):

```bash
sudo apt install ./schema-studio_2.0.0_amd64.deb
```

Schema Studio then shows up in the app grid.

Point out that nothing else needs setting up. The app brings its own
PostgreSQL and its own server, and the package holds no secrets: each copy
makes its own keys when it first starts.

For a technical audience, the app can also check itself:

```bash
schema-studio --self-test
```

It goes through a whole start in folders of its own, which it removes
afterwards, and prints a report. Among other things, the report shows that
the app's server turns away requests that do not come from the app.

## First start

Open Schema Studio from the app grid. The splash says what it is doing while
its database and server start, then the sign-in page opens. Continue with
Microsoft opens Microsoft's sign-in in the system browser, and the app
carries on by itself once it is done.

Point out that the first person to sign in becomes the admin, and that the
sign-in happens in the real browser, not inside the app.

For a technical audience, this shows that the server listens on `127.0.0.1`
only and that PostgreSQL has no port at all:

```bash
ss -ltn
```

## Find and compare schemas

1. Connections, then Add connection, then Find databases. The app lists the
   PostgreSQL servers it finds on this computer. Pick the demo database:
   everything is filled in except the password, which you type. Then Save
   connection.

   Point out that finding a database never fills in its password, not even
   for one in Docker: the person always types it.

2. Compare & Author: pick `shop_dev` as the source (the schema you want) and
   `shop` as the target (the schema that gets updated), then press Compare.
   The diff shows the missing `email` column, with an editable SQL migration
   that adds it to `shop`.

## Drift alerts

1. Dashboard, then Track a schema: pick the connection and `shop`, then
   Track schema. Its first snapshot becomes the baseline.
2. On the Drift page, set How often for `shop` to Every 5 minutes. In File,
   then Settings, then Notifications, check that Tell me when a tracked
   schema drifts is on.
3. Change the schema behind the app's back:

   ```bash
   docker exec -i demo-db psql -U postgres -c 'ALTER TABLE shop.customers ADD COLUMN phone text'
   ```

4. Within 5 minutes, a notification names the schema and its connection.
   Clicking it opens that schema on the Drift page.

Point out that only scheduled checks send notifications, and that a
notification never shows a host or an error message.

## Keep it running

File, then Settings, then Background: turn on Keep running when the window
is closed, then close the window. Schema Studio's icon stays in the top bar,
with Open Schema Studio and Quit Schema Studio in its menu, and drift alerts
still arrive. Start when you sign in to Ubuntu starts it each time you sign
in.

## The phone link

File, then Settings, then Phone:

- Turn on Let paired phones connect, type the relay's address under Relay,
  and Save.
- Show a code shows a QR code for a phone's camera. It works once, within 5
  minutes, and Make a new code gives another.
- Connections phones may see chooses which saved connections phones can
  look at.
- Paired phones lists each paired phone, with Allow approvals (so that
  deploy and rollback requests can be approved or rejected from it with a
  passkey), Turn off approvals, and Remove.

Then, with the phone:

1. Show a code, and scan it with Scan the code in the phone app. The phone
   lists the connections chosen for phones.
2. Open the connection, then `shop`, to browse its tables. With a second
   connection chosen for phones, Compare this schema compares `shop` with
   the same schema there.
3. On the computer, choose Allow approvals for the phone. On the phone, open
   Requests, choose Set up approvals, and confirm with Face ID, a
   fingerprint or the screen lock.
4. Open the waiting request under Requests, read its SQL, and choose
   Approve or Reject. The Deploy screen in Schema Studio shows the
   decision.
5. In the phone app's Settings, choose Turn on drift alerts, then make the
   schema change from Drift alerts above. The phone shows the alert too,
   even with the app closed.

Point out that the relay passes on messages it cannot read, that the
pairing code never reaches the relay, and that a phone can do only what the
person signed in on the computer may do.

## Backups

1. File, then Settings, then Backup. Under Save a backup, type a passphrase
   of at least 12 characters twice, then Save and choose where. The file is
   encrypted with the passphrase.
2. Under Restore a backup, Choose the file, type its passphrase, then
   Restore, and confirm with Restore and restart. The splash says Restoring
   the backup, and the app starts again with the backup's data. Everyone
   signs in again, and phones see no connections until they are chosen
   again.

Restoring replaces everything in that copy of the app, so in a demo,
restore onto a second computer, or onto a copy you do not mind losing.

## Help and appearance

- Help, then About Schema Studio shows the version.
- Help, then Copy Diagnostics copies a report to attach to a bug report,
  with secrets removed.
- View, then Appearance: Match Ubuntu, Light or Dark.

## Updates

A copy installed from a release's `.deb` gets new versions through Software
Updater, like any other app. This shows where they come from:

```bash
apt-cache policy schema-studio
```

Publishing a new version (`README.md`, Publishing a new version) is not part
of the demo.
