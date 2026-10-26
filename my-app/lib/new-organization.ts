import { ORG_SLUG_PATTERN, isReservedSlug } from "./org-slug";

/**
 * The rules for a new organization's name and address, in one place so the
 * onboarding form and POST /api/organizations say the same thing about the
 * same mistake. The form checks as someone types; the route checks again,
 * because a request does not have to come from the form.
 *
 * Nothing here touches the server, so the form can import it.
 */

/** Long enough for any real name, short enough to fit on the studio rail. */
export const ORG_NAME_MAX_LENGTH = 60;

/** The longest an address can be, from ORG_SLUG_PATTERN. */
export const ORG_SLUG_MAX_LENGTH = 40;

const SLUG = new RegExp(ORG_SLUG_PATTERN);

/**
 * Control characters, and the ones that flip the direction text is drawn in.
 * Neither belongs in a name, and the second kind would let a name read one
 * way on the rail while it is stored another.
 */
const UNSHOWABLE = /[\p{Cc}‪-‮⁦-⁩]/u;

/** A name as it is stored: trimmed, with every run of spaces made one. */
export function cleanOrgName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** What is wrong with a name (cleaned with cleanOrgName first), or null when nothing is. */
export function orgNameProblem(name: string): string | null {
  if (name === "") return "Give the organization a name.";
  if (name.length > ORG_NAME_MAX_LENGTH) {
    return `Keep the name to ${ORG_NAME_MAX_LENGTH} characters or fewer.`;
  }
  if (UNSHOWABLE.test(name)) return "The name has a character that cannot be shown. Type it again.";
  return null;
}

/** What is wrong with an address, or null when nothing is. */
export function orgSlugProblem(slug: string): string | null {
  if (slug === "") return "Give the organization an address.";
  if (!SLUG.test(slug)) {
    return (
      `An address is 3 to ${ORG_SLUG_MAX_LENGTH} lowercase letters, digits and dashes, ` +
      "and starts and ends with a letter or digit."
    );
  }
  if (isReservedSlug(slug)) return "That address is used by the app itself. Pick another.";
  return null;
}

/**
 * An address made from a name, for the form to offer until someone types one
 * of their own: "Acme Café Ltd." becomes "acme-cafe-ltd".
 *
 * Accents come off the letters they sit on, anything else that is not a
 * letter or digit becomes a dash, and the dashes at either end go. What comes
 * back may still be too short, or a reserved word, and orgSlugProblem says so.
 */
export function suggestSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, ORG_SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
}
