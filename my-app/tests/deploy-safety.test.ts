import {
  environmentRank,
  isProduction,
  looksLikeProduction,
  louderEnvironment,
  productionBlockReason,
  toEnvironment,
} from "@/lib/environments";
import { cutForwardOnly, diffLedgers, entryKey, type LedgerEntry } from "@/lib/version-sync";
import { checkForwardOnly } from "@/lib/deploy-risk";
import { createHash } from "node:crypto";
import { fingerprintBody, rollbackFingerprintBody } from "@/lib/approval-fingerprint";
import { runFingerprint } from "@/lib/approvals-db";
import { ROLES, roleAtLeast, toRole } from "@/lib/auth-mode";
import { pendingPrefixThrough } from "@/lib/script-status";

// approvals-db reads the metadata database through lib/version-db, which
// pulls in Sequelize and the models. The parity cases below only hash, so a
// stand-in pool is enough. The path is relative on purpose: next/jest
// rewrites the @/ alias inside import statements only.
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: jest.fn() },
  syncMetadataTables: jest.fn(),
}));

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

/** One script_patch row as GET /api/versionsync/ledger sends it, with defaults. */
const entry = (over: Partial<LedgerEntry> & { version: string }): LedgerEntry => ({
  scriptName: "orders",
  changeType: "additive",
  appliedAt: "2026-01-01T00:00:00Z",
  hasSql: true,
  sqlContent: "SELECT 1;",
  downSql: null,
  ...over,
});

describe("diffLedgers", () => {
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
    // Two script groups, so the Target's own version says nothing about
    // whether the Source's version can still run.
    const diff = diffLedgers(
      [entry({ scriptName: "orders", version: "1.0.0" })],
      [entry({ scriptName: "customers", version: "9.9.9" })]
    );
    expect(diff.missing.map((e) => e.version)).toEqual(["1.0.0"]);
    expect(diff.diverged.map((e) => e.version)).toEqual(["9.9.9"]);
  });

  it("matches v1.2.0 in one ledger with 1.2.0 in the other", () => {
    // Matching the raw text listed a version the Target already had as
    // missing, and replaying it was refused as "already applied".
    const diff = diffLedgers([entry({ version: "v1.2.0" })], [entry({ version: "1.2.0" })]);
    expect(diff.upToDate).toBe(true);
    expect(diff.missing).toEqual([]);
    expect(diff.belowTarget).toEqual([]);
    expect(diff.diverged).toEqual([]);
  });

  it("lists a version at or below the Target's own apart, as below the Target", () => {
    // The Target runs orders 2.0.0, which the Source never had. The apply
    // route refuses anything at or below 2.0.0 in that group, so 1.5.0 can
    // not be replayed and must not be offered; 2.1.0 still can.
    const source = [
      entry({ version: "1.5.0" }),
      entry({ version: "2.1.0", appliedAt: "2026-02-01T00:00:00Z" }),
    ];
    const diff = diffLedgers(source, [entry({ version: "2.0.0" })]);
    expect(diff.belowTarget.map((e) => e.version)).toEqual(["1.5.0"]);
    expect(diff.missing.map((e) => e.version)).toEqual(["2.1.0"]);
    expect(diff.upToDate).toBe(false);
  });

  it("is up to date when everything the Target lacks is below its own version", () => {
    const diff = diffLedgers([entry({ version: "1.0.0" })], [entry({ version: "9.9.9" })]);
    expect(diff.upToDate).toBe(true);
    expect(diff.missing).toEqual([]);
    expect(diff.belowTarget.map((e) => e.version)).toEqual(["1.0.0"]);
    expect(diff.diverged.map((e) => e.version)).toEqual(["9.9.9"]);
  });

  it("judges each script group against that group's own head", () => {
    const source = [
      entry({ scriptName: "orders", version: "1.0.0" }),
      entry({ scriptName: "customers", version: "1.0.0" }),
    ];
    const diff = diffLedgers(source, [entry({ scriptName: "orders", version: "3.0.0" })]);
    expect(diff.belowTarget.map((e) => e.scriptName)).toEqual(["orders"]);
    expect(diff.missing.map((e) => e.scriptName)).toEqual(["customers"]);
  });

  it("lists a version once when the Source recorded two spellings of it", () => {
    // A run holding both would be refused as "listed twice".
    const source = [
      entry({ version: "v1.2.0" }),
      entry({ version: "1.2.0", appliedAt: "2026-02-01T00:00:00Z" }),
    ];
    expect(diffLedgers(source, []).missing.map((e) => e.version)).toEqual(["v1.2.0"]);
  });

  it("keys a plain version by its number and any other name as written", () => {
    expect(entryKey({ scriptName: "orders", version: "v1.2" })).toBe(
      entryKey({ scriptName: "orders", version: "1.2.0" })
    );
    expect(entryKey({ scriptName: "orders", version: "init" })).not.toBe(
      entryKey({ scriptName: "orders", version: "0.0.0" })
    );
    expect(entryKey({ scriptName: "orders", version: "1.0.0" })).not.toBe(
      entryKey({ scriptName: "customers", version: "1.0.0" })
    );
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

describe("cutForwardOnly", () => {
  const versions = (list: LedgerEntry[]) => list.map((e) => e.version);

  it("runs a list that only moves forward whole", () => {
    const cut = cutForwardOnly([entry({ version: "1.0.0" }), entry({ version: "1.1.0" })], []);
    expect(versions(cut.runnable)).toEqual(["1.0.0", "1.1.0"]);
    expect(cut.stoppedBefore).toBeNull();
    expect(cut.reason).toBeNull();
    expect(cut.blockedBy).toBeNull();
  });

  it("stops before the first version below one earlier in the run", () => {
    // The Source applied 1.2.0 and then 1.1.0. The route refuses the whole
    // run over 1.1.0, so the run is cut before it.
    const list = ["1.0.0", "1.2.0", "1.1.0", "1.3.0"].map((version) => entry({ version }));
    const cut = cutForwardOnly(list, []);
    expect(versions(cut.runnable)).toEqual(["1.0.0", "1.2.0"]);
    expect(cut.stoppedBefore?.version).toBe("1.1.0");
    expect(cut.reason).toBe("out-of-order");
    expect(cut.blockedBy).toBe("1.2.0");
  });

  it("starts each group from the Target's highest version", () => {
    const cut = cutForwardOnly(
      [entry({ version: "2.0.0" }), entry({ version: "3.0.0" })],
      [entry({ version: "v2.0.0" })]
    );
    expect(cut.runnable).toEqual([]);
    expect(cut.stoppedBefore?.version).toBe("2.0.0");
    expect(cut.blockedBy).toBe("v2.0.0");
  });

  it("judges two interleaved script groups separately", () => {
    const list = [
      entry({ scriptName: "orders", version: "2.0.0" }),
      entry({ scriptName: "customers", version: "1.0.0" }),
      entry({ scriptName: "orders", version: "2.1.0" }),
      entry({ scriptName: "customers", version: "1.1.0" }),
    ];
    const cut = cutForwardOnly(list, [entry({ scriptName: "customers", version: "0.9.0" })]);
    expect(cut.runnable).toHaveLength(4);
    expect(cut.stoppedBefore).toBeNull();
  });

  // RD1: the screen cuts a run with this rule and the apply route refuses one
  // with checkForwardOnly. Whatever the cut keeps, the route must accept, and
  // the entry it stops before must be exactly the one the route refuses.
  it.each([
    { name: "out of order in the run", run: ["1.0.0", "1.2.0", "1.1.0", "1.3.0"], applied: [] },
    { name: "at the Target's head", run: ["2.0.0", "3.0.0"], applied: ["v2.0.0"] },
    { name: "below the Target's head", run: ["1.5.0"], applied: ["2.0.0"] },
    { name: "one version spelled twice", run: ["1.0.0", "v1.0"], applied: [] },
    { name: "a name after a version", run: ["init", "1.0.0", "seed"], applied: [] },
    { name: "a non-version Target row", run: ["1.5.0", "1.6.0"], applied: ["init", "1.0.0"] },
    { name: "a clean run", run: ["1.1.0", "1.2.0"], applied: ["1.0.0"] },
  ])("agrees with the apply route: $name", ({ run, applied }) => {
    const list = run.map((version) => entry({ version }));
    const cut = cutForwardOnly(list, applied.map((version) => entry({ version })));
    const appliedByFamily = { orders: applied };

    expect(checkForwardOnly(cut.runnable, appliedByFamily)).toBeNull();
    if (cut.stoppedBefore === null) {
      expect(cut.runnable).toHaveLength(list.length);
    } else {
      const refused = checkForwardOnly([...cut.runnable, cut.stoppedBefore], appliedByFamily);
      expect(refused?.index).toBe(cut.runnable.length);
    }
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

  // The Deploy page pins its approval check and its rehearsal to the body of
  // the range selected ("Run v5.0.1 → v5.0.2 (2)…"). Two ranges of one family
  // sharing a body would let an approval or a rehearsal of the short range
  // clear the long one.
  it("gives each range of a family its own body, and one range one body", () => {
    const pending = [
      script("5.0.1", "CREATE TABLE a (id int);"),
      script("5.0.2", "ALTER TABLE a ADD COLUMN b int;"),
      script("6.0.0", "DROP TABLE a;"),
    ];
    const short = pendingPrefixThrough(pending, "5.0.2");
    const long = pendingPrefixThrough(pending, "6.0.0");
    expect(short.map((s) => s.version)).toEqual(["5.0.1", "5.0.2"]);
    expect(fingerprintBody(short)).not.toBe(fingerprintBody(long));
    // The same range, picked again from a list in another order, is the same body.
    expect(fingerprintBody(pendingPrefixThrough([...pending].reverse(), "5.0.2"))).toBe(
      fingerprintBody(short)
    );
  });
});

// The Deploy screen hashes fingerprintBody / rollbackFingerprintBody in the
// browser; the server hashes them in runFingerprint. The two must agree, or
// an approval asked for on the screen could never be spent by the route.
describe("runFingerprint parity", () => {
  const run = [
    { scriptName: "orders_fix", version: "3.0.0", sqlContent: "DROP TABLE t3;" },
    { scriptName: "orders_fix", version: "2.0.0", sqlContent: "DROP TABLE t2;" },
  ];
  const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

  it("hashes fingerprintBody for a deploy", () => {
    expect(runFingerprint(run, "deploy")).toBe(sha256(fingerprintBody(run)));
  });

  it("hashes rollbackFingerprintBody for a rollback", () => {
    expect(runFingerprint(run, "revert")).toBe(sha256(rollbackFingerprintBody(run)));
  });

  it("never gives a deploy and a rollback of the same scripts the same fingerprint", () => {
    expect(runFingerprint(run, "deploy")).not.toBe(runFingerprint(run, "revert"));
  });
});
