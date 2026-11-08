/**
 * Which connections stay on this computer without asking the website
 * (docs/two-way-sync-plan.md, rule 2).
 *
 * The website decides the rest by trying to reach the database (rule 3). This
 * check comes first and settles the plain cases: an address that only means
 * something on this computer or its own network (localhost, a home or office
 * address, a name with no dots) never goes to the website at all, so its
 * password never leaves the computer even for a test.
 *
 * Anything this cannot read stays home too. Keeping a connection here by
 * mistake costs one click on "Send to website"; sending a home password to a
 * website by mistake cannot be undone.
 */

/** What a connection names as its database's address. */
export type HomeCheck = { host?: unknown; connection_string?: unknown };

const HOME_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

/** The host a connection string names: libpq's ?host= wins over the address part. */
function hostOfConnectionString(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
  const asked = url.searchParams.get("host");
  if (asked !== null) return asked;
  try {
    return decodeURIComponent(url.hostname);
  } catch {
    return null;
  }
}

function normalise(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Four numbers 0 to 255, or null for anything else. */
function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return numbers.every((n) => n >= 0 && n <= 255) ? numbers : null;
}

function privateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function privateIpv6(host: string): boolean {
  if (host === "::1" || host === "::") return true;
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped) {
    const inner = ipv4(mapped[1]);
    // The hex spelling (::ffff:7f00:1) is read as private: it is rare, and staying home is the safe mistake.
    return inner === null || privateIpv4(inner);
  }
  return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}

/** True when this one host only means something on this computer or its own network. */
export function isHomeHost(raw: string): boolean {
  const host = normalise(raw);
  if (host === "" || host.startsWith("/") || host.startsWith("@")) return true;
  // libpq accepts a list of hosts. One home address among them keeps the whole connection home.
  if (host.includes(",")) return host.split(",").some((part) => isHomeHost(part));
  if (host.includes(":")) return privateIpv6(host);
  const v4 = ipv4(host);
  if (v4 !== null) return privateIpv4(v4);
  // A name made only of numbers and dots that is not an address is something no website can look up.
  if (/^[\d.]+$/.test(host)) return true;
  if (host === "localhost" || !host.includes(".")) return true;
  return HOME_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * True when this connection stays on this computer without asking the website:
 * its address only works here, or cannot be read. A connection string's
 * address wins over the host field, as it does when the app connects.
 */
export function staysHome(connection: HomeCheck): boolean {
  const text = typeof connection.connection_string === "string" ? connection.connection_string.trim() : "";
  if (text !== "") {
    const host = hostOfConnectionString(text);
    return host === null || isHomeHost(host);
  }
  return typeof connection.host !== "string" || isHomeHost(connection.host);
}
