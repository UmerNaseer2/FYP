// Where this server is willing to open a socket.
//
// The host rule used to run in one place — "Test connection" — and to judge the
// hostname written in the URL. Neither is where the driver actually goes:
//
//   postgres://user:pw@db.example.com/app?host=169.254.169.254
//
// parses as a database on the internet, and dials the cloud metadata service,
// because pg-connection-string lets a query parameter win over the URL. And
// Compare, Deploy and Drift never go through Test at all, so a row saved once
// was dialled freely afterwards.
//
// The rule now runs on the host pg resolves, in two places: when a connection
// is saved, and again inside getPoolForConfig before any pool is built. Nothing
// here reaches a real database — the pg module is a stand-in that fails the
// test if it is ever constructed.
import { BlockedHostError, checkConnectableHost } from "@/lib/host-guard";
import { checkConnectionTarget, describeDbError } from "@/lib/connection-config";
import { fetchSchemaNames, getPoolForConfig } from "@/lib/postgres";

/** Every real pool this file's code builds, so the tests can say "none". */
const mockPoolsBuilt: unknown[] = [];
jest.mock("pg", () => ({
  Pool: jest.fn((config: unknown) => {
    mockPoolsBuilt.push(config);
    return { on: jest.fn(), connect: jest.fn(), query: jest.fn(), end: jest.fn() };
  }),
}));

const BLOCKED = "That host isn't allowed.";
const PRIVATE = "Connections to internal/private hosts are disabled on this server.";

/**
 * Run one call with different environment values, then put them back.
 *
 * NODE_ENV is "test" under Jest and the private-host half of the rule is
 * production-only, so that half can only be exercised from inside here.
 */
function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const before: Record<string, string | undefined> = {};
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else Object.defineProperty(process.env, key, { value, configurable: true, enumerable: true });
  };
  for (const [key, value] of Object.entries(vars)) {
    before[key] = process.env[key];
    set(key, value);
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(before)) set(key, value);
  }
}

const inProduction = <T,>(run: () => T) => withEnv({ NODE_ENV: "production" }, run);

describe("checkConnectableHost — the app server's own machine", () => {
  /**
   * libpq spells "this machine" three ways: a unix socket directory, an
   * abstract socket, and no host at all (pg then falls back to PGHOST, or to
   * the local socket when even that is unset). None of them start with "127.",
   * so all three used to walk past a rule aimed at loopback.
   */
  it("treats a unix socket, an abstract socket and no host as this machine", () => {
    inProduction(() => {
      expect(checkConnectableHost("/var/run/postgresql")).toEqual({ ok: false, message: PRIVATE });
      expect(checkConnectableHost("/tmp")).toEqual({ ok: false, message: PRIVATE });
      expect(checkConnectableHost("@abstract-socket")).toEqual({ ok: false, message: PRIVATE });
      expect(checkConnectableHost("")).toEqual({ ok: false, message: PRIVATE });
      expect(checkConnectableHost(undefined)).toEqual({ ok: false, message: PRIVATE });
    });
  });

  it("still allows them in development, like any other local database", () => {
    // Running the app against a Postgres on the same machine is the normal way
    // to develop it, and a socket is how the official installers connect.
    expect(checkConnectableHost("/var/run/postgresql").ok).toBe(true);
    expect(checkConnectableHost("").ok).toBe(true);
  });

  it("allows them in production when the deployment opts in", () => {
    withEnv({ NODE_ENV: "production", ALLOW_PRIVATE_DB_HOSTS: "true" }, () => {
      expect(checkConnectableHost("/var/run/postgresql").ok).toBe(true);
      expect(checkConnectableHost("localhost").ok).toBe(true);
    });
  });
});

describe("checkConnectionTarget — the host pg will really dial", () => {
  it("sees the host a query parameter puts behind an innocent hostname", () => {
    // The whole point of this fix. The URL says db.example.com; pg dials the
    // metadata service.
    expect(
      checkConnectionTarget({
        connectionString: "postgres://app:pw@db.example.com/app?host=169.254.169.254",
      })
    ).toEqual({ ok: false, message: BLOCKED });
  });

  it("lets an ordinary connection string through", () => {
    expect(
      checkConnectionTarget({ connectionString: "postgres://app:pw@db.example.com:5432/app" }).ok
    ).toBe(true);
  });

  it("judges a URI that names no host as this machine", () => {
    // "postgres://user:pw@/app" — pg falls back to PGHOST or the local socket.
    const input = { connectionString: "postgres://app:pw@/app" };
    expect(checkConnectionTarget(input).ok).toBe(true); // development
    inProduction(() => {
      expect(checkConnectionTarget(input)).toEqual({ ok: false, message: PRIVATE });
    });
  });

  it("judges a socket asked for by query parameter", () => {
    const input = {
      connectionString: "postgres://app:pw@db.example.com/app?host=/var/run/postgresql",
    };
    inProduction(() => {
      expect(checkConnectionTarget(input)).toEqual({ ok: false, message: PRIVATE });
    });
  });

  it("still judges the loose fields when there is no connection string", () => {
    expect(
      checkConnectionTarget({ host: "169.254.169.254", port: 5432, database: "app", user: "app" })
    ).toEqual({ ok: false, message: BLOCKED });
    expect(checkConnectionTarget({ host: "db.example.com", port: 5432 }).ok).toBe(true);
  });

  it("says yes when there is nothing it can resolve", () => {
    // A stored secret this server cannot decrypt. There is no host to judge,
    // and refusing the save would strand a row nobody could even rename — so
    // this one is left to getPoolForConfig, which checks again before dialling.
    expect(checkConnectionTarget({ connectionString: "enc:v1:not-really-ciphertext" }).ok).toBe(
      true
    );
  });
});

describe("getPoolForConfig — a blocked host never reaches the driver", () => {
  beforeEach(() => {
    mockPoolsBuilt.length = 0;
  });

  it("builds no pool at all, and says why when something tries to use it", async () => {
    const pool = getPoolForConfig({ host: "169.254.169.254", port: 5432, database: "app" });
    expect(mockPoolsBuilt).toHaveLength(0);

    await expect(pool.connect()).rejects.toThrow(BlockedHostError);
    await expect(pool.query("SELECT 1")).rejects.toThrow(BLOCKED);
    // Callers close pools in a `finally`; that must not itself throw.
    await expect(pool.end()).resolves.toBeUndefined();
    // getPoolForConfig chains an idle-error listener onto a real pool.
    expect(pool.on("error", () => {})).toBe(pool);
  });

  it("turns the refusal into the message the screen shows", async () => {
    // fetchSchemaNames reports whatever the failure said, so the reason travels
    // to the Compare screen without a single route change.
    const result = await fetchSchemaNames({ host: "metadata.google.internal", database: "app" });
    expect(result).toEqual({ ok: false, error: BLOCKED });
    expect(mockPoolsBuilt).toHaveLength(0);
  });

  it("opens a pool for a host it is willing to dial", async () => {
    getPoolForConfig({ host: "db.example.com", port: 5432, database: "app" });
    expect(mockPoolsBuilt).toHaveLength(1);
  });
});

describe("describeDbError — a refusal is not a connection problem", () => {
  it("passes the refusal through instead of blaming the connection details", () => {
    // It never reached the network, so "check the host and port" would send the
    // reader looking for a fault in a connection that is fine.
    expect(describeDbError(new BlockedHostError(BLOCKED))).toEqual({
      message: BLOCKED,
      sslRequired: false,
      detail: BLOCKED,
    });
  });
});
