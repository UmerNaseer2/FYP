// route-gates: what every API route checks before it does anything else.
//
// Read from the source rather than by calling the routes. Calling one needs its
// whole world stood in for (the database, GitHub, next-auth), and the question
// asked here is only "what is the first thing this handler waits for, and does
// it act on the answer?". The TypeScript compiler's own parser does the
// reading, so a comment or a string that happens to mention requirePermission
// cannot fool it the way a regular expression could.
//
// Used by tests/permissions-coverage.test.ts (every route is gated, and every
// permission is checked somewhere) and tests/permissions-equivalence.test.ts
// (the permissions a route asks for are the old role check, renamed).
import fs from "fs";
import path from "path";
import ts from "typescript";

export const API_DIR = path.join(__dirname, "..", "..", "app", "api");

// HEAD and OPTIONS too: no route exports them today, and one that did would be
// a way in that nobody had looked at.
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type Method = (typeof METHODS)[number];

export type Gate =
  /** `await requirePermission("a:b", ...)`, any one of the keys lets the request in. */
  | { kind: "permission"; keys: string[] }
  /** `await requireSignedIn()`: anyone signed in, whatever their role. */
  | { kind: "signed-in" }
  /** Anything else, with a sentence saying what was found instead. */
  | { kind: "none"; why: string };

export type RouteHandler = {
  /** The folder under app/api: "admin/roles" for app/api/admin/roles/route.ts. */
  route: string;
  method: Method;
  gate: Gate;
  /**
   * The statements that run before the gate, as source text. They can only be
   * synchronous (the gate is the first thing awaited), and for almost every
   * route there are none.
   */
  before: string[];
};

/** Every route.ts under app/api, sorted so the tests read in a stable order. */
export function routeFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") found.push(full);
    }
  };
  walk(API_DIR);
  return found.sort();
}

function routeNameOf(file: string): string {
  return path.relative(API_DIR, path.dirname(file)).split(path.sep).join("/");
}

function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function isMethod(name: string): name is Method {
  return (METHODS as readonly string[]).includes(name);
}

/**
 * The first `await` in this node, in source order, not counting any inside a
 * function defined in it: a callback that is only defined, not run, waits for
 * nothing yet.
 */
function firstAwait(node: ts.Node): ts.AwaitExpression | null {
  let found: ts.AwaitExpression | null = null;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (ts.isAwaitExpression(child)) {
      found = child;
      return;
    }
    if (ts.isFunctionLike(child)) return;
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/**
 * The variable the await is stored in, when the statement is exactly
 * `const x = await ...;`. Null for anything else, including an await tucked
 * inside an if or a try, where whatever the other branch does goes unchecked.
 */
function storedIn(statement: ts.Statement, awaited: ts.AwaitExpression): string | null {
  if (!ts.isVariableStatement(statement)) return null;
  const declarations = statement.declarationList.declarations;
  if (declarations.length !== 1) return null;
  const [declaration] = declarations;
  if (declaration.initializer !== awaited || !ts.isIdentifier(declaration.name)) return null;
  return declaration.name.text;
}

/** True for `if (!gate.ok) return gate.response;`, the line that acts on a gate. */
function refusesWhenNotOk(
  statement: ts.Statement | undefined,
  name: string,
  file: ts.SourceFile
): boolean {
  if (!statement || !ts.isIfStatement(statement)) return false;
  const text = statement.getText(file).replace(/\s+/g, " ");
  return (
    text === `if (!${name}.ok) return ${name}.response;` ||
    text === `if (!${name}.ok) { return ${name}.response; }`
  );
}

function none(why: string): Gate {
  return { kind: "none", why };
}

/**
 * What a function body checks first. A call to another function in the same
 * file is followed into it, because that is how scripts/apply is written: its
 * POST hands the whole request to runApply, which is where the gate is.
 */
function gateOf(
  body: ts.Block,
  file: ts.SourceFile,
  locals: Map<string, ts.FunctionDeclaration>,
  followed: Set<string>
): { gate: Gate; before: string[] } {
  const before: string[] = [];
  const statements = body.statements;
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    const awaited = firstAwait(statement);
    if (!awaited) {
      before.push(statement.getText(file));
      continue;
    }

    const shown = statement.getText(file).replace(/\s+/g, " ").slice(0, 120);
    const name = storedIn(statement, awaited);
    const call = awaited.expression;
    if (name === null || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) {
      return { gate: none(`the first thing it waits for is \`${shown}\``), before };
    }

    const callee = call.expression.text;
    if (callee === "requirePermission" || callee === "requireSignedIn") {
      if (!refusesWhenNotOk(statements[i + 1], name, file)) {
        return {
          gate: none(`\`${shown}\` is not followed by \`if (!${name}.ok) return ${name}.response;\``),
          before,
        };
      }
      if (callee === "requireSignedIn") return { gate: { kind: "signed-in" }, before };

      // Plain strings only: a key worked out at run time cannot be checked
      // against the catalogue here, so it is reported rather than guessed at.
      const keys = call.arguments.map((arg) => (ts.isStringLiteral(arg) ? arg.text : null));
      if (keys.length === 0 || keys.some((key) => key === null)) {
        return { gate: none(`\`${shown}\` does not name its permissions as plain strings`), before };
      }
      return { gate: { kind: "permission", keys: keys as string[] }, before };
    }

    const local = locals.get(callee);
    if (local?.body && !followed.has(callee)) {
      followed.add(callee);
      const inner = gateOf(local.body, file, locals, followed);
      return { gate: inner.gate, before: [...before, ...inner.before] };
    }
    return { gate: none(`the first thing it waits for is \`${shown}\``), before };
  }
  return { gate: none("it never waits for a gate"), before };
}

/** Every handler a route file exports, and what each one checks first. */
export function handlersIn(file: string): RouteHandler[] {
  return readHandlers(routeNameOf(file), fs.readFileSync(file, "utf8"));
}

/**
 * The same, for route source given as text. The tests also try it on made-up
 * routes, to show it catches a missing gate instead of passing everything.
 */
export function readHandlers(route: string, text: string): RouteHandler[] {
  const source = parse(`${route}/route.ts`, text);

  const locals = new Map<string, ts.FunctionDeclaration>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && !isExported(statement)) {
      locals.set(statement.name.text, statement);
    }
  }

  const handlers: RouteHandler[] = [];
  const add = (method: string, gate: Gate, before: string[] = []) => {
    if (isMethod(method)) handlers.push({ route, method, gate, before });
  };

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && isExported(statement) && statement.name) {
      const method = statement.name.text;
      if (!isMethod(method)) continue;
      if (!statement.body) {
        add(method, none("it has no body to read"));
        continue;
      }
      const { gate, before } = gateOf(statement.body, source, locals, new Set());
      add(method, gate, before);
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      // `export const GET = ...` or `export const { GET, POST } = handlers`.
      // Neither is a function this helper can read, so it says so and the
      // coverage test decides whether that route is allowed to be like that.
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          add(declaration.name.text, none("it is exported as a value, not a function"));
        } else if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (ts.isIdentifier(element.name)) {
              add(element.name.text, none("it is exported as a value, not a function"));
            }
          }
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      // `export { handler as GET }` or `export { GET } from "..."`.
      for (const element of statement.exportClause.elements) {
        add(element.name.text, none("it is re-exported from somewhere else"));
      }
    }
  }
  return handlers;
}

/** Every handler under app/api. */
export function allHandlers(): RouteHandler[] {
  return routeFiles().flatMap(handlersIn);
}

/**
 * Every permission named in a `hasPermission(principal, "a:b", ...)` call in a
 * route file. Those are the checks made after the gate, once the body says
 * which kind of request it is (measuring a query, overwriting a saved set).
 */
export function hasPermissionLiterals(file: string): string[] {
  const source = parse(file, fs.readFileSync(file, "utf8"));
  const keys: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "hasPermission"
    ) {
      for (const arg of node.arguments.slice(1)) {
        if (ts.isStringLiteral(arg)) keys.push(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
}
