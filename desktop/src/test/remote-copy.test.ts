/**
 * The relay (relay/) keeps a copy of the phone link's shared code,
 * src/shared/remote, in relay/src/shared/remote, so it can build on its own.
 * This keeps the copy exact.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// This file runs from out/test, two folders below desktop/.
const desktopRoot = path.resolve(__dirname, "../..");

test("the relay's copy of the phone link's shared code matches the app's exactly", () => {
  const original = path.join(desktopRoot, "src/shared/remote");
  const copy = path.join(desktopRoot, "../relay/src/shared/remote");
  const fix = "Replace relay/src/shared/remote with a copy of desktop/src/shared/remote, then build again.";
  const files = fs.readdirSync(original).sort();
  assert.deepEqual(fs.readdirSync(copy).sort(), files, fix);
  for (const file of files) {
    assert.equal(fs.readFileSync(path.join(copy, file), "utf8"), fs.readFileSync(path.join(original, file), "utf8"), `${file} differs. ${fix}`);
  }
});
