/**
 * lib/api-answer.ts: reading what an API route answered, for the screens that
 * show a refusal in the route's own words.
 *
 * Every route here refuses with `{ error: "..." }`, but something else can
 * answer: a proxy's HTML error page, or a server that went away halfway
 * through. Each of those has to come back as null, never as a throw or as
 * something to print, so the screen falls back to wording of its own.
 */
import { errorFrom, jsonOf } from "@/lib/api-answer";

describe("errorFrom", () => {
  test("gives a route's refusal in its own words", () => {
    expect(errorFrom({ error: "This invitation has run out. Ask for a new one." })).toBe(
      "This invitation has run out. Ask for a new one.",
    );
    // Whatever else came with it is not this function's business.
    expect(errorFrom({ error: "This invitation has been used already.", state: "used" })).toBe(
      "This invitation has been used already.",
    );
  });

  test.each([
    ["an empty sentence", { error: "" }],
    ["an error that is not a sentence", { error: { code: "ECONNREFUSED" } }],
    ["an error that is a number", { error: 502 }],
    ["an answer with no error in it", { organization: { slug: "acme", name: "Acme" } }],
    ["null", null],
    ["nothing at all", undefined],
    ["a bare string", "Bad Gateway"],
    ["a list", ["Sign in to continue."]],
  ])("says null for %s, so the screen uses its own words", (_, body) => {
    expect(errorFrom(body)).toBeNull();
  });
});

describe("jsonOf", () => {
  test("reads a JSON answer, refusals included", async () => {
    const refusal = new Response(JSON.stringify({ error: "Sign in again to continue." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    expect(await jsonOf(refusal)).toEqual({ error: "Sign in again to continue." });
  });

  test.each([
    ["a proxy's HTML error page", () => new Response("<html><h1>502 Bad Gateway</h1></html>", { status: 502 })],
    ["an empty body", () => new Response(null, { status: 503 })],
    ["JSON that stops halfway", () => new Response('{"error": "Sign in', { status: 401 })],
    [
      "a body that was read already",
      () => {
        const response = new Response(JSON.stringify({ error: "Gone." }), { status: 410 });
        void response.text();
        return response;
      },
    ],
  ])("says null for %s rather than throwing", async (_, answer) => {
    await expect(jsonOf(answer())).resolves.toBeNull();
  });
});
