// org-scoped-sql: every statement the app sends to its own database about a
// tenant table names org_id.
//
// Each row in these tables belongs to one organization, and the rule that keeps
// one organization's data away from another's is that every statement filters
// (or writes) each tenant table's own org_id. A statement that forgets it does
// not fail: it quietly reads, changes or deletes another organization's rows.
// The type checker cannot see SQL, and a mocked route test only catches the
// statements somebody thought to test, so this reads the source instead.
//
// It parses every file under app/, lib/ and scripts/ with the TypeScript
// compiler and looks at each string the code builds: a quoted string, a
// template, or several of them joined with +. A string that reads from, joins,
// writes or deletes a tenant table must mention org_id at least once for each
// tenant table it names. That is a floor, not a proof: it cannot tell a filter
// from a column list. What it does catch is the mistake that matters, a
// statement written or edited without the organization in it at all.
//
// A statement that really does cover every organization (a background job
// that prunes old rows everywhere, say) says so in the SQL itself, with a
// comment that starts "-- every organization:" and gives the reason. The
// reason is then right there for the next person who reads the statement.
import fs from "fs";
import path from "path";
import ts from "typescript";

const ROOT = path.join(__dirname, "..");
const DIRS = ["app", "lib", "scripts"];
const EXTENSIONS = /\.(ts|tsx|js|cjs|mjs)$/;

/** Every table with an org_id column, memberships included. */
const TENANT_TABLES = [
  "memberships",
  "connections",
  "roles",
  "role_permissions",
  "role_changes",
  "tracked_schemas",
  "snapshots",
  "lineage_migrations",
  "drift_events",
  "schema_metrics",
  "query_history",
  "perf_thresholds",
  "comparison_sets",
  "comparison_set_targets",
  "comparison_runs",
  "deploy_approvals",
  "deploy_attempts",
  "invites",
];

/**
 * A tenant table after the keyword that reads, joins, writes or deletes it.
 * Upper-case keywords only: the app writes its SQL that way, and a sentence
 * such as "could not read from connections" in an error message is not SQL.
 */
const TOUCHES = new RegExp(
  `\\b(?:FROM|JOIN|INTO|UPDATE)\\s+(?:ONLY\\s+)?(?:public\\.)?(?:${TENANT_TABLES.join("|")})\\b`,
  "g"
);
const ORG = /\borg_id\b/g;
const MARKER = "-- every organization:";

type Statement = { file: string; line: number; text: string };

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (EXTENSIONS.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function isPlus(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/**
 * The text of every string literal inside a node, in order.
 *
 * Used for the whole of a template or a + chain, interpolations included, so a
 * clause added by a condition inside the template (`${scoped ? "AND org_id =
 * $2" : ""}`) counts as part of the statement it is added to.
 */
function literalText(node: ts.Node): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans.map((span) => literalText(span.expression) + span.literal.text).join("")
    );
  }
  const parts: string[] = [];
  ts.forEachChild(node, (child) => {
    parts.push(literalText(child));
  });
  return parts.join(" ");
}

function isStringish(node: ts.Node): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node)
  );
}

/** Every string the file builds, one entry per quoted string, template or + chain. */
function statementsIn(file: string): Statement[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const found: Statement[] = [];
  const visit = (node: ts.Node) => {
    // The outermost + chain is one string: SQL split over several quoted
    // pieces is a single statement, and its org_id may be in a later piece.
    if (isStringish(node) || (isPlus(node) && hasStringLeaf(node))) {
      found.push({
        file: path.relative(ROOT, file),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        text: literalText(node),
      });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function hasStringLeaf(node: ts.Node): boolean {
  if (isStringish(node)) return true;
  if (isPlus(node)) return hasStringLeaf(node.left) || hasStringLeaf(node.right);
  if (ts.isParenthesizedExpression(node)) return hasStringLeaf(node.expression);
  return false;
}

/** True when the text touches more tenant tables than it names org_id, and is not marked. */
function isUnscoped(text: string): boolean {
  if (text.includes(MARKER)) return false;
  return (text.match(ORG) ?? []).length < (text.match(TOUCHES) ?? []).length;
}

const tenantStatements = DIRS.flatMap((dir) => sourceFiles(path.join(ROOT, dir)))
  .flatMap(statementsIn)
  .filter((statement) => (statement.text.match(TOUCHES) ?? []).length > 0);

test("the scan finds the app's tenant statements", () => {
  // A guard on the guard: if the file walk or the parsing ever broke, the test
  // below would pass over nothing. The app has well over a hundred of these.
  expect(tenantStatements.length).toBeGreaterThan(100);
  const files = new Set(tenantStatements.map((statement) => statement.file));
  expect(files).toContain(path.join("lib", "approvals-db.ts"));
  expect(files).toContain(path.join("app", "api", "scripts", "apply", "route.ts"));
});

test("the rule flags a statement that leaves the organization out", () => {
  // Checked on samples, so a regex that stopped matching cannot pass the real
  // statements by flagging nothing.
  expect(isUnscoped("SELECT name FROM connections WHERE id = $1")).toBe(true);
  expect(isUnscoped("SELECT name FROM connections WHERE id = $1 AND org_id = $2")).toBe(false);
  expect(
    isUnscoped(
      "SELECT s.id FROM snapshots s JOIN tracked_schemas t ON t.id = s.tracked_schema_id " +
        "WHERE s.org_id = $1"
    )
  ).toBe(true);
  expect(isUnscoped("DELETE FROM query_history WHERE captured_at < now()")).toBe(true);
  expect(isUnscoped("UPDATE deploy_approvals SET status = 'used' WHERE id = $1")).toBe(true);
  expect(isUnscoped("INSERT INTO deploy_attempts (outcome) VALUES ($1)")).toBe(true);
  expect(
    isUnscoped("-- every organization: a nightly prune\nDELETE FROM schema_metrics")
  ).toBe(false);
  expect(isUnscoped("Could not read from connections or roles.")).toBe(false);
});

test("every statement about a tenant table names org_id, or says why it covers every organization", () => {
  const unscoped = tenantStatements
    .filter((statement) => isUnscoped(statement.text))
    .map(
      (statement) =>
        `${statement.file}:${statement.line}  ${statement.text.replace(/\s+/g, " ").trim().slice(0, 110)}`
    );
  expect(unscoped).toEqual([]);
});

test("a statement marked as covering every organization gives its reason", () => {
  // A reason of a few words at least, on the marker's own line: a bare marker
  // would exempt the statement while telling the next reader nothing.
  const reason = new RegExp(`${MARKER}[ \\t]*\\S[^\\n]{9,}`);
  const bare = tenantStatements
    .filter((statement) => statement.text.includes(MARKER))
    .filter((statement) => !reason.test(statement.text))
    .map((statement) => `${statement.file}:${statement.line}`);
  expect(bare).toEqual([]);
});
