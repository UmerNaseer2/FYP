/*
 * The phone app's service worker. It only shows alerts: the server sends each
 * one through the browser's push service, encrypted for this device, and the
 * browser wakes this worker to show it, even when the app is closed.
 *
 * It keeps no copy of the app and has no fetch handler. Everything the app
 * shows comes from the server anyway, so an offline copy would only show an
 * empty frame, and a stale one could outlive a sign-out.
 *
 * A plain script, because it is served as it is from public/. Tested in
 * tests/phone-sw.test.ts.
 */
"use strict";

/** The app's icon, which every alert shows. */
const ICON = "/icons/icon-192.png";
/** The one-color icon Android shows in the status bar. */
const BADGE = "/icons/badge-96.png";
/** Where an alert leads when it does not say. */
const HOME = "/phone";
/** What an alert says when this copy of the app cannot read what the server sent. */
const UNREADABLE_ALERT = {
  title: "Schema Studio",
  body: "There is something new in Schema Studio. Open the app to see it.",
  url: HOME,
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  // Every push shows something. A push that shows nothing makes the browser
  // show its own vaguer note instead, or stop sending alerts to the app.
  const alert = readAlert(event.data) || UNREADABLE_ALERT;
  event.waitUntil(
    self.registration.showNotification(alert.title, {
      body: alert.body,
      icon: ICON,
      badge: BADGE,
      data: { url: alert.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  event.waitUntil(openApp(samePlace(data && data.url) || HOME));
});

/**
 * An address on this site, or null. Only a path that stays here counts, so an
 * alert can never lead anywhere else. "//host" and "/\\host" both read as
 * another site, which is what parsing it against this site's address catches.
 */
function samePlace(url) {
  if (typeof url !== "string" || !url.startsWith("/")) return null;
  try {
    const parsed = new URL(url, self.location.origin);
    return parsed.origin === self.location.origin ? parsed.pathname + parsed.search : null;
  } catch {
    return null;
  }
}

/**
 * An alert's title, text and address, or null when the push is not one this
 * copy of the app knows. The server sends `{ v: 1, kind, title, body, url }`
 * (lib/push-send.ts). Notifications show plain text, so nothing in it is read
 * as markup.
 */
function readAlert(data) {
  if (!data) return null;
  let value;
  try {
    value = data.json();
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { v, title, body, url } = value;
  if (v !== 1 || typeof title !== "string" || typeof body !== "string" || title.trim() === "") return null;
  return { title, body, url: samePlace(url) || HOME };
}

/** Shows the place: in a window the app already has open, or in a new one. */
async function openApp(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).origin !== self.location.origin) continue;
    await client.focus();
    // A browser may refuse to move a window it does not think this worker
    // controls. The window is in front by then, which is most of what was asked.
    if (client.navigate) await client.navigate(url).catch(() => undefined);
    return;
  }
  await self.clients.openWindow(url);
}
