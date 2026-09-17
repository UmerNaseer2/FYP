/**
 * Which hosts this server is willing to dial.
 *
 * The app opens a socket to whatever host a saved connection names, so without
 * a rule it is a server-side request forgery (SSRF) tool: name the cloud
 * metadata service and the app fetches it for you, name 10.0.0.1:5432 and the
 * app tells you whether something answers.
 *
 *   - Cloud metadata + link-local addresses are blocked ALWAYS — they are never
 *     a real database and are the classic SSRF target.
 *   - Loopback, unix sockets and the RFC1918 private ranges are blocked in
 *     PRODUCTION only (so local development against a localhost Postgres still
 *     works). Set ALLOW_PRIVATE_DB_HOSTS=true to opt back in on a trusted/VPC
 *     deployment.
 *
 * This lives in its own small module, apart from lib/connection-config, so that
 * lib/postgres can check a host before it opens a pool without dragging the
 * whole connection/credential layer in with it. connection-config re-exports
 * both names, so existing callers import from either.
 */

/** A host this server refuses to dial. Thrown where a connection would open. */
export class BlockedHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedHostError";
  }
}

/** A 32-bit address written back as a dotted quad. */
function dottedQuad(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(
    "."
  );
}

/**
 * The IPv4 address a host literal really names, or null when it names none.
 *
 * A blocklist that compares strings only blocks the spellings it was shown.
 * `::ffff:127.0.0.1` and `2130706433` are both loopback to every resolver there
 * is, and neither of them starts with "127.", so both walked straight past the
 * check below. Normalising first is what makes that check about the address
 * rather than about how somebody chose to type it.
 *
 * Deliberately narrow — IPv4-mapped IPv6 and the bare 32-bit integer. Per-octet
 * octal ("0177.0.0.1") is left alone on purpose: platforms disagree about what
 * it means, macOS resolves it to the public 177.0.0.1, and guessing wrong would
 * block a host that is genuinely reachable.
 */
function toIPv4Literal(host: string): string | null {
  // ::ffff:127.0.0.1 and ::127.0.0.1 — the dotted tail is the address.
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) return mapped[1];

  // ::ffff:7f00:1 — the same address written as two hex groups.
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hex) {
    return dottedQuad(((parseInt(hex[1], 16) << 16) + parseInt(hex[2], 16)) >>> 0);
  }

  // A bare 32-bit number: 2130706433 is 127.0.0.1, 2852039166 is the metadata
  // service. Every C resolver accepts this form.
  if (/^\d+$/.test(host)) {
    const value = Number(host);
    if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
      return dottedQuad(value);
    }
  }

  return null;
}

/**
 * Judge one host literal.
 *
 * Note: this checks the literal host only; a public hostname that resolves to an
 * internal IP (DNS rebinding) is not caught here. The real long-term fix is
 * server-side authentication on these routes.
 */
export function checkConnectableHost(
  host: string | undefined
): { ok: true } | { ok: false; message: string } {
  const raw = (host ?? "").trim().toLowerCase();
  // A connection string carries an IPv6 literal in brackets. The address is
  // what is being judged, not the punctuation a URL needed around it.
  const h = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;

  // Every spelling of the same address has to get the same answer, so both the
  // literal and its normalised form are tested.
  const forms = [h];
  const normalised = toIPv4Literal(h);
  if (normalised !== null) forms.push(normalised);

  const alwaysBlocked = forms.some(
    (f) =>
      f === "metadata.google.internal" ||
      f.startsWith("169.254.") || // IPv4 link-local, incl. 169.254.169.254 metadata
      f.startsWith("fe80:") || // IPv6 link-local
      f === "::" ||
      f === "0.0.0.0"
  );
  if (alwaysBlocked) {
    return { ok: false, message: "That host isn't allowed." };
  }

  // The app server's own machine, spelled the way libpq spells it. A host that
  // starts with "/" is a unix socket directory (Linux also accepts "@" for an
  // abstract socket), and no host at all means the same thing — pg falls back
  // to PGHOST, or to the local socket when even that is unset. A connection
  // string can ask for either: "?host=/var/run/postgresql", or
  // "postgres://user:pw@/app" with the host left out. Both reach this machine,
  // so they are judged with localhost rather than let through as "not 127.".
  const isLocalMachine = h === "" || h.startsWith("/") || h.startsWith("@");

  const blockPrivate =
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PRIVATE_DB_HOSTS !== "true";
  if (blockPrivate) {
    const isPrivate =
      isLocalMachine ||
      forms.some(
        (f) =>
          f === "localhost" ||
          f.endsWith(".localhost") ||
          f.startsWith("127.") ||
          f === "::1" ||
          f.startsWith("10.") ||
          f.startsWith("192.168.") ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(f) ||
          f.endsWith(".internal") ||
          f.endsWith(".local")
      );
    if (isPrivate) {
      return {
        ok: false,
        message: "Connections to internal/private hosts are disabled on this server.",
      };
    }
  }

  return { ok: true };
}
