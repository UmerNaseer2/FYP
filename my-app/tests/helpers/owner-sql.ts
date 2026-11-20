// A generated owner change sits inside a DO block that skips it, with a
// warning, when the login running the script may not give the object away (see
// ownerStatement in lib/sql/generate/privileges.ts). Tests that look for one
// exact ALTER ... OWNER TO line read it out of that block with plainSql.
//
// This file is not a test itself: Jest only runs tests/**/*.test.ts.
import type { SqlStatement } from "@/lib/sql/generate";

/** The statement's SQL, with an owner change read out of its DO block. */
export function plainSql(statement: Pick<SqlStatement, "kind" | "sql">): string {
  if (statement.kind !== "ALTER_OWNER") return statement.sql;
  return /^\s*(ALTER .+ OWNER TO .+;)$/m.exec(statement.sql)?.[1] ?? statement.sql;
}
