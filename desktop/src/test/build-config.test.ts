/**
 * The Microsoft Entra IDs a build signs in with (src/core/build-config.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildConfigFrom, isEntraId, parseBuildConfig, parseEnvFile } from "../core/build-config";

// Made up for the tests: the shape of an Entra ID, belonging to nothing.
const CLIENT = "11111111-2222-3333-4444-555555555555";
const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const NOT_SET = { clientId: null, tenantId: null };

test("an Entra ID is five groups of hexadecimal digits, in either case", () => {
  assert.equal(isEntraId(CLIENT), true);
  assert.equal(isEntraId(TENANT.toUpperCase()), true);
  for (const value of ["", "common", `{${CLIENT}}`, CLIENT.replace(/-/g, ""), `${CLIENT} `, "g".repeat(8) + CLIENT.slice(8), 5, null]) {
    assert.equal(isEntraId(value), false, String(value));
  }
});

test("reads KEY=VALUE lines, and skips comments, blank lines and anything else", () => {
  const text = [
    "# The two IDs",
    "",
    `AZURE_AD_CLIENT_ID=${CLIENT}`,
    `  export AZURE_AD_TENANT_ID = ${TENANT}  `,
    "not a setting",
    "EMPTY=",
  ].join("\r\n");
  assert.deepEqual(parseEnvFile(text), { AZURE_AD_CLIENT_ID: CLIENT, AZURE_AD_TENANT_ID: TENANT, EMPTY: "" });
});

test("takes the quotes off a quoted value, and a comment off an unquoted one", () => {
  assert.deepEqual(parseEnvFile(`A="${CLIENT}"\nB='${TENANT}'\nC=${CLIENT} # from the portal\nD="has # inside"`), {
    A: CLIENT,
    B: TENANT,
    C: CLIENT,
    D: "has # inside",
  });
});

test("the IDs from .env.desktop make a build that can sign in", () => {
  assert.deepEqual(buildConfigFrom({}, { AZURE_AD_CLIENT_ID: CLIENT, AZURE_AD_TENANT_ID: TENANT }), {
    config: { clientId: CLIENT, tenantId: TENANT },
    problems: [],
  });
});

test("a value in the environment wins over .env.desktop, and an empty one counts as not set", () => {
  const other = "99999999-8888-7777-6666-555555555555";
  const file = { AZURE_AD_CLIENT_ID: CLIENT, AZURE_AD_TENANT_ID: TENANT };
  assert.deepEqual(buildConfigFrom({ AZURE_AD_CLIENT_ID: other, AZURE_AD_TENANT_ID: " " }, file).config, {
    clientId: other,
    tenantId: TENANT,
  });
});

test("a build without the IDs is allowed: its sign-in is simply not set up", () => {
  assert.deepEqual(buildConfigFrom({}, {}), { config: NOT_SET, problems: [] });
  assert.deepEqual(buildConfigFrom({ AZURE_AD_CLIENT_ID: "" }, { AZURE_AD_TENANT_ID: "" }), {
    config: NOT_SET,
    problems: [],
  });
});

test("a value that is not an Entra ID stops the build, and says which one", () => {
  const { config, problems } = buildConfigFrom({ AZURE_AD_CLIENT_ID: "my-app", AZURE_AD_TENANT_ID: TENANT }, {});
  assert.deepEqual(config, NOT_SET);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^AZURE_AD_CLIENT_ID is not an Entra ID\./);
});

test("only one of the two IDs stops the build", () => {
  assert.deepEqual(buildConfigFrom({ AZURE_AD_TENANT_ID: TENANT }, {}), {
    config: NOT_SET,
    problems: ["Set both AZURE_AD_CLIENT_ID and AZURE_AD_TENANT_ID, or neither of them."],
  });
});

test("the IDs are kept in lower case, the way Microsoft writes them in sign-in tokens", () => {
  assert.deepEqual(
    buildConfigFrom({ AZURE_AD_CLIENT_ID: CLIENT, AZURE_AD_TENANT_ID: TENANT.toUpperCase() }, {}).config,
    { clientId: CLIENT, tenantId: TENANT },
  );
});

test("reads back the file the build wrote", () => {
  assert.deepEqual(parseBuildConfig({ clientId: CLIENT, tenantId: TENANT }), { clientId: CLIENT, tenantId: TENANT });
  assert.deepEqual(parseBuildConfig({ clientId: CLIENT.toUpperCase(), tenantId: TENANT }), {
    clientId: CLIENT,
    tenantId: TENANT,
  });
});

test("anything odd in that file means sign-in is not set up", () => {
  for (const value of [null, "text", [], {}, { clientId: CLIENT }, { clientId: CLIENT, tenantId: "common" }, NOT_SET]) {
    assert.deepEqual(parseBuildConfig(value), NOT_SET, JSON.stringify(value));
  }
});
