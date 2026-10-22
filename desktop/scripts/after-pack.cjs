/**
 * electron-builder runs this after it lays out the app's files, and before
 * it builds the .deb from them (electron-builder.config.cjs). It adds the
 * parts that cannot go into the app's archive, resources/app.asar:
 *
 *  - resources/server: the web app's server (npm run build:server), and the
 *    two small files that start it inside Electron (out/server). The server
 *    runs as a process of its own and reads its files from a real folder.
 *  - resources/postgres: PostgreSQL (npm run fetch:postgres). The system has
 *    to run its programs, which it cannot do from inside an archive.
 *  - resources/icon.png, for the About box.
 *
 * Then it checks that Electron and PostgreSQL's programs are built for the
 * processor this .deb is for, so that an arm64 installer can never hold an
 * x64 PostgreSQL left over from another build, or the other way round.
 */
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
/** electron-builder's numbers for processors (the Arch enum in builder-util). */
const ARCH_NAMES = { 1: "x64", 3: "arm64" };
/** The processor a Linux program says it is for, in the e_machine field of its ELF header. */
const ELF_MACHINES = { x64: 62, arm64: 183 };

function need(file, howToMake) {
  if (!fs.existsSync(file)) throw new Error(`${path.relative(desktopDir, file)} is missing. ${howToMake}`);
}

function checkProgram(file, arch) {
  const header = Buffer.alloc(20);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${file} is not a Linux program.`);
  const machine = header.readUInt16LE(18);
  if (machine !== ELF_MACHINES[arch]) {
    const builtFor = Object.keys(ELF_MACHINES).find((name) => ELF_MACHINES[name] === machine) ?? `processor ${machine}`;
    throw new Error(`${file} is built for ${builtFor}, but this installer is for ${arch}.`);
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") throw new Error("Schema Studio is packaged for Linux only.");
  const arch = ARCH_NAMES[context.arch];
  if (arch === undefined) throw new Error("Schema Studio is packaged for x64 and arm64 only.");

  const serverBuild = path.join(desktopDir, "build", "server");
  const postgresBuild = path.join(desktopDir, "build", "postgres", `linux-${arch}`);
  const launcherFiles = ["desktop-launcher.js", "desktop-gate.js"];
  need(path.join(serverBuild, "server.js"), "Run npm run build:server first.");
  need(path.join(serverBuild, ".schema-studio-build.json"), "Run npm run build:server again: it stopped before it finished.");
  for (const file of launcherFiles) need(path.join(desktopDir, "out", "server", file), "Run npm run build:ts first.");
  need(path.join(postgresBuild, ".version"), `Run npm run fetch:postgres -- --platform linux --arch ${arch} first.`);
  need(path.join(desktopDir, "assets", "icon.png"), "Run npm run make-icon first.");

  const resources = path.join(context.appOutDir, "resources");
  const serverDir = path.join(resources, "server");
  const postgresDir = path.join(resources, "postgres");
  fs.rmSync(serverDir, { recursive: true, force: true });
  fs.rmSync(postgresDir, { recursive: true, force: true });
  // verbatimSymlinks keeps links as they are. PostgreSQL's library links
  // point to the file next to them, and must keep doing so once installed.
  fs.cpSync(serverBuild, serverDir, { recursive: true, verbatimSymlinks: true });
  for (const file of launcherFiles) {
    fs.copyFileSync(path.join(desktopDir, "out", "server", file), path.join(serverDir, file));
  }
  fs.cpSync(postgresBuild, postgresDir, { recursive: true, verbatimSymlinks: true });
  fs.copyFileSync(path.join(desktopDir, "assets", "icon.png"), path.join(resources, "icon.png"));

  const programs = [
    path.join(context.appOutDir, context.packager.executableName),
    ...["postgres", "initdb", "pg_ctl"].map((name) => path.join(postgresDir, "bin", name)),
  ];
  for (const program of programs) checkProgram(program, arch);
};
