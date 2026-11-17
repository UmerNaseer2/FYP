-- Schema Studio: the database and the login the app uses.
--
-- Run once, as the postgres superuser, on PostgreSQL 16 (15 or newer works).
-- The password comes from the SS_DB_PASSWORD environment variable, so it is
-- never written into this file or into your shell history:
--
--   export SS_DB_PASSWORD="$(openssl rand -hex 24)"
--   sudo --preserve-env=SS_DB_PASSWORD -u postgres \
--     psql -v ON_ERROR_STOP=1 -f - < sql/01-database-and-login.sql
--
-- (The file is fed in on standard input because the postgres user cannot
-- read files inside a folder only you can open.)
--
-- What it makes:
--   * a login role, schema_studio, that is not a superuser and cannot create
--     databases, other roles or replication connections;
--   * a database, schema_studio, owned by that login, that no other ordinary
--     login can connect to;
--   * the database's public schema, owned by that login, so the app can create
--     and later change its own tables there and nobody else can.
--
-- The app needs nothing more. It uses no extensions, makes no other roles
-- and never touches another database through this login.

\set ON_ERROR_STOP on

\getenv app_password SS_DB_PASSWORD
\if :{?app_password}
\else
  \echo 'SS_DB_PASSWORD is not set. Run: export SS_DB_PASSWORD="$(openssl rand -hex 24)"'
  DO $$ BEGIN RAISE EXCEPTION 'SS_DB_PASSWORD is not set'; END $$;
\endif

SELECT length(:'app_password') >= 16 AS password_long_enough \gset
\if :password_long_enough
\else
  \echo 'SS_DB_PASSWORD is shorter than 16 characters. Use: openssl rand -hex 24'
  DO $$ BEGIN RAISE EXCEPTION 'SS_DB_PASSWORD is too short'; END $$;
\endif

-- 1. The login. PostgreSQL 16 stores the password as a SCRAM-SHA-256 hash.
CREATE ROLE schema_studio
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  PASSWORD :'app_password';

-- 2. The database, owned by the login.
CREATE DATABASE schema_studio
  OWNER schema_studio
  ENCODING 'UTF8'
  TEMPLATE template0;

-- 3. Only the owner (and superusers) may connect. By default every login may.
REVOKE ALL ON DATABASE schema_studio FROM PUBLIC;

-- 4. Inside the new database: the public schema belongs to the login and no
--    one else may create objects in it or look into it.
\connect schema_studio
ALTER SCHEMA public OWNER TO schema_studio;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

\echo 'Done: login schema_studio and database schema_studio are ready.'
