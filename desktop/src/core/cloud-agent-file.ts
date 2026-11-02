/**
 * What cloud-link.json holds: the web site this computer is linked to, the
 * token it proves that with, and the organization the person chose when they
 * approved the link (src/main/cloud-agent.ts).
 *
 * The token lets whoever holds it read the questions left for this computer
 * and answer them, so it is kept like the phone link's keys: in the login
 * keyring when there is one (src/main/secrets.ts), and never in a backup, since
 * a restored computer would answer as this one. Link again after a restore.
 *
 * Nothing here is a database password. Those stay in the computer's own app
 * database, and the web site never sees them.
 */
import { readRelayOrigin } from "../shared/remote/relay-protocol";

/** What every token starts with, so that one found somewhere can be recognized. */
export const CLOUD_TOKEN_PREFIX = "ssa_";

/** The web site reads no token longer than this (lib/agent-auth.ts in the web app). */
const MAX_TOKEN_LENGTH = 200;

const MAX_ORG_TEXT_LENGTH = 200;

export type CloudLinkState = {
  /** The site's own address, written the one way a browser writes it. */
  origin: string;
  token: string;
  orgName: string;
  orgSlug: string;
  /** When the link was made, in milliseconds. */
  linkedAt: number;
};

function isOrgText(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_ORG_TEXT_LENGTH;
}

/** Checks what was read, giving null for anything that is not right. */
export function parseCloudLinkState(value: unknown): CloudLinkState | null {
  if (typeof value !== "object" || value === null) return null;
  const { origin, token, orgName, orgSlug, linkedAt } = value as Record<string, unknown>;
  const readOrigin = typeof origin === "string" ? readRelayOrigin(origin) : null;
  if (readOrigin === null) return null;
  if (typeof token !== "string" || !token.startsWith(CLOUD_TOKEN_PREFIX) || token.length > MAX_TOKEN_LENGTH) return null;
  if (!isOrgText(orgName) || !isOrgText(orgSlug)) return null;
  if (typeof linkedAt !== "number" || !Number.isFinite(linkedAt) || linkedAt < 0) return null;
  return { origin: readOrigin, token, orgName, orgSlug, linkedAt };
}
