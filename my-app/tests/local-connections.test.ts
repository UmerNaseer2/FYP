// Local connections (docs/cross-site-sync-plan.md): a connection only one
// machine can reach is listed in the shared database by name, with a marker
// where its password would be; the password itself stays in that machine's own
// store (lib/local-store).
//
// This covers the pieces that need no database: the marker, the "is this
// address local" guess, what the browser is told about a row, where an edit's
// saved secrets come from, how a marker becomes a driver config, and the rule
// that nobody may type a marker. Every value here is made up.
import type { Principal } from "@/lib/auth-guard";

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: async () => ({ rows: [] }) },
  syncMetadataTables: async () => undefined,
}));
jest.mock("../lib/lineage-db", () => ({ getConnectionDependents: async () => null }));

void (null as unknown as Principal);

import {
  cleanMachineName,
  LivesElsewhereError,
  makeLocalMarker,
  markerWithoutKey,
  parseLocalMarker,
  replaceLocalSecrets,
  resolveLocalMarker,
  typedLocalMarker,
  type LocalEntry,
} from "@/lib/local-secrets";
import { isPrivateHost } from "@/lib/host-guard";
import { publicRow, savedSecrets } from "@/lib/connection-writes";
import { buildPgConfig } from "@/lib/connection-config";
import { credentialsMessage, encryptSecret, UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";
import { validateConnection } from "@/lib/connection-validate";

const HERE = "Swinburne server";
const KEY = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const MARKER = `local:v1:${KEY}:${HERE}`;

const saved = process.env;
beforeEach(() => {
  process.env = { ...saved, LOCAL_DATABASE_URL: "postgres://made-up@127.0.0.1:1/none", LOCAL_MACHINE_NAME: HERE };
  replaceLocalSecrets(new Map<string, LocalEntry>([[KEY, { password: "made-up-local", connectionString: null }]]));
});
afterAll(() => {
  process.env = saved;
});

/** Forget the store, as if it had never been read. */
function unloaded() {
  (globalThis as { __schemaStudioLocalSecrets?: unknown }).__schemaStudioLocalSecrets = undefined;
}

describe("the marker", () => {
  it("names the key and the machine, and reads back the same", () => {
    expect(makeLocalMarker(KEY, `  ${HERE}\n`)).toBe(MARKER);
    expect(parseLocalMarker(MARKER)).toEqual({ key: KEY, machine: HERE });
    expect(parseLocalMarker("local:v1:abc:a:b")).toEqual({ key: "abc", machine: "a:b" });
  });

  it("is not a marker without the prefix or without a key", () => {
    expect(parseLocalMarker("made-up-password")).toBeNull();
    expect(parseLocalMarker("local:v1::Swinburne server")).toBeNull();
    expect(parseLocalMarker(null)).toBeNull();
  });

  it("refuses a key that could break the marker apart", () => {
    expect(() => makeLocalMarker("a:b", HERE)).toThrow(/letters, digits and dashes/);
    expect(() => makeLocalMarker("", HERE)).toThrow();
  });

  it("calls a machine with no name the server, and keeps a name to one short line", () => {
    expect(makeLocalMarker("k", "  ")).toBe("local:v1:k:the server");
    expect(cleanMachineName("Bea's\n\tlaptop   two")).toBe("Bea's laptop two");
    expect(cleanMachineName("x".repeat(80))).toHaveLength(60);
  });

  it("leaves this database without its key", () => {
    const shown = markerWithoutKey(MARKER);
    expect(shown).toBe(`local:v1:elsewhere:${HERE}`);
    expect(shown).not.toContain(KEY);
    expect(parseLocalMarker(shown)?.machine).toBe(HERE);
  });

  it("stays readable when saved, so the shared database can read the machine's name", () => {
    process.env.APP_ENCRYPTION_KEY = "c".repeat(64);
    expect(encryptSecret(MARKER)).toBe(MARKER);
  });
});

describe("nobody may type a marker", () => {
  it("spots one in anything typed, spaces first or not", () => {
    expect(typedLocalMarker("made-up", MARKER)).toBe(true);
    expect(typedLocalMarker(`  ${MARKER}`)).toBe(true);
    expect(typedLocalMarker("made-up", "", null, undefined, 5)).toBe(false);
    expect(typedLocalMarker("local:v2:x:y", "my local:v1: password")).toBe(false);
  });

  it("is a field error on the connection form", () => {
    const checked = validateConnection(
      { name: "Shop", host: "db.example.com", port: 5432, database_name: "shop", username: "app", password: MARKER },
      "create"
    );
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.errors.password).toMatch(/can't start with "local:v1:"/);
  });
});

describe("resolving a marker", () => {
  it("is nothing for a cloud connection's password", () => {
    expect(resolveLocalMarker("enc:made-up")).toBeNull();
    expect(resolveLocalMarker(null)).toBeNull();
  });

  it("gives this machine's entry when it holds one", () => {
    expect(resolveLocalMarker(MARKER)).toEqual({ password: "made-up-local", connectionString: null });
  });

  it("says where a connection lives when another machine holds it", () => {
    expect(() => resolveLocalMarker("local:v1:other-key:Bea's laptop")).toThrow(LivesElsewhereError);
    expect(() => resolveLocalMarker("local:v1:other-key:Bea's laptop")).toThrow(
      "This database lives on Bea's laptop. Open Schema Studio there to use it."
    );
  });

  it("on its own machine, says the store is not read yet, or the password is missing", () => {
    unloaded();
    expect(() => resolveLocalMarker("local:v1:other-key:Swinburne server")).toThrow(/could not be read yet/);
    replaceLocalSecrets(new Map());
    expect(() => resolveLocalMarker("local:v1:other-key:Swinburne server")).toThrow(/missing from Swinburne server/);
  });

  it("names the machine when a copy keeps no local passwords at all", () => {
    delete process.env.LOCAL_DATABASE_URL;
    expect(() => resolveLocalMarker("local:v1:other-key:Swinburne server")).toThrow(
      "This database lives on Swinburne server. Open Schema Studio there to use it."
    );
  });
});

describe("buildPgConfig with a local connection", () => {
  const row = { host: "localhost", port: 5432, database: "shop", user: "app", sslMode: "disable" as const };

  it("dials with this machine's password, not the marker", () => {
    const config = buildPgConfig({ ...row, password: MARKER, connectionString: null });
    expect(config.password).toBe("made-up-local");
    expect(config.host).toBe("localhost");
  });

  it("uses this machine's connection string when the connection has one", () => {
    replaceLocalSecrets(new Map([[KEY, { password: null, connectionString: "postgres://app:made-up@10.0.0.5:6000/inner" }]]));
    const config = buildPgConfig({ ...row, host: "", password: MARKER, connectionString: null });
    expect(config.host).toBe("10.0.0.5");
    expect(config.port).toBe(6000);
  });

  it("refuses with where it lives anywhere else", () => {
    let caught: unknown;
    try {
      buildPgConfig({ ...row, password: "local:v1:other-key:Bea's laptop", connectionString: null });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LivesElsewhereError);
    expect(credentialsMessage(caught)).toBe("This database lives on Bea's laptop. Open Schema Studio there to use it.");
    expect(credentialsMessage(new Error("bad key"))).toBe(UNREADABLE_CREDENTIALS_MESSAGE);
  });
});

describe("isPrivateHost", () => {
  it.each(["localhost", "db.localhost", "127.0.0.1", "::1", "[::1]", "10.1.2.3", "192.168.0.4", "172.16.0.1", "172.31.255.1", "db.local", "pg.internal", "", "/var/run/postgresql", "2130706433", " LOCALHOST "])(
    "counts %p as local",
    (host) => expect(isPrivateHost(host)).toBe(true)
  );

  it.each(["db.example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "ep-made-up.neon.tech"])("counts %p as cloud", (host) =>
    expect(isPrivateHost(host)).toBe(false)
  );

  it("counts no host at all as local", () => {
    expect(isPrivateHost(undefined)).toBe(true);
  });
});

describe("what the browser is told", () => {
  const base = { id: 3, name: "Shop", has_password: true, has_connection_string: false, lives_on: null };

  it("a cloud connection lives nowhere in particular", () => {
    expect(publicRow({ ...base, local_key: null })).toEqual({ ...base, lives_on: null, local_here: false });
  });

  it("a local connection held here can be tested and edited here, and never shows its key", () => {
    const row = publicRow({ ...base, has_password: false, lives_on: HERE, local_key: KEY });
    expect(row).toEqual({ ...base, lives_on: HERE, local_here: true, has_password: true, has_connection_string: false });
    expect(JSON.stringify(row)).not.toContain(KEY);
  });

  it("a local connection held elsewhere says where", () => {
    const row = publicRow({ ...base, has_password: false, lives_on: "Bea's laptop", local_key: "other-key" });
    expect(row).toEqual({ ...base, lives_on: "Bea's laptop", local_here: false, has_password: true, has_connection_string: false });
  });
});

describe("the secrets an edit starts from", () => {
  it("are a cloud connection's own columns", () => {
    expect(savedSecrets("enc:made-up", null)).toEqual({ ok: true, password: "enc:made-up", connectionString: "" });
  });

  it("come from this machine for a local connection held here", () => {
    expect(savedSecrets(MARKER, null)).toEqual({ ok: true, password: "made-up-local", connectionString: "" });
  });

  it("are blank on its own machine when the store lost them, so the password can be typed again", () => {
    replaceLocalSecrets(new Map());
    expect(savedSecrets(MARKER, null)).toEqual({ ok: true, password: "", connectionString: "" });
  });

  it("name the machine anywhere else", () => {
    expect(savedSecrets("local:v1:other-key:Bea's laptop", null)).toEqual({ ok: false, machine: "Bea's laptop" });
  });
});
