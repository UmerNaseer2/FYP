// Secret values written down in this repository, which therefore protect nothing.
//
// docker-compose.yml used to fill in NEXTAUTH_SECRET with the value below when
// none was set, so every copy started that way shared one secret that anyone
// with the source can read. A session cookie signed with it can be forged by
// anyone, and an encryption key derived from it can be derived by anyone. So
// such a value counts as no secret at all: sign-in will not start on it (see
// secretConfigured in auth.config.ts), and saved passwords are not locked with
// a key made from it (see lib/secret-store.ts).
//
// Kept free of imports, because the edge proxy loads auth.config.ts.

/** Every placeholder this repository has ever shipped as a default. */
export const PLACEHOLDER_SECRETS: readonly string[] = ["change-me-before-anyone-else-uses-this"];

/** True when `value`, trimmed, is one of the placeholders. */
export function isPlaceholderSecret(value: string | null | undefined): boolean {
  return PLACEHOLDER_SECRETS.includes(String(value ?? "").trim());
}
