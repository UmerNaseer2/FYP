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
 * Deliberately narrow: IPv4-mapped IPv6 and the bare 32-bit integer. The other
 * odd spellings (hex parts, a leading zero, fewer than four parts) are not
 * worked out here, because platforms disagree about what they mean. They are
 * refused outright instead: see isOddNumberSpelling below.
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
 * True for a host made only of numbers that is not written the ordinary way.
 *
 * "0x7f.0.0.1", "0177.0.0.1" and "127.1" are all this machine to a Linux
 * resolver, and "0xa9fe.0xa9fe" style spellings reach the cloud metadata
 * service. None of them starts with "127." or "169.254.", so the checks below
 * never saw them. Nobody types a database host this way by accident, so
 * rather than guess what each platform makes of one, the guard refuses them
 * all. Two spellings are ordinary and stay: four plain parts (203.0.113.5),
 * and one plain whole number, which toIPv4Literal works out.
 */
function isOddNumberSpelling(host: string): boolean {
  const parts = host.split(".");
  const onlyNumbers = parts.every((part) => /^(?:0x[0-9a-f]*|\d+)$/.test(part));
  if (!onlyNumbers) return false;

  const plainPart = (part: string) => /^(?:0|[1-9]\d*)$/.test(part);
  if (parts.length === 4) {
    return !parts.every((part) => plainPart(part) && Number(part) <= 255);
  }
  if (parts.length === 1) {
    return !(plainPart(host) && Number(host) <= 0xffffffff);
  }
  return true;
}

/**
 * The host as the checks below should read it: lower case, without the
 * brackets a URL puts around an IPv6 address, without the one trailing dot DNS
 * allows ("localhost." is localhost), and with an IPv6 address in its short
 * form, so that "0:0:0:0:0:0:0:1" is read as "::1".
 */
function readableHost(host: string | undefined): string {
  const raw = (host ?? "").trim().toLowerCase();
  const bare = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (bare.startsWith("/") || bare.startsWith("@")) return bare;
  const h = bare.endsWith(".") ? bare.slice(0, -1) : bare;
  if (!h.includes(":")) return h;
  try {
    // The URL parser writes every IPv6 address one way.
    return new URL(`http://[${h}]`).hostname.slice(1, -1);
  } catch {
    return h;
  }
}

/** 100.64.0.0 to 100.127.255.255: addresses shared inside a provider's own network. */
const SHARED_RANGE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

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
  // A connection string carries an IPv6 literal in brackets. The address is
  // what is being judged, not the punctuation a URL needed around it.
  const h = readableHost(host);

  if (isOddNumberSpelling(h)) {
    return {
      ok: false,
      message:
        "That host isn't allowed. Write it as a name, or as a plain address such as 203.0.113.5.",
    };
  }

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
      f === "fd00:ec2::254" || // the AWS metadata service over IPv6
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

  // The desktop app (desktop/ at the root of this repository) keeps its own
  // database on the same computer, reachable only through a private unix
  // socket where the operating system vouches for who is connecting. This
  // server runs as that same person, so a saved connection that named the
  // socket would be let straight into the app's own tables, the users and
  // their roles included. The databases people work on are always reached on
  // a port, so the desktop app refuses every socket spelling outright.
  if (process.env.SCHEMA_STUDIO_DESKTOP === "1" && isLocalMachine) {
    return {
      ok: false,
      message:
        "The desktop app connects to databases over the network only. Use localhost or 127.0.0.1 with the database's port.",
    };
  }

  const blockPrivate =
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PRIVATE_DB_HOSTS !== "true";
  if (blockPrivate) {
    if (isPrivateHost(host)) {
      return {
        ok: false,
        message: "Connections to internal/private hosts are disabled on this server.",
      };
    }
  }

  return { ok: true };
}

/**
 * True for an address only this machine or its own network can reach: this
 * machine itself (localhost, 127.x, ::1, a unix socket, no host at all) or a
 * private network (10.x, 192.168.x, 172.16 to 172.31, 100.64 to 100.127,
 * IPv6 addresses starting fc or fd, *.local, *.internal).
 *
 * The rule private hosts are blocked by above, and the guess the Connections
 * page starts from when it asks whether a new connection is local to this
 * machine (lib/local-secrets).
 */
export function isPrivateHost(host: string | undefined): boolean {
  const h = readableHost(host);
  if (h === "" || h.startsWith("/") || h.startsWith("@")) return true;
  const forms = [h];
  const normalised = toIPv4Literal(h);
  if (normalised !== null) forms.push(normalised);
  return forms.some(
    (f) =>
      f === "localhost" ||
      f.endsWith(".localhost") ||
      f.startsWith("127.") ||
      f === "::1" ||
      f.startsWith("10.") ||
      f.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(f) ||
      SHARED_RANGE.test(f) ||
      /^f[cd][0-9a-f]{2}:/.test(f) || // fc00::/7, IPv6's private range
      f.endsWith(".internal") ||
      f.endsWith(".local")
  );
}
