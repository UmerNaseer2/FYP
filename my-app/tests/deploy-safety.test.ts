import {
  environmentRank,
  isProduction,
  looksLikeProduction,
  louderEnvironment,
  productionBlockReason,
  toEnvironment,
} from "@/lib/environments";
import { diffLedgers, type LedgerEntry } from "@/lib/version-sync";
import { fingerprintBody } from "@/lib/approval-fingerprint";
import { ROLES, roleAtLeast, toRole } from "@/lib/auth-mode";

describe("environments", () => {
  it("only accepts the four labels it knows", () => {
    expect(toEnvironment("prod")).toBe("prod");
    expect(toEnvironment("  PROD  ")).toBe("prod");
    expect(toEnvironment(null)).toBe("unset");
    expect(toEnvironment("live")).toBe("unset");
  });

  it("ranks environments so the loudest of a pair wins", () => {
    expect(environmentRank("prod")).toBeGreaterThan(environmentRank("staging"));
    expect(louderEnvironment("dev", "prod")).toBe("prod");
    expect(louderEnvironment("unset", "dev")).toBe("dev");
  });

  it("blocks an unconfirmed production run and nothing else", () => {
    expect(productionBlockReason("prod", false)).toMatch(/production/i);
    expect(productionBlockReason("prod", true)).toBeNull();
    expect(productionBlockReason("dev", false)).toBeNull();
    expect(isProduction("prod")).toBe(true);
    expect(isProduction("staging")).toBe(false);
  });

  it("only suggests production from a whole word", () => {
    expect(looksLikeProduction("orders-production")).toBe(true);
    expect(looksLikeProduction("PROD cluster")).toBe(true);
    // "reproduction" is not a production database.
    expect(looksLikeProduction("reproduction-steps")).toBe(false);
  });
});

describe("roles", () => {
  it("is ordered viewer < editor < admin", () => {
    expect(ROLES).toEqual(["viewer", "editor", "admin"]);
    expect(roleAtLeast("admin", "editor")).toBe(true);
    expect(roleAtLeast("editor", "admin")).toBe(false);
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
  });

  it("falls back to the least privilege it can", () => {
    expect(toRole("admin")).toBe("admin");
    expect(toRole("superuser")).toBe("viewer");
    expect(toRole(undefined)).toBe("viewer");
  });
});

describe("diffLedgers", () => {
  const entry = (over: Partial<LedgerEntry> & { version: string }): LedgerEntry => ({
    scriptName: "orders",
    changeType: "additive",
    appliedAt: "2026-01-01T00:00:00Z",
    hasSql: true,
    sqlContent: "SELECT 1;",
    downSql: null,
    ...over,
  });

  it("reports nothing to do when the target already has everything", () => {
    const both = [entry({ version: "1.0.0" })];
    const diff = diffLedgers(both, both);
    expect(diff.upToDate).toBe(true);
    expect(diff.missing).toEqual([]);
    expect(diff.diverged).toEqual([]);
  });

  it("replays in the order the source applied them, not version order", () => {
    // v1.2.0 was applied first on the source, out of version order. Replaying
    // by version would run them in an order that never worked anywhere.
    const source = [
      entry({ version: "1.2.0", appliedAt: "2026-01-01T00:00:00Z" }),
      entry({ version: "1.1.0", appliedAt: "2026-02-01T00:00:00Z" }),
    ];
    const diff = diffLedgers(source, []);
    expect(diff.missing.map((e) => e.version)).toEqual(["1.2.0", "1.1.0"]);
  });

  it("surfaces target-only entries as diverged rather than merging them", () => {
    const diff = diffLedgers([entry({ version: "1.0.0" })], [entry({ version: "9.9.9" })]);
    expect(diff.missing.map((e) => e.version)).toEqual(["1.0.0"]);
    expect(diff.diverged.map((e) => e.version)).toEqual(["9.9.9"]);
  });

  it("counts the missing entries that cannot be replayed", () => {
    const diff = diffLedgers(
      [entry({ version: "1.0.0", hasSql: false, sqlContent: null }), entry({ version: "1.1.0" })],
      []
    );
    expect(diff.missing).toHaveLength(2);
    expect(diff.missingWithoutSql).toBe(1);
  });

  it("matches on script name as well as version", () => {
    const source = [entry({ scriptName: "orders", version: "1.0.0" })];
    const target = [entry({ scriptName: "customers", version: "1.0.0" })];
    const diff = diffLedgers(source, target);
    expect(diff.upToDate).toBe(false);
    expect(diff.missing).toHaveLength(1);
  });
});

/**
 * The approval fingerprint is what makes "approved" mean something. If two runs
 * that would leave different databases behind could hash the same, a second
 * person's name would end up on SQL they never read.
 */
describe("fingerprintBody", () => {
  const script = (version: string, sqlContent: string) => ({
    scriptName: "orders",
    version,
    sqlContent,
  });

  it("is stable for the same run", () => {
    const run = [script("1.0.0", "CREATE TABLE a (id int);")];
    expect(fingerprintBody(run)).toBe(fingerprintBody(run.slice()));
  });

  it("changes when any SQL changes", () => {
    expect(fingerprintBody([script("1.0.0", "CREATE TABLE a (id int);")])).not.toBe(
      fingerprintBody([script("1.0.0", "DROP TABLE a;")])
    );
  });

  it("changes when the version changes, even for identical SQL", () => {
    expect(fingerprintBody([script("1.0.0", "SELECT 1;")])).not.toBe(
      fingerprintBody([script("1.1.0", "SELECT 1;")])
    );
  });

  it("changes when the order changes", () => {
    const a = script("1.0.0", "CREATE TABLE a (id int);");
    const b = script("1.1.0", "DROP TABLE a;");
    expect(fingerprintBody([a, b])).not.toBe(fingerprintBody([b, a]));
  });

  it("cannot be made to collide by SQL that mimics the separator", () => {
    // Two migrations, versus one migration whose body contains the separator.
    const split = fingerprintBody([script("1.0.0", "SELECT 1;"), script("1.0.0", "SELECT 2;")]);
    const joined = fingerprintBody([
      script("1.0.0", "SELECT 1;\n6:orders5:1.0.09:SELECT 2;"),
    ]);
    expect(split).not.toBe(joined);
  });
});
