// permissions-coverage: every API route asks for a permission before it does
// anything, and every permission in the catalogue is asked for somewhere.
//
// The two ways per-feature permissions go wrong without anyone noticing:
//
//   - A new route forgets its gate. Nothing on screen shows it, because the
//     screens hide their buttons from roles that lack the permission, so the
//     only person who finds the open route is someone calling it directly.
//   - A permission exists on the admin grid but no route checks it. The admin
//     unticks the box, the screen hides the button, and the route still does
//     the thing for anyone who asks. A box that does nothing is worse than no
//     box, because it is believed.
//
// Both are read from the source by tests/helpers/route-gates.ts, so they hold
// for routes nobody has written a test for yet.
import { ALL_PERMISSIONS, isPermissionKey } from "@/lib/permissions";
import {
  allHandlers,
  hasPermissionLiterals,
  readHandlers,
  routeFiles,
  type Gate,
  type RouteHandler,
} from "./helpers/route-gates";

/**
 * Routes that answer before anyone is known, on purpose. Each one says why,
 * because an entry here is a route the rest of this file stops looking at.
 */
const EXEMPT: Record<string, string> = {
  // NextAuth's own endpoints. Signing in is how a person gets a role at all,
  // so there is nothing yet to check it against.
  "auth/[...nextauth]": "sign-in itself",
};

/**
 * Routes any signed-in person may call, whatever their role. Both are about
 * the person asking rather than any feature: what their own role may do, and
 * (only while authentication is off) which role to view the app as.
 */
const ANY_SIGNED_IN = ["me", "me/view-as"];

const handlers = allHandlers();

function named(handler: RouteHandler): string {
  return `${handler.method} /api/${handler.route}`;
}

describe("the route reader", () => {
  test("finds a handler in every route file", () => {
    // Guards the reader itself. If it stopped recognising handlers, every test
    // below would pass on an empty list.
    const routesWithHandlers = new Set(handlers.map((h) => h.route));
    expect(routesWithHandlers.size).toBe(routeFiles().length);
    expect(handlers.length).toBeGreaterThanOrEqual(50);
  });

  // Made-up handlers, to show the reader turns down what it should. Without
  // these, a reader that called every route gated would pass this whole file.
  const gateOf = (body: string): Gate =>
    readHandlers("made-up", `export async function GET(request: Request) {\n${body}\n}`)[0].gate;

  test.each([
    [
      "a gate acted on",
      `const gate = await requirePermission("deploy:read", "scripts:read");
       if (!gate.ok) return gate.response;
       return Response.json([]);`,
      { kind: "permission", keys: ["deploy:read", "scripts:read"] },
    ],
    [
      "a gate acted on in braces",
      `const gate = await requirePermission("deploy:read");
       if (!gate.ok) {
         return gate.response;
       }`,
      { kind: "permission", keys: ["deploy:read"] },
    ],
    [
      "a signed-in check",
      `const gate = await requireSignedIn();
       if (!gate.ok) return gate.response;`,
      { kind: "signed-in" },
    ],
  ])("accepts %s", (_name, body, gate) => {
    expect(gateOf(body)).toEqual(gate);
  });

  test.each([
    ["no gate at all", `return Response.json([]);`, "it never waits for a gate"],
    [
      "work done before the gate",
      `const rows = await pool.query("SELECT 1");
       const gate = await requirePermission("deploy:read");
       if (!gate.ok) return gate.response;`,
      'the first thing it waits for is `const rows = await pool.query("SELECT 1");`',
    ],
    [
      "a gate nobody acts on",
      `const gate = await requirePermission("deploy:run");
       return Response.json({ ran: true });`,
      "is not followed by `if (!gate.ok) return gate.response;`",
    ],
    [
      "a gate acted on the wrong way",
      `const gate = await requirePermission("deploy:run");
       if (!gate.ok) return Response.json({ ok: true });`,
      "is not followed by",
    ],
    [
      "a key worked out at run time",
      `const gate = await requirePermission(\`deploy:\${action}\`);
       if (!gate.ok) return gate.response;`,
      "does not name its permissions as plain strings",
    ],
    [
      "a gate on only one branch",
      `if (request.headers.get("x-admin")) {
         const gate = await requirePermission("users:read");
         if (!gate.ok) return gate.response;
       }
       return Response.json([]);`,
      'the first thing it waits for is `if (request.headers.get("x-admin")) {',
    ],
    [
      "a gate inside a try",
      `try {
         const gate = await requirePermission("users:read");
         if (!gate.ok) return gate.response;
       } catch {}`,
      "the first thing it waits for is `try {",
    ],
  ])("turns down %s", (_name, body, why) => {
    const gate = gateOf(body);
    expect(gate.kind).toBe("none");
    expect(gate.kind === "none" && gate.why).toContain(why);
  });

  test("does not count a function that is only defined as waiting", () => {
    const [handler] = readHandlers(
      "made-up",
      `export async function GET() {
         const load = async () => await pool.query("SELECT 1");
         const gate = await requirePermission("deploy:read");
         if (!gate.ok) return gate.response;
       }`
    );
    expect(handler.gate).toEqual({ kind: "permission", keys: ["deploy:read"] });
    expect(handler.before).toEqual(['const load = async () => await pool.query("SELECT 1");']);
  });

  test("follows a handler into a function in the same file, once", () => {
    const [post, get] = readHandlers(
      "made-up",
      `async function run(request: Request) {
         const gate = await requirePermission("deploy:run");
         if (!gate.ok) return gate.response;
         return Response.json({});
       }
       async function again(): Promise<Response> {
         const response = await again();
         return response;
       }
       export async function POST(request: Request) {
         const started = Date.now();
         const response = await run(request);
         return response;
       }
       export async function GET() {
         const response = await again();
         return response;
       }`
    );
    expect([post.method, post.gate, post.before]).toEqual([
      "POST",
      { kind: "permission", keys: ["deploy:run"] },
      ["const started = Date.now();"],
    ]);
    // A function that calls itself is followed once, then reported, not
    // followed for ever.
    expect([get.method, get.gate.kind]).toEqual(["GET", "none"]);
  });

  test("reports handlers it cannot read, and ignores exports that are not handlers", () => {
    const found = readHandlers(
      "made-up",
      `export const dynamic = "force-dynamic";
       export const GET = withGate(handler);
       export const { POST, PUT } = handlers;
       export { remove as DELETE };
       export { OPTIONS } from "../other/route";
       export async function helper() {}`
    );
    expect(found.map((h) => [h.method, h.gate.kind === "none" && h.gate.why])).toEqual([
      ["GET", "it is exported as a value, not a function"],
      ["POST", "it is exported as a value, not a function"],
      ["PUT", "it is exported as a value, not a function"],
      ["DELETE", "it is re-exported from somewhere else"],
      ["OPTIONS", "it is re-exported from somewhere else"],
    ]);
  });
});

describe("every API route", () => {
  test("waits for a permission check before anything else, and acts on it", () => {
    const open = handlers
      .filter((h) => !(h.route in EXEMPT) && h.gate.kind === "none")
      .map((h) => `${named(h)}: ${h.gate.kind === "none" ? h.gate.why : ""}`);
    // A failure here names the handler. The fix is a first line of
    //   const gate = await requirePermission("feature:action");
    //   if (!gate.ok) return gate.response;
    expect(open).toEqual([]);
  });

  test("runs nothing before its gate, apart from the two known exceptions", () => {
    // The gate is the first thing awaited, so whatever comes before it is
    // synchronous. That is still somewhere a request body could be read or a
    // cookie trusted, so the list is kept to what is there for a reason.
    const ran = handlers
      .filter((h) => !(h.route in EXEMPT) && h.before.length > 0)
      .map((h) => [named(h), h.before]);
    expect(ran).toEqual([
      // View as answers 404 before asking who is signed in, so being signed in
      // never makes a way to wear another role appear.
      ["GET /api/me/view-as", ["if (!BYPASS_AUTH) return notAvailable();"]],
      ["POST /api/me/view-as", ["if (!BYPASS_AUTH) return notAvailable();"]],
      // An empty record for the audit trail, filled in as runApply learns each
      // fact. It is written whatever the gate decides.
      ["POST /api/scripts/apply", ["const attempt: AttemptContext = {};"]],
    ]);
  });

  test("lets in anyone signed in only where that is the point", () => {
    const signedInOnly = handlers.filter((h) => h.gate.kind === "signed-in").map(named);
    const expected = handlers.filter((h) => ANY_SIGNED_IN.includes(h.route)).map(named);
    expect(signedInOnly).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  test("keeps the exemptions to routes that still exist", () => {
    // A stale entry would quietly exempt whatever is later written at that path.
    const routes = new Set(handlers.map((h) => h.route));
    for (const route of [...Object.keys(EXEMPT), ...ANY_SIGNED_IN]) {
      expect([route, routes.has(route)]).toEqual([route, true]);
    }
  });
});

describe("every permission", () => {
  const gateKeys = handlers.flatMap((h) => (h.gate.kind === "permission" ? h.gate.keys : []));
  // Checks made after the gate, once the body says which kind of request it
  // is: measuring a query needs Performance: Run, overwriting a saved set
  // needs Comparison sets: Update.
  const laterKeys = routeFiles().flatMap(hasPermissionLiterals);

  test("that a route asks for is one the catalogue knows", () => {
    expect([...gateKeys, ...laterKeys].filter((key) => !isPermissionKey(key))).toEqual([]);
  });

  test("on the admin grid is checked by at least one route", () => {
    const checked = new Set([...gateKeys, ...laterKeys]);
    // A failure names the box that does nothing. Either a route should ask for
    // it, or it should come off the grid (FEATURES in lib/permissions.ts).
    expect(ALL_PERMISSIONS.filter((key) => !checked.has(key))).toEqual([]);
  });
});
