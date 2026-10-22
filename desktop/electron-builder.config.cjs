/**
 * How electron-builder turns Schema Studio into a .deb for Ubuntu
 * (npm run dist:deb, which builds everything first).
 *
 * The app's own code, its two pages and its icon go into
 * resources/app.asar. The web app's server and PostgreSQL go next to it as
 * ordinary folders, because they run as processes of their own
 * (scripts/after-pack.cjs puts them there).
 *
 * The .deb installs the app into /opt/Schema Studio, puts schema-studio on
 * the PATH, and adds Schema Studio to the app grid. It depends on the
 * libraries Electron needs, by the names every Ubuntu from 20.04 on uses.
 * 24.04 renamed some of them (the "t64" names), so those are listed both
 * ways.
 *
 * The fuses switch off ways to make the installed app run code other than
 * its own: as a plain Node.js, through NODE_OPTIONS, with a debugger
 * attached from the command line, or from a folder next to app.asar.
 */
module.exports = {
  appId: "io.github.umernaseer2.SchemaStudio",
  productName: "Schema Studio",
  directories: { output: "dist", buildResources: "assets" },
  // electron-builder adds the production node_modules itself. assets/ is
  // where it looks for the icon, and it leaves that folder out of the app
  // unless the folder is named here; the windows use the icon too.
  files: ["out/**", "!out/test/**", "!out/contract/**", "renderer/**", "assets/**", "package.json"],
  asar: true,
  // The app's packages are plain JavaScript, so there is nothing to rebuild for Electron.
  npmRebuild: false,
  afterPack: "./scripts/after-pack.cjs",
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  linux: {
    target: ["deb"],
    executableName: "schema-studio",
    category: "Development",
    icon: "assets/icon.png",
    maintainer: "Schema Studio team <schema-studio@users.noreply.github.com>",
    vendor: "Schema Studio team",
    synopsis: "Compare, version and deploy database schemas",
    description:
      "Schema Studio compares, versions and deploys database schemas. The desktop app runs on the computer itself: it keeps its data in a PostgreSQL of its own, finds the databases already running on the computer, and signs in with Microsoft through the system browser.",
    // Names the .desktop file after desktopName in package.json, which is
    // also the name Electron gives the app's windows. That is how the dock
    // knows a window belongs to Schema Studio and shows its icon.
    syncDesktopName: true,
    desktop: {
      entry: {
        Name: "Schema Studio",
        Comment: "Compare, version and deploy database schemas",
        Keywords: "database;schema;postgres;sql;",
        StartupNotify: "true",
      },
    },
  },
  deb: {
    packageName: "schema-studio",
    compression: "xz",
    // Setting depends replaces electron-builder's own list, so its list
    // comes first here.
    depends: [
      "libgtk-3-0 | libgtk-3-0t64",
      "libnotify4",
      "libnss3",
      "libxss1",
      "libxtst6",
      "xdg-utils",
      "libatspi2.0-0 | libatspi2.0-0t64",
      "libuuid1",
      "libsecret-1-0",
      // What Electron needs besides: sound, and drawing with the graphics card.
      "libasound2 | libasound2t64",
      "libgbm1",
      // What PostgreSQL's libraries need.
      "libstdc++6",
      "libgcc-s1 | libgcc1",
    ],
  },
  publish: null,
};
