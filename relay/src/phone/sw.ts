/**
 * The phone app's service worker. It keeps a copy of the app's files, so
 * that the app opens without a connection too, and shows the copy only when
 * the network does not answer. Messages to and from the computer never pass
 * through it: a WebSocket does not go through a service worker.
 *
 * The copy is exactly one build's files, which the build lists in BUILD, and
 * it is made in full before it is used. Answers from the network are never
 * added to it, so a phone never mixes the files of two builds.
 *
 * It also shows the computer's drift alerts. The computer sends each one
 * through the browser's push service, encrypted for this phone, and the
 * browser wakes this worker to show it, even when the app is closed.
 *
 * A classic script, not a module, so it imports nothing: the build puts BUILD
 * in front of it, and the tests (src/test/phone-sw.test.ts) run the built
 * copy in Node.
 */
declare const BUILD: { version: string; files: string[] };

const worker = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `phone-${BUILD.version}`;
/** How long the network has to answer before the copy is used. */
const NETWORK_WITHIN_MS = 4_000;
/** The app's icon, which every alert shows. */
const ICON = "/icons/icon-192.png";
/** The one-color icon Android shows in the status bar. */
const BADGE = "/icons/badge-96.png";
/** What an alert says when the phone app cannot read what the computer sent. */
const UNREADABLE_ALERT = {
  title: "Schema Studio",
  body: "The computer sent an alert this phone app cannot read. Open the app to update it.",
};

worker.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(BUILD.files))
      .then(() => worker.skipWaiting()),
  );
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => worker.clients.claim()),
  );
});

worker.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== worker.location.origin) return;
  event.respondWith(answer(request));
});

worker.addEventListener("push", (event) => {
  // The phone asked for alerts that are always shown, so every push shows
  // one. A push that shows nothing would make the browser show its own
  // vaguer note instead, or stop sending alerts to the app.
  const alert = readAlert(event.data) ?? UNREADABLE_ALERT;
  event.waitUntil(worker.registration.showNotification(alert.title, { body: alert.body, icon: ICON, badge: BADGE }));
});

worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openApp());
});

/**
 * A drift alert's title and text, or null when the push is not one this
 * version of the app knows. The computer sends `{ v: 1, kind: "drift",
 * title, body }` (desktop/src/main/phone-link.ts), as plain text, so nothing
 * in it is ever read as markup.
 */
function readAlert(data: PushMessageData | null): { title: string; body: string } | null {
  if (data === null) return null;
  let value: unknown;
  try {
    value = data.json();
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { v, kind, title, body } = value as Record<string, unknown>;
  if (v !== 1 || kind !== "drift" || typeof title !== "string" || typeof body !== "string") return null;
  if (title.trim() === "") return null;
  return { title, body };
}

/** Shows the app: the window it already has open, or a new one. */
async function openApp(): Promise<void> {
  const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).origin === worker.location.origin) {
      await client.focus();
      return;
    }
  }
  await worker.clients.openWindow("/");
}

/** The network's answer, or the copy when the network fails, is too slow or has a server error. */
async function answer(request: Request): Promise<Response> {
  const network = fetch(request);
  const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), NETWORK_WITHIN_MS));
  const first = await Promise.race([network.catch(() => null), late]);
  if (first !== null && first.status < 500) return first;
  const copy = await caches.match(request.mode === "navigate" ? "/" : request, { cacheName: CACHE });
  return copy ?? network;
}
