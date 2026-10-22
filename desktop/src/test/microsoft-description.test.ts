/**
 * Picking Microsoft's own words out of an error MSAL threw
 * (microsoftDescription in src/core/loopback.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { microsoftDescription } from "../core/loopback";

const DESCRIPTION =
  "AADSTS700082: The refresh token has expired due to inactivity.\r\nTrace ID: 0000\r\nCorrelation ID: 1111\r\nTimestamp: 2026-10-22 01:02:03Z";

test("finds Microsoft's description inside the message MSAL wraps around it", () => {
  const message = `Error(s): 700082 - Timestamp: 2026-10-22 01:02:03Z - Description: ${DESCRIPTION} - Correlation ID: 1111 - Trace ID: 0000`;
  assert.equal(microsoftDescription(message), DESCRIPTION);
});

test("gives back a description that MSAL did not wrap", () => {
  assert.equal(
    microsoftDescription("AADSTS50173: The provided grant has expired."),
    "AADSTS50173: The provided grant has expired.",
  );
});

test("gives nothing when Microsoft sent no description", () => {
  const empty =
    "Error(s): Not Available - Timestamp: Not Available - Description: Not Available - Correlation ID: Not Available - Trace ID: Not Available";
  assert.equal(microsoftDescription(empty), null);
  assert.equal(microsoftDescription("Not Available"), null);
  assert.equal(microsoftDescription(""), null);
});
