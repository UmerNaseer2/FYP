import { webcrypto } from "node:crypto";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

/**
 * The browser APIs jsdom does not have, stubbed once for every suite.
 *
 * jsdom implements the DOM but not a layout engine or a window manager, so a
 * handful of perfectly ordinary calls are simply missing rather than merely
 * inert — calling one throws "not a function" and fails a test for a reason
 * that has nothing to do with the code under test. Each stub below stands in
 * for something the app genuinely calls; nothing speculative is added, because
 * a stub for an API nobody uses is a claim about the app that no test checks.
 *
 * This file is not a test itself: Jest only runs tests/**\/*.test.ts(x).
 */

// setupFilesAfterEnv runs for EVERY suite, and most of them are `node` — where
// there is no DOM at all and nothing below would mean anything.
if (typeof window !== "undefined") {
  // Scrolling needs a viewport and boxes, neither of which exists here.
  // components/ui/Select keeps the highlighted option in view with it, so
  // opening any dropdown in a test hits this.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }

  // Media queries need a rendered window to measure. Returning a MediaQueryList
  // that never matches is the honest answer for a window with no size: it puts
  // every caller on its desktop / no-preference path, which is the one these
  // suites are written against.
  if (!window.matchMedia) {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        media: query,
        matches: false,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        // Deprecated, but StudioShell still supports the Safari versions that
        // only have these, so the stub has to answer them too.
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }

  // Text encoding and WebCrypto. Both are standard in every browser and in
  // Node itself; jsdom leaves them out because they live outside the DOM spec
  // it implements, so under this environment they are missing rather than
  // stubbed and a call throws "not a function". Node's own implementations are
  // the real ones, so what goes in here is not a fake: lib/approval-fingerprint
  // hashes a run with crypto.subtle (ApprovalPanel's sha256Hex), and a test
  // that could not hash could never show an approval matching a run at all.
  const scope = globalThis as unknown as Record<string, unknown>;
  if (typeof scope.TextEncoder === "undefined") scope.TextEncoder = NodeTextEncoder;
  if (typeof scope.TextDecoder === "undefined") scope.TextDecoder = NodeTextDecoder;
  if (typeof (scope.crypto as { subtle?: unknown } | undefined)?.subtle === "undefined") {
    // Only the missing half is filled in: jsdom's own crypto answers
    // getRandomValues and randomUUID, and replacing the whole object would
    // swap out working code to reach the one part that is absent.
    Object.defineProperty(scope.crypto ?? (scope.crypto = {}), "subtle", {
      value: webcrypto.subtle,
      configurable: true,
    });
  }
}

export {};
