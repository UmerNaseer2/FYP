/**
 * The nine files the app:// pages are made of. Anything a page asks for
 * that is not on this list does not exist for it (src/main/protocol.ts).
 *
 * A page loads its scripts with plain <script> tags, so a new script needs a
 * line here as well as its tag in the page. src/test/page-files.test.ts
 * checks that every file a page asks for is on the list.
 */
import path from "node:path";

/** The folders the page files are in: three of the AppFiles (src/main/app-files.ts). */
export type PageFolders = { renderer: string; rendererScripts: string; assets: string };

const HTML = "text/html; charset=utf-8";
const JAVASCRIPT = "text/javascript; charset=utf-8";

/** The file behind an app:// address, or null for any address that is not one of the nine. */
export function pageFile(folders: PageFolders, pathname: string): { file: string; type: string } | null {
  switch (pathname) {
    case "/splash.html":
      return { file: path.join(folders.renderer, "splash.html"), type: HTML };
    case "/settings.html":
      return { file: path.join(folders.renderer, "settings.html"), type: HTML };
    case "/app.css":
      return { file: path.join(folders.renderer, "app.css"), type: "text/css; charset=utf-8" };
    case "/splash.js":
      return { file: path.join(folders.rendererScripts, "splash.js"), type: JAVASCRIPT };
    case "/settings.js":
      return { file: path.join(folders.rendererScripts, "settings.js"), type: JAVASCRIPT };
    case "/settings-phone.js":
      return { file: path.join(folders.rendererScripts, "settings-phone.js"), type: JAVASCRIPT };
    case "/settings-backup.js":
      return { file: path.join(folders.rendererScripts, "settings-backup.js"), type: JAVASCRIPT };
    case "/settings-cloud.js":
      return { file: path.join(folders.rendererScripts, "settings-cloud.js"), type: JAVASCRIPT };
    case "/icon.svg":
      return { file: path.join(folders.assets, "icon.svg"), type: "image/svg+xml" };
    default:
      return null;
  }
}
