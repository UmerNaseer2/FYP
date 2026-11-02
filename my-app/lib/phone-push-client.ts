import { apiFetch } from "@/lib/api-fetch";

/**
 * The browser's half of phone alerts: the service worker, the browser's push
 * subscription, and telling the server about it. lib/push-db.ts holds the other
 * half. See components/phone/AlertsTab.tsx for the screen.
 *
 * A subscription's endpoint is an address anyone could send to, so it travels
 * only in a request body. Paths end up in logs.
 */

export type AlertsState =
  /** This browser has no push at all. */
  | "unsupported"
  /** An iPhone or iPad in a browser tab: push only works from the Home Screen. */
  | "needs-install"
  /** Nobody is signed in with an account to file the device under. */
  | "unavailable"
  /** The person said no, and only the device's settings can change that now. */
  | "denied"
  | "off"
  | "on";

const JSON_HEADERS = { "Content-Type": "application/json" };

function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isAppleMobile(): boolean {
  // An iPad says it is a Mac. The touch points are what give it away.
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isInstalled(): boolean {
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

function decodeKey(text: string): Uint8Array<ArrayBuffer> {
  const plain = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(plain.length));
  for (let at = 0; at < plain.length; at += 1) bytes[at] = plain.charCodeAt(at);
  return bytes;
}

function sameKey(held: ArrayBuffer | null, key: Uint8Array): boolean {
  if (!held || held.byteLength !== key.length) return false;
  const bytes = new Uint8Array(held);
  return key.every((value, at) => value === bytes[at]);
}

async function refusal(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null);
  return new Error(typeof body?.error === "string" ? body.error : fallback);
}

async function readServerKey(): Promise<{ publicKey: string; available: boolean }> {
  const response = await apiFetch("/api/phone/push");
  if (!response.ok) throw await refusal(response, "Could not read the alert settings.");
  return response.json();
}

async function readyWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  // subscribe() refuses a worker that is still installing, and register() does
  // not wait for it.
  return navigator.serviceWorker.ready;
}

async function saveDevice(subscription: PushSubscription): Promise<void> {
  const { endpoint, keys } = subscription.toJSON();
  const response = await apiFetch("/api/phone/push", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ endpoint, keys }),
  });
  if (!response.ok) throw await refusal(response, "Could not turn alerts on.");
}

/**
 * Where alerts stand on this device.
 *
 * A subscription made with a key the server no longer uses can never be sent
 * to, so it is dropped and alerts read as off. One made with the current key is
 * sent to the server again, which brings a lost row back.
 */
export async function readAlertsState(): Promise<AlertsState> {
  if (isAppleMobile() && !isInstalled()) return "needs-install";
  if (!pushSupported()) return "unsupported";
  const { publicKey, available } = await readServerKey();
  if (!available) return "unavailable";
  if (Notification.permission === "denied") return "denied";

  const worker = await readyWorker();
  const held = await worker.pushManager.getSubscription();
  if (!held) return "off";
  if (!sameKey(held.options.applicationServerKey, decodeKey(publicKey))) {
    await held.unsubscribe();
    return "off";
  }
  await saveDevice(held);
  return "on";
}

/** Runs when the phone app opens, so a device that lost its row gets it back unasked. */
export async function keepDeviceOnFile(): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return;
  await readAlertsState();
}

export async function turnAlertsOn(): Promise<AlertsState> {
  const { publicKey, available } = await readServerKey();
  if (!available) return "unavailable";
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "off";

  const worker = await readyWorker();
  const subscription = await worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeKey(publicKey),
  });
  try {
    await saveDevice(subscription);
  } catch (error) {
    // Otherwise the device would say alerts are on while nothing could reach it.
    await subscription.unsubscribe().catch(() => false);
    throw error;
  }
  return "on";
}

/**
 * Turn alerts off here. A failed DELETE does not stop the unsubscribe: the push
 * service then answers that the device has gone, and the server drops its row.
 */
export async function turnAlertsOff(): Promise<void> {
  if (!pushSupported()) return;
  const worker = await navigator.serviceWorker.getRegistration("/");
  const held = await worker?.pushManager.getSubscription();
  if (!held) return;
  await apiFetch("/api/phone/push", {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ endpoint: held.endpoint }),
  }).catch(() => null);
  await held.unsubscribe();
}

export async function sendTestAlert(): Promise<{ sent: number; failed: number }> {
  const response = await apiFetch("/api/phone/push/test", { method: "POST" });
  if (!response.ok) throw await refusal(response, "Could not send a test alert.");
  return response.json();
}
