/**
 * What the Settings window's Phone section asks of the phone link, as answers
 * the page shows as they are.
 *
 * The page never gets the pairing link: the link carries a one-time secret,
 * so only its QR drawing leaves this module, and nothing here logs it. Each
 * refusal is a sentence for a person, written here rather than in the page,
 * so that the page has no rules of its own to fall out of step with the
 * phone link's.
 */
import { MAX_PAIRED_PHONES } from "../core/phone-link-file";
import type { PhoneConnections, PhonePairing, PhoneStatus, PhoneView, SetRelayResult } from "../shared/ipc";
import { readRelayOrigin } from "../shared/remote/relay-protocol";
import { readResult } from "../shared/remote/rpc";
import type { PhoneLink, PhoneLinkStatus, PhoneLinkView } from "./phone-link";
import type { AppAnswer } from "./phone-requests";
import { pairingQr } from "./qr";

/** The parts of the phone link that Settings uses, so that a test can stand in for it. */
export type PhoneSettingsLink = Pick<PhoneLink, "view" | "newPairingLink" | "setRelayOrigin">;

/** Shown until the phone link has opened, which it does once Schema Studio has started. */
export const NOT_STARTED = "The phone link starts once Schema Studio has started.";
export const CONNECTIONS_FAILED =
  "Schema Studio could not list the saved connections. Try again, and if it keeps happening, the logs say why.";
const SIGNED_OUT = "Sign in to Schema Studio to choose which connections phones may see.";
// GET /api/connections/phone lets in a role that may use either screen a phone uses the list for.
const FORBIDDEN =
  "Your role in Schema Studio may not use Compare or the Visualizer, so phones cannot be shown any connections. An admin can change what your role may do.";
const BAD_RELAY =
  "Enter the relay's address on its own, such as https://relay.example.com. Only a relay on this computer may use http, such as http://localhost:8787.";
const TURNED_OFF = "Turn the phone link on to pair a phone.";
const NO_RELAY = "Add a relay first: a phone pairs through it.";
const NOT_CONNECTED = "The phone link is not connected to the relay yet, and a phone pairs through it.";
const FULL = `${MAX_PAIRED_PHONES} phones are paired, the most there can be. Remove one to pair another.`;

/** How the phone link stands, with only what the page shows, or why it cannot be shown. */
export function phoneView(link: PhoneSettingsLink | null, problem: string | null): PhoneView {
  if (link === null) return { available: false, message: problem ?? NOT_STARTED };
  const view = link.view();
  return {
    available: true,
    status: copyStatus(view.status),
    enabled: view.enabled,
    relayOrigin: view.relayOrigin,
    sharedConnectionIds: [...view.sharedConnectionIds],
    phones: view.phones.map((phone) => ({
      key: phone.key,
      name: phone.name,
      pairedAt: phone.pairedAt,
      lastSeenAt: phone.lastSeenAt,
      connected: phone.connected,
      alerts: phone.alerts,
      approvals: phone.approvals,
      approvalsAllowedUntil: phone.approvalsAllowedUntil,
    })),
    cannotPair: pairingProblem(view),
  };
}

function copyStatus(status: PhoneLinkStatus): PhoneStatus {
  if (status.state === "waiting") return { state: "waiting", retryAt: status.retryAt, reason: status.reason };
  return { state: status.state };
}

/**
 * Why a phone cannot pair now, or null when one can. A phone pairs through
 * the relay, so the link must be on and connected, with room for one more phone.
 */
function pairingProblem(view: PhoneLinkView): string | null {
  if (!view.enabled) return TURNED_OFF;
  if (view.status.state === "needs-relay") return NO_RELAY;
  if (view.status.state !== "connected") return NOT_CONNECTED;
  if (view.phones.length >= MAX_PAIRED_PHONES) return FULL;
  return null;
}

/** A new pairing code for Settings to show, as its QR drawing, or why a phone cannot pair now. */
export function makePairing(link: PhoneSettingsLink | null, problem: string | null): PhonePairing {
  if (link === null) return { ok: false, message: problem ?? NOT_STARTED };
  const cannotPair = pairingProblem(link.view());
  if (cannotPair !== null) return { ok: false, message: cannotPair };
  const made = link.newPairingLink();
  if (made === null) return { ok: false, message: NOT_CONNECTED };
  return { ok: true, expiresAt: made.expiresAt, qr: pairingQr(made.link) };
}

/** Saves the relay's address as the person typed it, tidied, or says why it is not one. */
export function setRelay(link: PhoneSettingsLink | null, text: unknown, problem: string | null): SetRelayResult {
  if (link === null) return { ok: false, message: problem ?? NOT_STARTED };
  const origin = typeof text === "string" ? readRelayOrigin(text) : null;
  if (origin === null || !link.setRelayOrigin(origin)) return { ok: false, message: BAD_RELAY };
  return { ok: true, relayOrigin: origin };
}

/** The server's answer to GET /api/connections/phone, as the list Settings shows, or why there is none. */
export function readPhoneConnections(answer: AppAnswer): PhoneConnections {
  if (answer.status === 401) return { ok: false, message: SIGNED_OUT };
  if (answer.status === 403) return { ok: false, message: FORBIDDEN };
  // The same reader as for a phone's connections.list, so Settings lists exactly what a phone could be shown.
  const list = answer.status === 200 ? readResult("connections.list", answer.json) : null;
  if (list === null) return { ok: false, message: CONNECTIONS_FAILED };
  return { ok: true, connections: list.connections };
}
