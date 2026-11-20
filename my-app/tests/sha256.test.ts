/**
 * lib/ui/sha256.ts: the page's SHA-256 must match the server's node:crypto
 * hash byte for byte, or an approval never matches the run it covers. The
 * plain version is what a plain http address uses, so it is checked against
 * node:crypto directly, at the padding edges (55, 56, 63, 64 and 65 bytes),
 * on long text, and on text that is not ASCII.
 */
import { createHash } from "node:crypto";
import { sha256Hex, sha256HexSync } from "@/lib/ui/sha256";

function nodeHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const SAMPLES: Array<[string, string]> = [
  ["empty", ""],
  ["abc", "abc"],
  ["55 bytes", "a".repeat(55)],
  ["56 bytes", "a".repeat(56)],
  ["63 bytes", "a".repeat(63)],
  ["64 bytes", "a".repeat(64)],
  ["65 bytes", "a".repeat(65)],
  ["119 bytes", "b".repeat(119)],
  ["128 bytes", "c".repeat(128)],
  ["a run body", JSON.stringify([{ scriptName: "orders", version: "1.2.0", sqlContent: "ALTER TABLE public.orders ADD COLUMN note text;\n" }])],
  ["many kilobytes", "CREATE TABLE t (id int);\n".repeat(2000)],
  ["accents and CJK", "café, naïve, 日本語のテキスト"],
  ["outside the BMP", "emoji 😀🚀 and 𝔘𝔫𝔦𝔠𝔬𝔡𝔢"],
];

describe("sha256HexSync", () => {
  it("gives the published answers for the standard test strings", () => {
    expect(sha256HexSync("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256HexSync("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256HexSync("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
  });

  it.each(SAMPLES)("matches node:crypto for %s", (_label, text) => {
    expect(sha256HexSync(text)).toBe(nodeHash(text));
  });
});

describe("sha256Hex", () => {
  const scope = globalThis as unknown as { crypto: { subtle?: unknown } };
  let saved: PropertyDescriptor | undefined;

  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(scope.crypto, "subtle");
  });
  afterEach(() => {
    if (saved) Object.defineProperty(scope.crypto, "subtle", saved);
  });

  it("matches node:crypto through crypto.subtle", async () => {
    for (const [, text] of SAMPLES) expect(await sha256Hex(text)).toBe(nodeHash(text));
  });

  it("still answers on a page without crypto.subtle, as on plain http", async () => {
    Object.defineProperty(scope.crypto, "subtle", { value: undefined, configurable: true });
    for (const [, text] of SAMPLES) expect(await sha256Hex(text)).toBe(nodeHash(text));
  });

  it("falls back when crypto.subtle refuses", async () => {
    Object.defineProperty(scope.crypto, "subtle", {
      value: { digest: () => Promise.reject(new Error("not allowed")) },
      configurable: true,
    });
    expect(await sha256Hex("abc")).toBe(nodeHash("abc"));
  });
});
