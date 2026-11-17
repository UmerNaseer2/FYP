# Why most of the SQL is written by hand

A code review asked why the app writes so much SQL itself, why Sequelize is
there but hardly used as an ORM, and whether the queries still work on older
PostgreSQL servers. This is the answer, and the rules that keep the
hand-written SQL safe.

## Two kinds of database work

The app talks to two kinds of database, and they are very different.

| | The app's own database | The databases people compare and deploy to |
|---|---|---|
| Set by | `DATABASE_URL_A` | The Connections page |
| Its tables | Fixed. The app made them and knows them. | Anything. The app has never seen them before. |
| What the app does there | Saves organizations, people, roles, connections, snapshots, versions, drift history, approvals | Reads the structure out of PostgreSQL's catalog, writes SQL that changes it, runs scripts |
| Code | `lib/db/`, and every `*-db.ts` file in `lib/` | `lib/postgres/`, `lib/sql/generate/`, `lib/deploy/` |

An ORM is built for the first kind: a set of tables you know in advance, each
described once as a model. It has nothing to offer the second kind.

## The databases people compare: why raw SQL

**Reading a schema.** There is no table of "the user's tables" to model. What
there is, is PostgreSQL's catalog: `pg_class`, `pg_attribute`,
`pg_constraint`, `pg_index`, `pg_policy`, `pg_type` and the rest. Reading it
means writing queries against it. Sequelize can describe the columns of a
table, but it knows nothing of exclude constraints, row-level security
policies, partitions, domains, ranges, collations, routines or grants, all of
which the snapshot needs.

The options that were weighed:

| Option | Why not |
|---|---|
| `information_schema` (the SQL standard views) | It only shows a table or column the login has some privilege on. A saved login without rights on a table saw it vanish, so drift reported a removed table that was still there. It also has nothing for most PostgreSQL-only objects. The reader moved off it for that reason (see the top of `tests/snapshot-catalog.test.ts`). |
| Run `pg_dump --schema-only` and parse its text | It needs a `pg_dump` binary in the container at least as new as every server it reads, and turns a structured question into text parsing. |
| A schema comparison library | The well known ones are in other languages, so the container would carry a second runtime, and none covered every object kind the client's schemas use. |
| Hand-written catalog queries | Chosen. One query per area, each returning plain rows, in `lib/postgres/catalog/`. |

**Writing changes.** What Compare produces is a SQL script, because that is
what a person reviews, saves to GitHub and runs. `lib/sql/generate/` writes
that text directly. An ORM's migration tool writes SQL from model changes, not
from two live schemas, so it cannot do this job.

**Running scripts.** Deploy runs the user's own script as it is. That is SQL
by definition.

## The app's own database: Sequelize for the tables, SQL for the queries

Here Sequelize does do one job, the one it is good at: `lib/db/models.ts`
describes every table once, and `sequelize.sync()` in `lib/db/bootstrap.ts`
creates them in the right order on first use. `bootstrap.ts` then adds what a
model cannot say (CHECK constraints, unique indexes on expressions such as
`lower(email)`, the seed rows).
Sequelize also owns the one connection pool.

The reads and writes themselves are plain parameterised SQL, run through
`metadataPool` in `lib/db/sequelize.ts`. There are about 220 of these queries
and only a handful of model calls. The reasons:

- **Readability.** This was the first reason, decided in the first semester.
  The queries use joins across three or four tables, `ON CONFLICT` upserts,
  `FOR UPDATE` row locks, `RETURNING` and common table expressions. Written as
  SQL, a reader sees exactly what runs. Written as model calls, the same thing
  is longer and the SQL is hidden.
- **One way of talking to PostgreSQL.** The reader, the generator and Deploy
  are SQL anyway. Using the same style for the app's own tables means one
  skill covers the whole codebase.
- **Transactions that span the app's tables.** Approvals, role changes and
  deploy records each take a row lock and change several tables in one
  transaction. That reads plainly as `BEGIN ... FOR UPDATE ... COMMIT` on one
  client.

The honest cost: a column rename in `models.ts` is not checked against the
queries by the compiler. The database tests (the `*-db.test.ts` files, which
CI runs against a real PostgreSQL 16) are what catch that.

## Rules that keep hand-written SQL safe

1. **No value is ever pasted into SQL text.** Every value is a `$1`
   placeholder, passed to the driver separately. This holds for every query
   on the app's own tables and every catalog read.
2. **Names go through one quoting helper.** Where a name must be part of the
   text (a table name in generated DDL), it goes through `q()` in
   `lib/sql/generate/basics.ts`, which double-quotes it and doubles any quote
   inside. `quoteLiteral` and `quoteRole` in `lib/postgres/helpers.ts` do the
   same for literals and role names.
3. **Reading never writes.** `fetchSchemaSnapshot` runs every catalog query in
   one `REPEATABLE READ READ ONLY` transaction, with a statement timeout. The
   server itself refuses a write, and every query sees the same moment.
4. **User scripts run under limits.** Deploy sets a lock wait cap and a time
   cap, puts the target schema first on the search path (followed only by
   schemas that hold nothing but extensions), and runs the script in a
   transaction (`lib/deploy/run-settings.ts`, `lib/deploy/run-limits.ts`).

## Older PostgreSQL servers

The catalog changes a little between major versions: a new column here, a new
letter in a code column there. The reader handles that in two ways.

- **A column only newer servers have is read out of the row as JSON.** For
  example, `rngmultitypid` arrived in PostgreSQL 14, so
  `lib/postgres/catalog/user-types.ts` reads it as
  `to_jsonb(rng) ->> 'rngmultitypid'`. On PostgreSQL 13 the key is simply
  absent and the value is null, where naming the column would fail the query.
- **A code only newer servers use reads as "none" on older ones.** For
  example, a virtual generated column (`'v'`) exists only from PostgreSQL 18.
  Older servers never return it, so the column reads as stored or not
  generated, which is correct there.

The comments that mention PostgreSQL 17 or 18 record where a behaviour was
checked, or a case only a newer server can produce. None of them means the
code needs that version.

**How it is tested.** `tests/schema-reading-db.test.ts` builds one of every
kind of object the reader handles (enums, domains, composites, ranges,
collations, sequences, identity and generated columns, every constraint kind,
partial and expression indexes, partitions, views, materialized views,
functions, procedures, triggers, row-level security, grants), reads the schema
and checks each one. CI's `schema-reading` job runs it, with the SQL
generator's database test, on **every PostgreSQL from 13 to 18**. The client
runs 16. A new major version is one more line in that job's list in
`.github/workflows/ci.yml`.

## When to reconsider

- If the app's own tables start changing often, a migration tool (Sequelize's
  own migrations, or another) would be worth adding, so that each change is a
  numbered, reviewed file. Today the tables are created by `sync()` plus
  `bootstrap.ts`, and `deploy/handover/sql/` holds the same thing as plain SQL
  for a database administrator.
- If another database engine is ever supported, the reader would need a
  second set of catalog queries anyway. An ORM would not remove that work.

## Where to look

| To understand | Read |
|---|---|
| How a schema is read, step by step | `my-app/lib/postgres/README.md` |
| One area of the catalog | `my-app/lib/postgres/catalog/<area>.ts` (row type, then the query, then the build step) |
| How a script is written | `my-app/lib/sql/generate/README.md` |
| The app's own tables | `my-app/lib/db/models.ts`, then `my-app/lib/db/bootstrap.ts` |
| Why Sequelize is used the way it is | The comment at the top of `my-app/lib/db/sequelize.ts` |
