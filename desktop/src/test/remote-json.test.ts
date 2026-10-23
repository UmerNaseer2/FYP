/**
 * Reading the phone link's JSON messages (src/shared/remote/json.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { utf8 } from "../shared/remote/bytes.js";
import { hasExactly, objectFields, readJsonObject } from "../shared/remote/json.js";

test("gives the fields of a JSON object, and null for anything else", () => {
  assert.deepEqual(objectFields({ a: 1 }), { a: 1 });
  for (const value of [[], null, "{}", 1, true]) {
    assert.equal(objectFields(value), null, JSON.stringify(value));
  }
  // What reading a field that is not there gives.
  assert.equal(objectFields(undefined), null);
});

test("tells whether an object has exactly the fields named, in any order", () => {
  assert.equal(hasExactly({}), true);
  assert.equal(hasExactly({ a: 1, b: 2 }, "a", "b"), true);
  assert.equal(hasExactly({ a: 1, b: 2 }, "b", "a"), true);
  assert.equal(hasExactly({ a: 1 }, "a", "b"), false);
  assert.equal(hasExactly({ a: 1, b: 2 }, "a"), false);
  assert.equal(hasExactly({ a: 1, c: 2 }, "a", "b"), false);
  // A name given twice still leaves the other field unnamed.
  assert.equal(hasExactly({ a: 1, b: 2 }, "a", "a"), false);
});

test("reads a JSON object sent as UTF-8, and nothing else", () => {
  assert.deepEqual(readJsonObject(utf8('{"a":[1,"\u00e9"]}')), { a: [1, "\u00e9"] });
  for (const text of ["", " ", "[]", "null", "1", '"{}"', "{", '{"a":1}x', '{"a":1}{}']) {
    assert.equal(readJsonObject(utf8(text)), null, JSON.stringify(text));
  }
  // Bytes that are not UTF-8, then a byte order mark, which JSON may not start with.
  assert.equal(readJsonObject(Uint8Array.of(0x7b, 0xff, 0x7d)), null);
  assert.equal(readJsonObject(utf8('\ufeff{"a":1}')), null);
});

test("counts a field named __proto__ as a field like any other", () => {
  const fields = readJsonObject(utf8('{"__proto__":{"a":1}}'));
  if (fields === null) throw new Error("Expected the object to be read.");
  assert.equal(hasExactly(fields), false);
  assert.equal(hasExactly(fields, "__proto__"), true);
  // JSON.parse makes it an ordinary field, which leaves the object's prototype alone.
  assert.equal(Object.getPrototypeOf(fields), Object.prototype);
  assert.equal(fields.a, undefined);
});
