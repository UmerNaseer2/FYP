// The version beside the app's name, and the two packages that carry it.
//
// The sidebar, the sign-in page and the landing page each said "v2.0.0" in
// their own copy of the text, while my-app/package.json still said 0.1.0. They
// now share APP_VERSION, and this keeps it level with both package files: the
// desktop app ships these same screens, and its package version is the one its
// releases are tagged with (desktop/README.md, "Publishing").
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { APP_VERSION } from "../lib/app-version";

/** The "version" field of a package.json, from this test's folder. */
function packageVersion(relative: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, relative), "utf8")).version;
}

describe("APP_VERSION", () => {
  it("is the web app's package version", () => {
    expect(packageVersion("../package.json")).toBe(APP_VERSION);
  });

  it("is the desktop app's package version, since it shows the same screens", () => {
    expect(packageVersion("../../desktop/package.json")).toBe(APP_VERSION);
  });
});
