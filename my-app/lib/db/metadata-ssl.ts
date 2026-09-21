import { parse as parseConnectionString } from "pg-connection-string";

/**
 * Should the app talk to its OWN metadata database (DATABASE_URL_A) over SSL?
 *
 * Kept in its own file, away from lib/db/sequelize.ts, so it can be tested
 * without opening a database pool.
 *
 * Three answers, checked in this order:
 *
 *   1. The URL says `sslmode=disable`: no SSL. docker-compose.yml relies on
 *      this. Inside the compose network the database is called `db`, not
 *      localhost, and the postgres image serves no SSL at all, so without it
 *      the app container could never reach its own store ("The server does
 *      not support SSL connections").
 *   2. The host is this machine (localhost, 127.0.0.1, ::1, or missing): no
 *      SSL. That is `npm run dev` against the compose `db` on port 5433.
 *   3. Anything else is hosted Postgres (Supabase, Neon, RDS...): SSL on.
 *
 * The parser almost never throws, even on nonsense. If it ever does, the answer
 * is "no SSL" and the connection then fails with the driver's own error about
 * the URL, which is the useful message.
 */
export function metadataWantsSsl(url: string): boolean {
  let parsed: ReturnType<typeof parseConnectionString>;
  try {
    parsed = parseConnectionString(url);
  } catch {
    return false;
  }

  // pg-connection-string turns `sslmode=disable` into `ssl: false`.
  if (parsed.ssl === false) return false;

  const host = parsed.host ?? "";
  const onThisMachine =
    host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1";
  return !onThisMachine;
}
