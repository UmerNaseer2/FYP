/**
 * Locks down the app's windows, so that whatever a page tries, it can only
 * reach Schema Studio's own server and the app's own pages.
 *
 * An Electron window is a web browser that, unless the app says otherwise,
 * loads anything from anywhere and grants whatever a page asks for. Here the
 * app says otherwise:
 *
 *  - Requests. A window may load from the server (http://127.0.0.1:<port>)
 *    and the app:// pages, and nothing else: not a script from the internet,
 *    not another program's local server. Anything else is stopped before it
 *    is sent, and each place is noted once in the log.
 *  - The gate. The gate token (see src/server/desktop-gate.ts) is added to
 *    every request for the server here, outside the page, so no page can
 *    read it, and one a page tries to send itself is removed. Without the
 *    token the server answers nothing, which keeps other programs, and web
 *    pages in the person's browser, out.
 *  - Navigation. The main window only ever shows the server's pages. A link
 *    to a website opens in the person's web browser instead, and no page can
 *    open a window of its own or embed a webview.
 *  - Permissions. Camera, microphone, location, notifications, USB devices
 *    and the rest are refused. Copying to the clipboard and full screen are
 *    allowed, for the server's pages only.
 *  - Downloads. Only the main window may save a file (an exported script,
 *    say), and only one its own pages made.
 *  - Right-click. Text boxes get Undo, Cut, Copy and Paste, and selected
 *    text gets Copy, as they would in a browser.
 */
import path from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from "electron";

import { GATE_HEADER } from "../server/desktop-gate";
import { logInfo, logWarn } from "./log";
import { APP_HOST } from "./protocol";

export type SecurityOptions = {
  /** http://127.0.0.1:<port> once the server is running, and null before. */
  serverOrigin: () => string | null;
  gateToken: string;
  /** True for the main window's page, the only one that may change page or save files. */
  isMainWindow: (contents: WebContents) => boolean;
  /** Opens a website in the person's web browser. */
  openExternal: (url: string) => void;
};

const ALLOWED_PERMISSIONS = new Set<string>(["clipboard-sanitized-write", "fullscreen"]);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isServerUrl(url: string, serverOrigin: string | null): boolean {
  const parsed = parse(url);
  return serverOrigin !== null && parsed !== null && parsed.protocol === "http:" && parsed.origin === serverOrigin;
}

function isDevtoolsUrl(url: string): boolean {
  return url.startsWith("devtools:") || url.startsWith("chrome-devtools:");
}

function isWebsite(url: string): boolean {
  const parsed = parse(url);
  return parsed !== null && (parsed.protocol === "https:" || parsed.protocol === "http:");
}

/** Where a request was going, for the log: the site only, never the whole address. */
function placeOf(url: string): string {
  const parsed = parse(url);
  if (parsed === null) return "an address that could not be read";
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : parsed.protocol;
}

function isAllowedRequest(url: string, serverOrigin: string | null): boolean {
  const parsed = parse(url);
  if (parsed === null) return false;
  switch (parsed.protocol) {
    case "http:":
      return serverOrigin !== null && parsed.origin === serverOrigin;
    case "app:":
      return parsed.host === APP_HOST;
    // The developer tools, in a development run, and things a page made
    // itself, which never leave the computer.
    case "devtools:":
    case "chrome-devtools:":
    case "data:":
    case "blob:":
      return true;
    default:
      return false;
  }
}

function isAllowedDownload(url: string, pageUrl: string, serverOrigin: string | null): boolean {
  if (serverOrigin === null) return false;
  const parsed = parse(url);
  if (parsed === null) return false;
  switch (parsed.protocol) {
    // A blob: address carries the origin of the page that made it, so this
    // covers a file the page put together itself, such as an exported script.
    case "blob:":
    case "http:":
      return parsed.origin === serverOrigin;
    // A data: address carries no origin, so the page asking decides.
    case "data:":
      return parse(pageUrl)?.origin === serverOrigin;
    default:
      return false;
  }
}

function showContextMenu(contents: WebContents, params: ContextMenuParams): void {
  // The developer tools have a menu of their own.
  if (contents.getURL().startsWith("devtools:")) return;
  const template: MenuItemConstructorOptions[] = [];
  if (params.isEditable) {
    const can = params.editFlags;
    template.push(
      { role: "undo", enabled: can.canUndo },
      { role: "redo", enabled: can.canRedo },
      { type: "separator" },
      { role: "cut", enabled: can.canCut },
      { role: "copy", enabled: can.canCopy },
      { role: "paste", enabled: can.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: can.canSelectAll },
    );
  } else if (params.selectionText.trim() !== "") {
    template.push({ role: "copy" });
  }
  if (template.length === 0) return;
  Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
}

function secureContents(contents: WebContents, options: SecurityOptions): void {
  const { serverOrigin } = options;

  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
    logWarn("Stopped a page from embedding a webview.");
  });

  contents.on("will-navigate", (details) => {
    const { url } = details;
    if (isDevtoolsUrl(url)) return;
    if (options.isMainWindow(contents) && isServerUrl(url, serverOrigin())) return;
    details.preventDefault();
    if (isWebsite(url) && !isServerUrl(url, serverOrigin())) {
      options.openExternal(url);
      return;
    }
    logWarn(`Stopped a window from going to ${placeOf(url)}.`);
  });

  // Fires for every redirect, including on pages the app loads itself.
  contents.on("will-redirect", (details) => {
    const { url } = details;
    if (isDevtoolsUrl(url) || isServerUrl(url, serverOrigin())) return;
    details.preventDefault();
    logWarn(`Stopped a redirect to ${placeOf(url)}.`);
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (isWebsite(url) && !isServerUrl(url, serverOrigin())) options.openExternal(url);
    return { action: "deny" };
  });

  contents.on("context-menu", (_event, params) => showContextMenu(contents, params));
}

/**
 * Applies all of the above to the windows' session, and to every window and
 * page the app makes from now on. Call it once, before the first window.
 */
export function secureWindows(ses: Session, options: SecurityOptions): void {
  const { serverOrigin, gateToken } = options;

  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission) && isServerUrl(details.requestingUrl ?? "", serverOrigin());
    if (!allowed) logInfo(`Refused a page's request for the "${permission}" permission.`);
    callback(allowed);
  });
  ses.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      ALLOWED_PERMISSIONS.has(permission) && requestingOrigin === serverOrigin(),
  );
  ses.setDevicePermissionHandler(() => false);
  // Electron's spell checker downloads its dictionaries from the internet.
  ses.setSpellCheckerEnabled(false);

  const blocked = new Set<string>();
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (isAllowedRequest(details.url, serverOrigin())) {
      callback({});
      return;
    }
    const place = placeOf(details.url);
    if (!blocked.has(place)) {
      blocked.add(place);
      logWarn(`Stopped a window from loading something from ${place}. The app's windows only load Schema Studio's own pages.`);
    }
    callback({ cancel: true });
  });

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(details.requestHeaders)) {
      if (name.toLowerCase() !== GATE_HEADER) headers[name] = value;
    }
    if (isServerUrl(details.url, serverOrigin())) headers[GATE_HEADER] = gateToken;
    callback({ requestHeaders: headers });
  });

  ses.on("will-download", (event, item, contents) => {
    if (options.isMainWindow(contents) && isAllowedDownload(item.getURL(), contents.getURL(), serverOrigin())) {
      try {
        item.setSaveDialogOptions({ defaultPath: path.join(app.getPath("downloads"), item.getFilename()) });
      } catch {
        // No Downloads folder: the save dialog starts somewhere else instead.
      }
      return;
    }
    event.preventDefault();
    logWarn(`Stopped a download from ${placeOf(item.getURL())}, which is not one of Schema Studio's own pages.`);
  });

  app.on("web-contents-created", (_event, contents) => secureContents(contents, options));
}
