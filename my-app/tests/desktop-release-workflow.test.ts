/**
 * The workflow that publishes the desktop app must stop when a package was
 * built without Microsoft sign-in set up. Every other check passes on such
 * a package, and apt would hand it to every installed copy.
 *
 * The check is a short script inside the workflow file. These tests take
 * it out of the file and run it on small archives made here, laid out the
 * way the app's own archive (app.asar) is.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workflow = fs.readFileSync(
  path.join(__dirname, "..", "..", ".github", "workflows", "desktop-release.yml"),
  "utf8"
);

/** The script the workflow writes to sign-in-set-up.js, between the two EOF marks. */
function checkScript(): string {
  const [, afterStart] = workflow.split("sign-in-set-up.js\" <<'EOF'\n");
  expect(afterStart).toBeDefined();
  return afterStart.split(/\n\s*EOF\n/)[0];
}

/**
 * An archive with the layout of app.asar: four numbers, the list of files
 * as JSON (padded to a multiple of four bytes), then the files themselves.
 * Another file comes first, so the config file does not start at 0.
 */
function archiveWith(config: unknown): Buffer {
  const first = Buffer.from('{ "name": "schema-studio" }\n');
  const configFile = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  const list = Buffer.from(
    JSON.stringify({
      files: {
        "package.json": { size: first.length, offset: "0" },
        out: {
          files: {
            "build-config.json": { size: configFile.length, offset: String(first.length) },
          },
        },
      },
    })
  );
  const padded = list.length + ((4 - (list.length % 4)) % 4);
  const head = Buffer.alloc(16 + padded);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + padded, 4);
  head.writeUInt32LE(4 + padded, 8);
  head.writeUInt32LE(list.length, 12);
  list.copy(head, 16);
  return Buffer.concat([head, first, configFile]);
}

describe("the desktop release workflow's sign-in check", () => {
  let folder: string;
  let script: string;

  beforeAll(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "release-check-"));
    script = path.join(folder, "sign-in-set-up.js");
    fs.writeFileSync(script, checkScript());
  });

  afterAll(() => {
    fs.rmSync(folder, { recursive: true, force: true });
  });

  /** The script's exit code for a package that holds this config. */
  function exitCodeFor(config: unknown): number | null {
    const archive = path.join(folder, "app.asar");
    fs.writeFileSync(archive, archiveWith(config));
    return spawnSync(process.execPath, [script, archive]).status;
  }

  it("passes a package that holds both IDs", () => {
    const ids = {
      clientId: "11111111-2222-3333-4444-555555555555",
      tenantId: "66666666-7777-8888-9999-000000000000",
    };
    expect(exitCodeFor(ids)).toBe(0);
  });

  it("fails a package that was built without the IDs", () => {
    expect(exitCodeFor({ clientId: null, tenantId: null })).not.toBe(0);
  });

  it("fails a package that holds only one of them", () => {
    expect(exitCodeFor({ clientId: "11111111-2222-3333-4444-555555555555", tenantId: null })).not.toBe(0);
  });

  it("fails an archive it cannot read", () => {
    const archive = path.join(folder, "app.asar");
    fs.writeFileSync(archive, "not an archive");
    expect(spawnSync(process.execPath, [script, archive]).status).not.toBe(0);
  });

  it("runs before the signing key is loaded and before anything is published", () => {
    const check = workflow.indexOf("- name: Check that Microsoft sign-in is set up");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(workflow.indexOf("- name: Load the signing key"));
    expect(check).toBeLessThan(workflow.indexOf("- name: Make the GitHub release"));
  });
});
