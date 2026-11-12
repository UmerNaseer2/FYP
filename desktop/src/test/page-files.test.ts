/**
 * The app:// pages may load only the files on the list in
 * src/core/page-files.ts. A script tag whose file is missing from that list
 * gets "not found" and never runs, and the part of the page it looks after
 * stays hidden with nothing to say why.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { pageFile } from "../core/page-files";

const desktop = path.join(__dirname, "..", "..");
const folders = {
  renderer: path.join(desktop, "renderer"),
  rendererScripts: path.join(desktop, "out", "renderer"),
  assets: path.join(desktop, "assets"),
};

/** Every file a page asks for: its scripts, stylesheets and pictures. */
function filesAskedFor(html: string): string[] {
  return [...html.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)="([^"]+)"/g)].map((tag) => tag[1]);
}

for (const page of ["splash.html", "settings.html"]) {
  test(`${page} and every file it asks for can be served`, () => {
    const found = pageFile(folders, `/${page}`);
    assert.ok(found, `${page} is not on the list`);
    const asked = filesAskedFor(fs.readFileSync(found.file, "utf8"));
    assert.ok(asked.length >= 2, `${page} should load a stylesheet and a script`);
    for (const name of asked) {
      const file = pageFile(folders, `/${name}`);
      assert.ok(file, `${page} asks for ${name}, which is not on the list`);
      assert.ok(fs.existsSync(file.file), `${name} is on the list but ${file.file} does not exist`);
    }
  });
}

test("the Settings page loads the script that links the computer to a web site", () => {
  const html = fs.readFileSync(path.join(folders.renderer, "settings.html"), "utf8");
  assert.ok(filesAskedFor(html).includes("settings-cloud.js"));
  assert.equal(pageFile(folders, "/settings-cloud.js")?.type, "text/javascript; charset=utf-8");
});

test("every font the stylesheet asks for can be served", () => {
  const css = fs.readFileSync(path.join(folders.renderer, "app.css"), "utf8");
  const asked = [...css.matchAll(/url\("([^"]+)"\)/g)].map((found) => found[1]);
  assert.ok(asked.length >= 3, "app.css should load the three font families");
  for (const name of asked) {
    const file = pageFile(folders, `/${name}`);
    assert.ok(file, `app.css asks for ${name}, which is not on the list`);
    assert.equal(file.type, "font/woff2");
    assert.ok(fs.existsSync(file.file), `${name} is on the list but ${file.file} does not exist`);
  }
});

test("an address that is not on the list gives nothing", () => {
  for (const name of [
    "/",
    "/settings",
    "/main.js",
    "/../package.json",
    "/settings.html/",
    "/SETTINGS.HTML",
    "/fonts/",
    "/fonts/OFL.txt",
    "/fonts/../app.css",
  ]) {
    assert.equal(pageFile(folders, name), null, name);
  }
});
