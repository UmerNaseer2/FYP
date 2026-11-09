# One database for orgs and cloud connections

The user's idea, 2026-11-09. Approved and built on branch `shared-db` (not on main yet).

## The idea

- **One shared database.** Orgs, people, roles and cloud connections all live in Supabase. Vercel and the Swinburne server's copy both use Supabase directly.
- **Local connections stay on their machine.** That means `localhost`, the server's own databases and a laptop's databases. Their password stays on that machine, and they only run from there.
- **Everyone still sees them.** Supabase lists every local connection by its name and the machine it lives on, under the org's databases.

## What you will see

| Connection | Password kept in | Works from | Shows up |
| --- | --- | --- | --- |
| Cloud (Neon, Supabase, AWS) | Supabase | Vercel, the server copy, the desktop app | everywhere |
| Local on the server | the server's own database | the server copy only | everywhere, as "on Swinburne server" |
| Local on a laptop | that laptop's desktop app | that desktop app only | everywhere, as "on <laptop name>" |

If you click a local connection somewhere else, it says: "This database lives on Swinburne server. Open Schema Studio there to use it."

## How each copy is set up

- **Vercel:** no change. It already runs on Supabase.
- **Server copy:** it needs three settings in its `.env`:
  - its main database pointed at Supabase, with the same `APP_ENCRYPTION_KEY` as Vercel so it can read the cloud passwords;
  - a new `LOCAL_DATABASE_URL` pointing at its own PostgreSQL, for local passwords;
  - a name for the machine, such as "Swinburne server".
- **Desktop app:** no change. Since 955162d it already gets cloud connections from the website and keeps its local ones at home. You link it to Vercel. It never gets the Supabase address itself: anyone who installed the app could then read every org.
- **The client's container image:** with no `LOCAL_DATABASE_URL` set, everything stays in its own database like today, so the image is still self-contained.

## What gets built

1. **"Lives on" for each connection.** It is empty for a cloud connection, or holds the machine's name for a local one.
2. **Saving.**
   - A `localhost` or private address is local: its name and details go to Supabase, and its password goes to this machine's local database.
   - A public address is cloud, saved as today.
   - A switch on the form overrides the guess: "Only this machine can reach it".
3. **Using.** Compare, test and drift run only where the password is. Anywhere else, the buttons say where the connection lives.
4. **Drift checks.**
   - A cloud connection is checked once, by whichever copy gets to it first. The existing lock already stops it being checked twice.
   - A local connection is checked only by its own machine.
5. **Laptop connections for the whole org.** Today only their owner sees them on the website. With this change everyone in the org sees their name and which laptop they are on.
6. **Moving the server copy over, once.**
   - A script copies the server's connections into the same org on Supabase, skipping any already there (same host, port, database and user).
   - Local ones keep their password on the server.
   - The old server database is left as it is, as a backup.
   - People and roles now come from Supabase. Anyone who only exists on the server copy is added to the org on the website once.
   - Old compare history stays in the old database for now.

## Check before building

The Swinburne network has to let the server reach Supabase's database port. That is a one-line check you run on the server. If it is blocked, this plan cannot work there as written.

## Testing

- The usual checks: type checks, the web tests, the desktop tests, and the database tests on a throwaway PostgreSQL.
- A live run with one PostgreSQL standing in for Supabase, a "Vercel" copy, and a "server" copy with its own local database. It checks:
  - a cloud connection added on one copy shows on the other;
  - a local one shows by name on both but only runs on its own machine;
  - its password never reaches the shared database;
  - drift runs once;
  - the move script skips duplicates;
  - a copy with no `LOCAL_DATABASE_URL` works exactly as today.

## Going live

- Nothing is pushed until you say so.
- Once on main, the server picks up the code, but nothing changes there until its `.env` is updated. That is your step on the server, since it needs the real settings, followed by the move script.

## Live run, 2026-11-09

One throwaway PostgreSQL stood in for Supabase, with a "Vercel" copy (no local store) and a "server" copy (its own local database, named "Swinburne server") both pointed at it. Real sign-in cookies, no bypass. 47 checks, all passed:

- A connection added on the Vercel copy shows on the server copy, its password locked as before.
- A `localhost` connection added on the server copy shows on both by name, "on Swinburne server". Its password is only in the server's own database, never in the shared one.
- Compare and test work for it on the server. On Vercel they say "This database lives on Swinburne server". Editing it works only on the server.
- Typing a `local:v1:` value as a password is refused everywhere, so nobody can borrow another connection's password.
- A linked desktop is sent the local connection without its key.
- Drift: a tick on Vercel checks only the cloud schema, a tick on the server checks the local one, and nothing is checked twice.
- A Viewer sees both connections and cannot add one.
- The move script: a trial changes nothing, `--apply` copies one cloud and one local connection and skips the duplicate, a second `--apply` adds nothing. After a restart the server opens the moved local connection with its old password.
- Deleting works from any copy. Deleted on Vercel, the listing goes and the password stays on the server, unused. Deleted on the server, both go.
- A copy with no `LOCAL_DATABASE_URL` saves even a `localhost` connection exactly as today.

Two things worth knowing:

- Both copies ran on one Mac, so the "cloud" connection was really a local database both could reach. That is fine for the test, since only the shared database's rows decide what each copy does.
- The move script also asks the DNS. A name that does not resolve from the server (for example a typo, or a host only another network knows) is moved as local, so its password stays on the server. Re-add it on the website if it is really a cloud database.
