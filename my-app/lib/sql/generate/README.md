# lib/sql/generate

The migration SQL generator. It takes a schema comparison (a `CompareReport`)
and writes the script that makes the target database match the source, plus the
rollback script that undoes it.

Import it as `@/lib/sql/generate`. That resolves to `index.ts`, which re-exports
the public names and nothing else:

- types: `SqlStatementKind`, `SqlStatement`, `MigrationOptions`, `MigrationScript`, `RollbackScript`
- functions: `generateMigration`, `renderMigrationScript`, `generateRollback`,
  `renderRollbackScript`, `manualNoteCount`, `migrationChangeLevel`, `statementsThatRun`

## Rules for this folder

- Files in here import each other directly (`./views`, `./basics`), never through `index.ts`.
- No import cycles. If two files need the same helper, it goes in a file both can
  import (`basics.ts` or `statement-helpers.ts`).
- The order statements are emitted in is the whole point of the generator. Do not
  reorder pushes in `migration.ts`, `object-phases.ts` or `alter-table.ts` without a test.

## The files

Shared foundations (import nothing from the files below them):

| File | What it holds |
| --- | --- |
| `types.ts` | The public types: one statement, the options, the finished script |
| `basics.ts` | `q()` identifier quoting, type name normalising, lookups by name |
| `statement-helpers.ts` | Common statement fields, SQL literals, dollar quoting, the "only if missing" guard, manual notes |

One file per kind of object (each writes the CREATE, DROP and ALTER statements for that kind):

| File | What it holds |
| --- | --- |
| `columns.ts` | Column definitions, serial shorthand, the sequence plan, restoring NOT NULL |
| `column-changes.ts` | Which columns of a matched table are retyped or rebuilt, and what names them |
| `tables.ts` | CREATE TABLE, creation order for new tables, foreign key and constraint definitions |
| `indexes.ts` | CREATE INDEX and DROP INDEX |
| `triggers-policies.ts` | Triggers, row level security, policies |
| `views.ts` | Views, their dependency order, and what a CASCADE drop takes |
| `sequences.ts` | Sequences, identity options, moving a counter past existing rows |
| `extensions.ts` | Extensions and collations |
| `custom-types.ts` | Enum, domain, composite and range types, and their dependency order |
| `privileges.ts` | Ownership and grants |
| `routines.ts` | Functions and procedures, and which tables call them |

Putting it together:

| File | What it holds |
| --- | --- |
| `object-phase-types.ts` | The `ObjectPhases` shape: object statements bucketed by when they must run |
| `object-phases.ts` | `objectPhases()`: fills those buckets from the object differences (one long function) |
| `inbound-keys.ts` | Foreign keys on other tables that block a key change: drop first, restore after |
| `alter-helpers.ts` | Smaller pieces of the per-table ALTER work |
| `alter-table.ts` | `alterStatementsForMatch()`: every ALTER for one matched table (one long function) |
| `safe-mode.ts` | Holds back drops of objects that something kept still uses |
| `migration.ts` | `generateMigration()`: the entry point, lays everything out in order |
| `render.ts` | `renderMigrationScript()` and the small questions asked of a script |
| `rollback.ts` | `generateRollback()` and `renderRollbackScript()` |

`object-phases.ts` and `alter-table.ts` are over 800 lines because each is a single
function whose steps share local state. They were kept whole on purpose.

## The order the generator works in

`generateMigration()` in `migration.ts` runs these steps. The long comment above
that function is the full explanation; this is the short version.

1. `objectPhases()` sorts every non-table difference into phases.
2. Types and standalone sequences are created, because a column may use one.
3. Views that read tables about to change are dropped.
4. Tables in the target are renamed to match the source.
5. Tables only in the source are created (their foreign keys are queued for later).
6. Functions and procedures are created, because a trigger or a CHECK may call one.
7. Matched tables are altered by `alterStatementsForMatch()`: renames, adds,
   type and null changes, constraints, then column drops.
8. Tables only in the target are dropped.
9. Indexes are written, now that every column exists.
10. Foreign keys are added, now that every table and column exists.
11. Triggers and policies are written.
12. Views are created again, once every table they read is final.
13. Routines, types and sequences that nothing uses any more are dropped.
14. Safe mode (`safe-mode.ts`) holds back any drop whose object is still in use.

`renderMigrationScript()` then turns the statements into text. Destructive
statements are commented out unless the caller passed `allowDataLoss: true`.

`generateRollback()` builds the down script by running the comparison backwards
and generating a migration from that, then adds its own warnings.

## Tests

The `tests/generate-sql*.test.ts` suites cover this folder. Run them with
`npx jest tests/generate-sql` after any change here.
