// Nothing the app runs may depend on keeping one server connection.
//
// A transaction pooler (Supabase's port 6543 is one) takes the server connection
// back the moment no transaction is open, so the next statement can land on any
// other. A session advisory lock left behind that way is never released: the
// committed bootstrap hung for ever behind a stand-in for one, on the second cold
// start. A named prepared statement fails with "does not exist" on the next one.
//
// None of this shows up on a plain Postgres, which is what every other test uses,
// so nothing else would catch it coming back. This is a scan of the source, and
// tests/bootstrap-lock-db.test.ts checks the behavior.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

// Refuses these functions in SQL people type, so it has to name them.
const ALLOWED = new Set(["lib/query-analysis.ts"]);

const FILES = [...sourceFiles("lib"), ...sourceFiles("app"), "instrumentation.ts", "proxy.ts"]
  .filter((file) => !ALLOWED.has(file));

function hits(pattern: RegExp): string[] {
  return FILES.filter((file) => pattern.test(readFileSync(path.join(ROOT, file), "utf8")));
}

describe("code that would not survive a transaction pooler", () => {
  it("looks at the code it means to", () => {
    expect(FILES).toContain("lib/db/bootstrap.ts");
    expect(FILES).toContain("lib/drift-scheduler.ts");
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("takes no session advisory lock", () => {
    // pg_advisory_xact_lock is fine: it ends with its transaction, which keeps
    // the server connection for as long as it lasts.
    expect(hits(/pg_(try_)?advisory_lock(_shared)?\s*\(/)).toEqual([]);
    expect(hits(/pg_advisory_unlock(_shared|_all)?\s*\(/)).toEqual([]);
  });

  it("names no prepared statement", () => {
    // pg's `query({ name, text })` is the one way to name one. Plain parameters
    // use the unnamed statement, which poolers handle.
    expect(hits(/\.query\(\s*\{/)).toEqual([]);
  });

  it("leaves nothing else behind on the session", () => {
    expect(hits(/\b(LISTEN|UNLISTEN)\s+\w/)).toEqual([]);
    expect(hits(/CREATE\s+TEMP(ORARY)?\s+TABLE/i)).toEqual([]);
  });
});
