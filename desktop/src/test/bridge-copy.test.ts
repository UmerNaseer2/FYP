/**
 * The app keeps a copy of the web app's description of the bridge between the
 * two (my-app/lib/desktop-bridge.ts) in src/shared/bridge.ts, so it can build
 * on its own. This keeps the copy exact.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// This file runs from out/test, two folders below desktop/.
const desktopRoot = path.resolve(__dirname, "../..");

test("the app's copy of the bridge matches the web app's file exactly", () => {
  const copy = fs.readFileSync(path.join(desktopRoot, "src/shared/bridge.ts"), "utf8");
  const original = fs.readFileSync(path.join(desktopRoot, "../my-app/lib/desktop-bridge.ts"), "utf8");
  assert.equal(
    copy,
    original,
    "Copy my-app/lib/desktop-bridge.ts over desktop/src/shared/bridge.ts, then build again.",
  );
});
