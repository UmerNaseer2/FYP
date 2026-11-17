// The public face of the migration SQL generator. Everything the rest of the
// app imports from "@/lib/sql/generate" is re-exported here, and nothing else.
// Files inside this folder import each other directly, never through this one.
// README.md in this folder lists the parts and the order the generator works in.

export type { SqlStatementKind, SqlStatement, MigrationOptions, MigrationScript } from "./types";
export { generateMigration } from "./migration";
export { manualNoteCount, migrationChangeLevel, statementsThatRun, renderMigrationScript } from "./render";
export type { RollbackScript } from "./rollback";
export { generateRollback, renderRollbackScript } from "./rollback";
