import {
  isValidHost,
  parsePort,
  toSslMode,
  sslModeFromLegacyBoolean,
  sslModeUsesTls,
  validateConnection,
  summariseErrors,
  DEFAULT_SSL_MODE,
} from "@/lib/connection-validate";
import { parsePostgresUri } from "@/lib/parse-uri";
import { checkConnectableHost } from "@/lib/connection-config";
import {
  migrationFileName,
  rollbackFileName,
  parseRegistryFileName,
  groupRegistryFiles,
} from "@/lib/registry-paths";

/**
 * Connection validation and the registry naming rules.
 *
 * Both modules are shared by a browser form and a route handler, so a
 * disagreement between them is invisible until a row that saved cleanly turns
 * out to be unusable everywhere else. These tests pin the shared answer.
 */

describe("isValidHost", () => {
  it("accepts the hostname shapes people actually type", () => {
    expect(isValidHost("localhost")).toBe(true);
    expect(isValidHost("db.internal")).toBe(true);
    expect(isValidHost("my-postgres-1")).toBe(true);
    expect(isValidHost("ep-cool-name.eu-central-1.aws.neon.tech")).toBe(true);
  });

  it("accepts IP literals", () => {
    expect(isValidHost("127.0.0.1")).toBe(true);
    expect(isValidHost("10.0.0.255")).toBe(true);
    expect(isValidHost("::1")).toBe(true);
    expect(isValidHost("[2001:db8::1]")).toBe(true);
  });

  it("rejects a field that was filled in with something else", () => {
    // Each of these saved cleanly before the shared validator existed.
    expect(isValidHost("postgres://user@host/db")).toBe(false);
    expect(isValidHost("host:5432")).toBe(false);
    expect(isValidHost("user@host")).toBe(false);
    expect(isValidHost("two words")).toBe(false);
    expect(isValidHost("")).toBe(false);
  });

  it("holds an all-numeric host to the IPv4 standard", () => {
    // Without this, HOSTNAME_RE would wave through a typo as if it were a name.
    expect(isValidHost("999.1.1.1")).toBe(false);
    expect(isValidHost("10.0.0")).toBe(false);
  });
});

describe("parsePort", () => {
  it("reads a whole number in range", () => {
    expect(parsePort(5432)).toBe(5432);
    expect(parsePort("5432")).toBe(5432);
    expect(parsePort(1)).toBe(1);
    expect(parsePort(65535)).toBe(65535);
  });

  it("returns null for absent, so the caller can default it", () => {
    expect(parsePort(null)).toBeNull();
    expect(parsePort(undefined)).toBeNull();
    expect(parsePort("   ")).toBeNull();
  });

  it("returns null for out of range and non-integers", () => {
    expect(parsePort(0)).toBeNull();
    expect(parsePort(-1)).toBeNull();
    expect(parsePort(99999)).toBeNull();
    expect(parsePort("5432.5")).toBeNull();
    expect(parsePort("abc")).toBeNull();
  });
});

describe("ssl mode", () => {
  it("narrows anything unknown to the default", () => {
    expect(toSslMode("require")).toBe("require");
    expect(toSslMode("VERIFY-FULL")).toBe("verify-full");
    expect(toSslMode("prefer")).toBe(DEFAULT_SSL_MODE);
    expect(toSslMode(undefined)).toBe(DEFAULT_SSL_MODE);
  });

  it("reads the legacy boolean column the way it was written", () => {
    expect(sslModeFromLegacyBoolean(true)).toBe("require");
    expect(sslModeFromLegacyBoolean(false)).toBe("disable");
  });

  it("knows which modes negotiate TLS", () => {
    expect(sslModeUsesTls("disable")).toBe(false);
    expect(sslModeUsesTls("require")).toBe(true);
    expect(sslModeUsesTls("verify-full")).toBe(true);
  });
});

describe("validateConnection — field form", () => {
  const good = {
    name: "Dev box",
    host: "localhost",
    port: 5432,
    database_name: "appdb",
    type: "PostgreSQL",
    username: "postgres",
    password: "secret",
  };

  it("normalises a complete draft", () => {
    const result = validateConnection(good);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.port).toBe(5432);
    expect(result.value.ssl_mode).toBe("disable");
    expect(result.value.environment).toBe("unset");
  });

  it("defaults an omitted port to 5432 rather than rejecting", () => {
    const result = validateConnection({ ...good, port: undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.port).toBe(5432);
  });

  it("rejects a port that was given but is out of range", () => {
    const result = validateConnection({ ...good, port: 99999 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.port).toBeTruthy();
  });

  it("rejects an engine the rest of the app cannot use", () => {
    // MySQL used to save cleanly and then be filtered out of every screen.
    const result = validateConnection({ ...good, type: "MySQL" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.type).toBeTruthy();
  });

  it("requires a password on create but not on edit", () => {
    const created = validateConnection({ ...good, password: "" }, "create");
    expect(created.ok).toBe(false);
    // On edit a blank password means "keep the stored one".
    const edited = validateConnection({ ...good, password: "" }, "edit");
    expect(edited.ok).toBe(true);
  });

  it("refuses to narrow an unrecognised environment silently", () => {
    // "production" stored as "unset" would be the LOWEST rank, so the user
    // would believe they had labelled a live database and never be warned.
    const result = validateConnection({ ...good, environment: "production" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.environment).toContain("production");
  });

  it("accepts a real environment", () => {
    const result = validateConnection({ ...good, environment: "prod" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.environment).toBe("prod");
  });

  it("names every missing field at once", () => {
    const result = validateConnection({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(
      ["database_name", "host", "name", "password", "username"].sort()
    );
  });
});

describe("validateConnection — connection string form", () => {
  const base = { name: "Neon", type: "PostgreSQL" };

  it("fills host, port, database and user from the URI", () => {
    const result = validateConnection({
      ...base,
      connection_string: "postgres://alice:pw@db.example.com:6543/shop",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.host).toBe("db.example.com");
    expect(result.value.port).toBe(6543);
    expect(result.value.database_name).toBe("shop");
    expect(result.value.username).toBe("alice");
  });

  it("does not require the field-form inputs when a URI is given", () => {
    const result = validateConnection({
      ...base,
      connection_string: "postgres://alice:pw@db.example.com/shop",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.port).toBe(5432);
  });

  it("names the port as the cause when the URI's port is out of range", () => {
    // The URL parser rejects it outright, which would otherwise surface as a
    // vague "doesn't parse".
    const result = validateConnection({
      ...base,
      connection_string: "postgres://alice:pw@db.example.com:99999/shop",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.connection_string).toContain("port");
  });

  it("rejects a string that is not a URI at all", () => {
    const result = validateConnection({ ...base, connection_string: "just some text" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.connection_string).toContain("postgres://");
  });

  it("rejects a connection string longer than the column", () => {
    const result = validateConnection({
      ...base,
      connection_string: "postgres://u:p@h/" + "d".repeat(3000),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.connection_string).toBeTruthy();
  });

  it("never writes the missing-part sentinel to a column", () => {
    // parsePostgresUri reports an absent part as an em dash for the live
    // preview; that must not reach the database.
    const result = validateConnection({
      ...base,
      host: "fallback.example.com",
      database_name: "fallbackdb",
      username: "fallback",
      password: "pw",
      connection_string: "postgres://db.example.com/",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.database_name).toBe("fallbackdb");
    expect(result.value.username).toBe("fallback");
  });
});

describe("summariseErrors", () => {
  it("joins the messages into one sentence", () => {
    expect(summariseErrors({ name: "Give this connection a name.", host: "Enter a host." }))
      .toBe("Give this connection a name. Enter a host.");
  });

  it("is empty when there is nothing wrong", () => {
    expect(summariseErrors({})).toBe("");
  });
});

describe("parsePostgresUri", () => {
  it("reads the visible parts and never the password", () => {
    const parsed = parsePostgresUri("postgresql://bob:hunter2@host:5433/db?sslmode=require");
    expect(parsed).not.toBeNull();
    expect(parsed!.host).toBe("host");
    expect(parsed!.port).toBe("5433");
    expect(parsed!.database).toBe("db");
    expect(parsed!.user).toBe("bob");
    expect(parsed!.sslmode).toBe("require");
    expect(JSON.stringify(parsed)).not.toContain("hunter2");
  });

  it("decodes a percent-escaped user and database", () => {
    const parsed = parsePostgresUri("postgres://a%40b@host/my%20db");
    expect(parsed!.user).toBe("a@b");
    expect(parsed!.database).toBe("my db");
  });

  it("returns null rather than throwing on junk", () => {
    expect(parsePostgresUri("")).toBeNull();
    expect(parsePostgresUri("not a uri at all")).toBeNull();
  });
});

describe("registry file names", () => {
  it("round-trips a migration name", () => {
    expect(migrationFileName("1.2.0")).toBe("v1.2.0.sql");
    expect(parseRegistryFileName("v1.2.0.sql")).toEqual({ version: "1.2.0", isDown: false });
  });

  it("reads a rollback as the same version, not a release of its own", () => {
    // The bug this module exists to prevent: "1.2.0.down" listed as a version.
    expect(rollbackFileName("1.2.0")).toBe("v1.2.0.down.sql");
    expect(parseRegistryFileName("v1.2.0.down.sql")).toEqual({
      version: "1.2.0",
      isDown: true,
    });
  });

  it("skips files that are not .sql", () => {
    expect(parseRegistryFileName("README.md")).toBeNull();
    expect(parseRegistryFileName("notes.txt")).toBeNull();
  });

  it("pairs each migration with its rollback", () => {
    const grouped = groupRegistryFiles([
      { name: "v1.0.0.sql" },
      { name: "v1.0.0.down.sql" },
      { name: "v1.1.0.sql" },
      { name: "README.md" },
    ]);
    expect(grouped.size).toBe(2);
    expect(grouped.get("1.0.0")!.up!.name).toBe("v1.0.0.sql");
    expect(grouped.get("1.0.0")!.down!.name).toBe("v1.0.0.down.sql");
    expect(grouped.get("1.1.0")!.down).toBeUndefined();
  });

  it("still returns a rollback with no migration beside it", () => {
    // The caller decides what an orphan means; the pull route drops it.
    const grouped = groupRegistryFiles([{ name: "v2.0.0.down.sql" }]);
    expect(grouped.get("2.0.0")!.up).toBeUndefined();
    expect(grouped.get("2.0.0")!.down!.name).toBe("v2.0.0.down.sql");
  });
});

describe("checkConnectableHost", () => {
  /**
   * These run with NODE_ENV set to whatever Jest sets it to, which is "test" —
   * so only the ALWAYS-blocked list applies here. The private-range half of the
   * guard is production-only by design, and setting NODE_ENV inside a test
   * would be testing the harness rather than the rule.
   */
  it("blocks the cloud metadata service by name and by address", () => {
    expect(checkConnectableHost("metadata.google.internal").ok).toBe(false);
    expect(checkConnectableHost("169.254.169.254").ok).toBe(false);
  });

  it("blocks the metadata address written as a bare 32-bit number", () => {
    // 2852039166 is 169.254.169.254. Every C resolver accepts this spelling,
    // and a check that compares strings would never have seen it coming.
    expect(checkConnectableHost("2852039166").ok).toBe(false);
  });

  it("blocks the wildcard address however it is written", () => {
    expect(checkConnectableHost("0.0.0.0").ok).toBe(false);
    expect(checkConnectableHost("::").ok).toBe(false);
    expect(checkConnectableHost("0").ok).toBe(false);
    expect(checkConnectableHost("::ffff:0.0.0.0").ok).toBe(false);
  });

  it("sees through the brackets a connection string puts round an IPv6 literal", () => {
    expect(checkConnectableHost("[fe80::1]").ok).toBe(false);
  });

  it("lets an ordinary database host through", () => {
    expect(checkConnectableHost("ep-cool-name.eu-central-1.aws.neon.tech").ok).toBe(true);
    expect(checkConnectableHost("db.example.com").ok).toBe(true);
    expect(checkConnectableHost("203.0.113.10").ok).toBe(true);
  });

  /**
   * The private-range half only runs in production, so these swap NODE_ENV for
   * the length of one call. It is the branch that matters most — a deployed
   * server is exactly where reaching its own loopback would be a hole.
   */
  function inProduction<T>(run: () => T): T {
    const before = process.env.NODE_ENV;
    Object.defineProperty(process.env, "NODE_ENV", { value: "production", configurable: true });
    try {
      return run();
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", { value: before, configurable: true });
    }
  }

  it("blocks loopback in production however it is spelled", () => {
    inProduction(() => {
      expect(checkConnectableHost("127.0.0.1").ok).toBe(false);
      expect(checkConnectableHost("localhost").ok).toBe(false);
      expect(checkConnectableHost("::1").ok).toBe(false);
      // The three spellings that used to walk straight through.
      expect(checkConnectableHost("::ffff:127.0.0.1").ok).toBe(false);
      expect(checkConnectableHost("::ffff:7f00:1").ok).toBe(false);
      expect(checkConnectableHost("2130706433").ok).toBe(false);
    });
  });

  it("blocks a private range written as mapped IPv6 in production", () => {
    inProduction(() => {
      expect(checkConnectableHost("::ffff:10.1.2.3").ok).toBe(false);
      expect(checkConnectableHost("::ffff:192.168.0.9").ok).toBe(false);
    });
  });

  it("still allows a public host in production", () => {
    inProduction(() => {
      expect(checkConnectableHost("db.example.com").ok).toBe(true);
      expect(checkConnectableHost("203.0.113.10").ok).toBe(true);
    });
  });

  it("does not read a per-octet octal address as loopback", () => {
    // Platforms disagree about "0177.0.0.1" — macOS resolves it to the public
    // 177.0.0.1 — so normalising it would block a reachable host on a guess.
    expect(checkConnectableHost("0177.0.0.1").ok).toBe(true);
  });
});
