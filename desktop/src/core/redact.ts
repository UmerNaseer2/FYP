/**
 * Removes anything private from text before it leaves the computer: the
 * diagnostics that Help > Copy Diagnostics puts on the clipboard, and the
 * "Copy details" button on the start screen when something fails. People
 * paste these into chats and issues, so the rule is: when in doubt, cut it.
 *
 * What goes:
 *  - the app's own secrets, matched exactly (the caller passes them in);
 *  - sign-in tokens (JWTs, which all start "eyJ") and GitHub tokens;
 *  - passwords inside connection URLs, and password, token and code values
 *    in URLs, headers, JSON and key=value text;
 *  - email addresses, which name the person;
 *  - the home folder, which usually contains the person's login name.
 *
 * Pure, and tested in src/test/redact.test.ts.
 */

export type RedactOptions = {
  /** Exact values to remove wherever they appear. Short ones are ignored. */
  secrets: (string | null | undefined)[];
  /** The home folder, shown as ~ instead. */
  home: string | null;
};

/** Secrets shorter than this are not matched, to avoid cutting ordinary words. */
const MIN_SECRET_LENGTH = 8;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SENSITIVE_KEYS =
  "password|passwd|pwd|secret|client_secret|token|access_token|id_token|refresh_token|code|code_verifier|api_key|apikey|githubToken|nextauthSecret|appEncryptionKey|gateToken";

const RULES: [RegExp, string][] = [
  // scheme://user:password@host -> scheme://user:<password>@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]*:)[^\s/?#@]+@/gi, "$1<password>@"],
  // Authorization: Bearer ..., "authorization":"Basic ..."
  [/(\bauthorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s,"'}]+/gi, "$1<redacted>"],
  // JWTs: three base64url parts, the first starting "eyJ" ({" in base64).
  [/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g, "<token>"],
  // GitHub tokens: classic (ghp_, gho_, ...) and fine-grained (github_pat_).
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "<github-token>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<github-token>"],
  // ?password=... &code=... in URLs.
  [new RegExp(`([?&](?:${SENSITIVE_KEYS})=)[^&\\s#"']*`, "gi"), "$1<redacted>"],
  // password=..., "token": "...", secret: ... in logs, JSON and settings text.
  [new RegExp(`(["']?\\b(?:${SENSITIVE_KEYS})\\b["']?\\s*[:=]\\s*["']?)(?!<)[^"'\\s,;&}]+`, "gi"), "$1<redacted>"],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "<email>"],
];

export function redact(text: string, options: RedactOptions): string {
  let out = text;

  // Longest first, so a secret that contains another is removed whole.
  const secrets = options.secrets
    .filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) out = out.split(secret).join("<secret>");

  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);

  if (options.home && options.home.length > 1) {
    const home = options.home.replace(/\/+$/, "");
    // Only a whole folder name: /home/sam must not turn /home/samantha into ~antha.
    out = out.replace(new RegExp(`${escapeRegExp(home)}(?=/|$|[\\s"'):,;\\]])`, "gm"), "~");
  }
  return out;
}
