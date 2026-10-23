/**
 * The app:// pages: the start screen (splash.html) and Settings
 * (settings.html), with their stylesheet, scripts and icon.
 *
 * The app serves them itself rather than opening them as file:// pages,
 * because a file:// page can read any file the person can, and every file://
 * page counts as the same site as every other. app://schema-studio is a site
 * of its own on which only the seven files below exist; any other address is
 * "not found". Every answer carries a strict content security policy, so the
 * pages run only their own scripts, load only their own files, and cannot
 * send anything anywhere.
 */
import fs from "node:fs";
import path from "node:path";
import { protocol, type Session } from "electron";

import type { AppFiles } from "./app-files";
import { logError } from "./log";

export const APP_SCHEME = "app";
export const APP_HOST = "schema-studio";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  // The files only change when the app is updated, and a stale copy after
  // an update would mix old and new.
  "Cache-Control": "no-store",
};

const HTML = "text/html; charset=utf-8";
const JAVASCRIPT = "text/javascript; charset=utf-8";

/** The file behind an app:// address, or null for any address that is not one of the seven. */
function pageFile(files: AppFiles, pathname: string): { file: string; type: string } | null {
  switch (pathname) {
    case "/splash.html":
      return { file: path.join(files.renderer, "splash.html"), type: HTML };
    case "/settings.html":
      return { file: path.join(files.renderer, "settings.html"), type: HTML };
    case "/app.css":
      return { file: path.join(files.renderer, "app.css"), type: "text/css; charset=utf-8" };
    case "/splash.js":
      return { file: path.join(files.rendererScripts, "splash.js"), type: JAVASCRIPT };
    case "/settings.js":
      return { file: path.join(files.rendererScripts, "settings.js"), type: JAVASCRIPT };
    case "/settings-phone.js":
      return { file: path.join(files.rendererScripts, "settings-phone.js"), type: JAVASCRIPT };
    case "/icon.svg":
      return { file: path.join(files.assets, "icon.svg"), type: "image/svg+xml" };
    default:
      return null;
  }
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
}

/**
 * Makes app:// a proper web address: its pages get a site of their own,
 * count as secure, and can use relative links. Electron needs this before
 * the app is ready.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** Serves the app:// pages to the windows that use `ses`. */
export function serveAppPages(ses: Session, files: AppFiles): void {
  ses.protocol.handle(APP_SCHEME, async (request) => {
    // Node gives app: addresses no origin ("null"), so the parts are checked
    // one by one instead.
    const url = new URL(request.url);
    const found = request.method === "GET" && url.host === APP_HOST ? pageFile(files, url.pathname) : null;
    if (found === null) return textResponse(404, "Not found");
    try {
      const body = await fs.promises.readFile(found.file);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { ...SECURITY_HEADERS, "Content-Type": found.type },
      });
    } catch (error) {
      logError(`Could not read ${found.file} for ${APP_ORIGIN}${url.pathname}.`, error);
      return textResponse(500, "This part of Schema Studio is missing. Reinstall Schema Studio.");
    }
  });
}
