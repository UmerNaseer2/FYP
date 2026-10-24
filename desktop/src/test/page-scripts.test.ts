/**
 * The scripts of the app's own two pages (src/renderer), run as their pages
 * run them. A page loads each one with a plain <script> tag, so it has to be
 * a plain script that needs nothing only Node has. A page has no `exports`
 * and no `require`, and a script that used either would stop on that line
 * and leave the page blank.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

test("each page script runs as a plain page script, up to its first look at the page", () => {
  for (const [file, page] of [
    ["splash.js", "splash"],
    ["settings.js", "Settings page"],
    ["settings-phone.js", "Settings page"],
    ["settings-backup.js", "Settings page"],
  ]) {
    const code = fs.readFileSync(path.join(__dirname, "..", "renderer", file), "utf8");
    // An empty page has none of the parts the script looks for, so the
    // script stops at the first one. Anything that only Node has would
    // have stopped it before that.
    const emptyPage = { window: {}, document: { getElementById: () => null } };
    assert.throws(() => vm.runInNewContext(code, emptyPage, { filename: file }), {
      message: new RegExp(`^The ${page} has no #`),
    });
  }
});
