/**
 * The phone app's screens, and the part of the page's address that names the
 * one showing.
 *
 * The app is a single page, and everything after "#" in its address says
 * which screen it shows. So the Back button, a reload and the Home Screen icon
 * all work, and none of it reaches the relay, because a browser never sends
 * the part after "#". A pairing link keeps its code in the same place
 * ("#pair=..."), but main.ts reads that with readAddressPairing (scan.ts) and
 * takes it out of the address at once, so it is never a route.
 *
 * Pure, so the tests (src/test/phone-routes.test.ts) can run it in Node.
 */
import { isSchemaName } from "../shared/remote/rpc.js";

/** A screen, and what it shows. */
export type Route =
  | { screen: "home" }
  | { screen: "connection"; connectionId: number }
  | { screen: "schema"; connectionId: number; schema: string }
  | { screen: "compare" }
  | { screen: "settings" }
  | { screen: "scan" }
  | { screen: "approvals" }
  | { screen: "approval"; approvalId: number };

/** The first screen: the computer, and the connections it shares. */
export const HOME: Route = { screen: "home" };

/** A connection's or a request's ID as an address writes it: a whole number from 1, with no 0 in front. */
const ID = /^[1-9][0-9]{0,15}$/;

/**
 * The route the "#..." part of an address names. Anything else, such as an
 * old bookmark or a mistyped address, is the home screen rather than an
 * error, because the home screen is where anyone would go next anyway.
 */
export function readRoute(hash: string): Route {
  const parts = (hash.startsWith("#") ? hash.slice(1) : hash).split("/");
  // Every address but home's starts "#/", so the first part is empty.
  if (parts[0] !== "") return HOME;
  if (parts.length === 2) {
    const screen = parts[1];
    return screen === "compare" || screen === "settings" || screen === "scan" || screen === "approvals" ? { screen } : HOME;
  }
  if (parts[1] === "approvals") {
    const approvalId = parts.length === 3 ? readId(parts[2]) : null;
    return approvalId === null ? HOME : { screen: "approval", approvalId };
  }
  if (parts[1] !== "connections") return HOME;
  const connectionId = readId(parts[2]);
  if (connectionId === null) return HOME;
  if (parts.length === 3) return { screen: "connection", connectionId };
  if (parts.length !== 5 || parts[3] !== "schemas") return HOME;
  const schema = decode(parts[4]);
  return isSchemaName(schema) ? { screen: "schema", connectionId, schema } : HOME;
}

/**
 * The "#..." part of the address for a route. Home has none, so the app's
 * own address stays plain.
 */
export function writeRoute(route: Route): string {
  switch (route.screen) {
    case "home":
      return "";
    case "connection":
      return `#/connections/${route.connectionId}`;
    case "schema": {
      // A schema name could hold "/", "#" or "%", so it is written escaped.
      // A name that cannot be written at all (one with half of an emoji,
      // which no real database has) opens its connection instead, rather
      // than nothing.
      let schema: string;
      try {
        schema = encodeURIComponent(route.schema);
      } catch {
        return `#/connections/${route.connectionId}`;
      }
      return `#/connections/${route.connectionId}/schemas/${schema}`;
    }
    case "approval":
      return `#/approvals/${route.approvalId}`;
    case "compare":
    case "settings":
    case "scan":
    case "approvals":
      return `#/${route.screen}`;
  }
}

/**
 * Where the app's Back button goes when there is no earlier screen of the app
 * to go back to, as after the app was opened from a link or a bookmark. Null
 * on the home screen, which has no Back button.
 */
export function parentOf(route: Route): Route | null {
  switch (route.screen) {
    case "home":
      return null;
    case "schema":
      return { screen: "connection", connectionId: route.connectionId };
    case "approval":
      return { screen: "approvals" };
    default:
      return HOME;
  }
}

/** A connection's or a request's ID from an address, or null when it is not one. */
function readId(text: string): number | null {
  if (!ID.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/** Escaped text from an address, or null when its escapes are broken (such as "%E0%A4%A"). */
function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}
