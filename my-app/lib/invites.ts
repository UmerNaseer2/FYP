import type { BuiltInRole } from "./permissions";

/**
 * Invitations: how someone new joins an organization on the web.
 *
 * Signing in only says who someone is. Nobody joins an organization by
 * signing in (lib/accounts-db.ts), so an Admin invites them, from the Users
 * tab, in one of two ways:
 *
 * - To an email address, with any role. Only the person who can sign in with
 *   that address can take it, once, within EMAIL_INVITE_DAYS.
 * - As a link, always as a Viewer. Anyone who has the link can join with it,
 *   as many times as it is used, until it runs out or an Admin cancels it.
 *   Viewer only because a link can be passed on: the most it can let a
 *   stranger do is look.
 *
 * Either way the app sends nothing. The Admin is shown the link once, copies
 * it, and sends it themselves, so the app needs no mail server and holds no
 * mailbox's password.
 *
 * This file holds the rules the Users tab, the invitation page and the routes
 * share, so they say the same thing about the same mistake. Nothing here
 * touches the server, so screens can import it. lib/invites-db.ts is the
 * database side.
 */

/** How long an invitation to an email address lasts, in days. */
export const EMAIL_INVITE_DAYS = 7;

/** The lifetimes an Admin can give an invitation link, in days. */
export const LINK_INVITE_DAYS = [1, 7, 30] as const;

export type LinkInviteDays = (typeof LINK_INVITE_DAYS)[number];

/** What the link form starts on: the same week an email invitation gets. */
export const DEFAULT_LINK_INVITE_DAYS: LinkInviteDays = 7;

/**
 * The role every invitation link gives. The database holds it to this too
 * (invites_link_role_check in lib/db/bootstrap.ts), so a link for anything
 * more cannot be stored even by a mistake here.
 */
export const LINK_INVITE_ROLE: BuiltInRole = "viewer";

export function isLinkInviteDays(value: unknown): value is LinkInviteDays {
  return LINK_INVITE_DAYS.some((days) => days === value);
}

/** The longest an address can be: the limit mail servers themselves keep to. */
export const INVITE_EMAIL_MAX_LENGTH = 254;

/**
 * Something, an @, and a domain with a dot in it, with no spaces anywhere.
 * Loose on purpose. The only real test of an address is whether its owner can
 * sign in with it, and that is the test taking the invitation applies.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * An address as it is stored and compared: trimmed and lowercased. The
 * addresses a sign-in reports are stored lowercased too (identities.email),
 * which is what an invitation is matched against.
 */
export function cleanInviteEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** What is wrong with an address (cleaned with cleanInviteEmail first), or null when nothing is. */
export function inviteEmailProblem(email: string): string | null {
  if (email === "") return "Type the email address of the person to invite.";
  if (email.length > INVITE_EMAIL_MAX_LENGTH || !EMAIL.test(email)) {
    return "That is not an email address. It should look like name@example.com.";
  }
  return null;
}

/**
 * What an invitation's token looks like: 32 random bytes, in the URL-safe
 * base64 that fits in a link without escaping. Checked before the database is
 * asked, so a mistyped or made-up link costs a regular expression, not a query.
 */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function isInviteToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

/** Where an invitation's link points, on the site the Admin is using now. */
export function inviteLink(origin: string, token: string): string {
  return `${origin}/invite/${token}`;
}

/**
 * An address with most of its first half hidden: "u•••@example.com".
 *
 * Shown to someone who opened an invitation meant for another address, so
 * they can tell which of their accounts it wants, without the page reading out
 * the whole address to whoever holds the link.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

/** One invitation still waiting to be taken, as the Users tab lists it. */
export type PendingInvite = {
  id: number;
  kind: "email" | "link";
  /** Who it was sent to. Null for a link, which is for whoever has it. */
  email: string | null;
  role: string;
  roleLabel: string;
  /** The address of the Admin who made it, or null once they are gone. */
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
};

/** What GET /api/admin/invites answers. */
export type InviteListing = {
  invites: PendingInvite[];
  /** Whether POST would make one: false in the desktop app and the demo. */
  canInvite: boolean;
};

function isPendingInvite(value: unknown): value is PendingInvite {
  if (typeof value !== "object" || value === null) return false;
  const invite = value as Record<string, unknown>;
  const nullableText = (field: unknown) => field === null || typeof field === "string";
  return (
    typeof invite.id === "number" &&
    (invite.kind === "email" || invite.kind === "link") &&
    nullableText(invite.email) &&
    typeof invite.role === "string" &&
    typeof invite.roleLabel === "string" &&
    nullableText(invite.invitedBy) &&
    typeof invite.createdAt === "string" &&
    typeof invite.expiresAt === "string"
  );
}

/**
 * Whether a body is the list GET /api/admin/invites promises. The Users tab
 * checks before drawing it, because a proxy's error page or an older server
 * can answer with something else.
 */
export function isInviteListing(body: unknown): body is InviteListing {
  if (typeof body !== "object" || body === null) return false;
  const { invites, canInvite } = body as { invites?: unknown; canInvite?: unknown };
  return Array.isArray(invites) && invites.every(isPendingInvite) && typeof canInvite === "boolean";
}

/** Whether a body is what POST /api/admin/invites answers when it made one. */
export function isCreatedInvite(body: unknown): body is { invite: PendingInvite; token: string } {
  if (typeof body !== "object" || body === null) return false;
  const { invite, token } = body as { invite?: unknown; token?: unknown };
  return isPendingInvite(invite) && isInviteToken(token);
}
