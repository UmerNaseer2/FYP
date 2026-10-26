import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Checks the Microsoft ID token the desktop app hands over when someone signs
 * in, and turns it into the person Auth.js should sign in.
 *
 * In a browser, Auth.js signs a person in by itself: it sends them to
 * Microsoft, Microsoft sends them back with a one-time code, and this server
 * swaps that code for their details using the app's client SECRET. The desktop
 * app cannot work that way. A secret inside an installer is readable by anyone
 * who has the installer, and this repository is public. So the desktop app
 * signs in the way Microsoft documents for desktop apps (a public client with
 * PKCE, in the system browser, which needs no secret) and hands the ID token it
 * gets back to this server, which then has to decide whether to believe it.
 *
 * Believing it means checking everything a forger could change:
 *   - the signature, against the keys Microsoft publishes for this tenant;
 *   - who issued it (this tenant's v2.0 endpoint) and who it was issued for
 *     (this app's client ID), so that a genuine token Microsoft issued to some
 *     other app, or to another organization, is still refused;
 *   - the tenant ID inside it, for the same reason;
 *   - that it is fresh. An ID token is valid for an hour, but this one is only
 *     ever used in the seconds after the person signed in, so anything issued
 *     more than ten minutes ago is refused.
 *
 * Every failure returns null rather than throwing. Auth.js turns a null from a
 * provider's authorize() into "CredentialsSignin", which the login screen
 * explains in words; a throw becomes "Configuration", which would tell the
 * person that the app is broken. The actual reason goes to the server log.
 *
 * The client and tenant IDs are read when a token is checked, not when this
 * module loads, so the tests can set them per case.
 */

/** Entra client and tenant IDs are both GUIDs; anything else is a typo. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Far longer than any real ID token (they run to two or three thousand
 * characters), and short enough that a request cannot make the server parse a
 * megabyte of nonsense.
 */
const MAX_TOKEN_LENGTH = 16_384;

/**
 * Microsoft's signing keys, fetched once per tenant and kept. jose refetches on
 * its own when a token names a key it has not seen, which is how a key
 * rotation on Microsoft's side is picked up without a restart.
 */
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function signingKeys(tenant: string) {
  let keys = keySets.get(tenant);
  if (!keys) {
    keys = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`)
    );
    keySets.set(tenant, keys);
  }
  return keys;
}

/**
 * The person to sign in: the shape Auth.js expects back from authorize().
 *
 * `id` is "<tenant ID>:<object ID>", the same key the browser's Microsoft
 * sign-in files a person under (lib/accounts-db.ts), so signing in on the
 * desktop and in a browser reaches the same account.
 */
export type DesktopUser = { id: string; email: string; name: string | null };

/** A claim, if it is a string with something in it. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function refuse(reason: string): null {
  console.warn(`[desktop sign-in] Refused a sign-in: ${reason}`);
  return null;
}

export async function verifyDesktopIdToken(token: unknown): Promise<DesktopUser | null> {
  // Lowercased because Microsoft writes both IDs in lowercase inside a token,
  // and an ID pasted from the Azure portal in capitals is still the same ID.
  const clientId = (process.env.AZURE_AD_CLIENT_ID ?? "").trim().toLowerCase();
  const tenant = (process.env.AZURE_AD_TENANT_ID ?? "").trim().toLowerCase();
  if (!GUID.test(clientId) || !GUID.test(tenant)) {
    return refuse(
      "AZURE_AD_CLIENT_ID and AZURE_AD_TENANT_ID must both be set to the IDs from the Azure portal."
    );
  }

  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return refuse("the request did not carry a usable ID token.");
  }

  let claims: JWTPayload;
  try {
    const verified = await jwtVerify(token, signingKeys(tenant), {
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      audience: clientId,
      // The only algorithm Microsoft signs ID tokens with. Naming it stops a
      // token from choosing a weaker one for itself.
      algorithms: ["RS256"],
      maxTokenAge: "10m",
      // A PC clock a few minutes out is common, and refusing everyone on such
      // a machine would look like Microsoft being broken.
      clockTolerance: "5m",
    });
    claims = verified.payload;
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

  if (text(claims.tid)?.toLowerCase() !== tenant) {
    return refuse("the token was issued for a different organization.");
  }

  // The object ID, not `sub`. Both name the person, but `sub` is different for
  // every app registration that asks, and the object ID is the account's own
  // ID within its tenant, the same whichever app reads it. It is what the
  // browser sign-in keys a person by too.
  const objectId = text(claims.oid);
  if (!objectId) return refuse("the token does not say which account signed in.");

  // The address is how the person shows up to everyone else (and how an
  // account made before sign-ins were kept apart is found again). Work
  // accounts carry it as `email` when they have a mailbox, and always as
  // `preferred_username`, their sign-in name, which for an organization's
  // accounts is an address as well.
  const email = [text(claims.email), text(claims.preferred_username)].find(
    (value): value is string => value !== null && value.includes("@")
  );
  if (!email) return refuse("the Microsoft account has no email address.");

  return { id: `${tenant}:${objectId.toLowerCase()}`, email, name: text(claims.name) };
}
