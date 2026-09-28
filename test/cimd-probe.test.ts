import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error scripts/ is plain .mjs with no declarations, deliberately: it
// runs in the live CI job with no npm ci and no build step.
import { PROBE_CLIENT_ID, PROBE_REDIRECT, probeDocumentProblem, registrationProblem } from "../scripts/cimd-probe-lib.mjs";

// verify-live gate 2 since registration was removed (design PR 4 of
// capsid/research/design-capsid-access-login.md): DCR is off, CIMD is on, and the probe
// client's metadata document is one the Worker accepts. The live half is the gate;
// these pin its decisions and the committed document.

const DOC = JSON.parse(readFileSync(join(import.meta.dirname, "..", "scripts", "verify-live-client.json"), "utf8"));
const METADATA = { issuer: "https://capsid.example", client_id_metadata_document_supported: true };

test("the committed probe document passes, at the URL GitHub serves it from", () => {
  assert.equal(PROBE_CLIENT_ID, "https://raw.githubusercontent.com/DrDustinEdwards/capsid/master/scripts/verify-live-client.json");
  assert.equal(probeDocumentProblem(DOC, PROBE_CLIENT_ID, PROBE_REDIRECT), null);
});

test("CIMD advertised, no registration endpoint and a 404 at /register passes", () => {
  assert.equal(registrationProblem(METADATA, 404), null);
});

for (const [name, metadata, status, pattern] of [
  ["a registration_endpoint in the metadata", { ...METADATA, registration_endpoint: "https://capsid.example/register" }, 404, /registration_endpoint/],
  ["a /register that registers", METADATA, 201, /answered 201; DCR is meant to be off/],
  ["CIMD not advertised", { issuer: "https://capsid.example" }, 404, /client_id_metadata_document_supported/],
  ["CIMD advertised false", { ...METADATA, client_id_metadata_document_supported: false }, 404, /client_id_metadata_document_supported/],
  ["a /register that answers something other than 404", METADATA, 500, /expected 404/],
  ["metadata that is not JSON", null, 404, /not a JSON object/],
] as const) {
  test(`gate 2 fails on ${name}`, () => {
    assert.match(String(registrationProblem(metadata, status)), pattern);
  });
}

for (const [name, change, pattern] of [
  ["a client_id that is not its own URL", { client_id: "https://example.com/other.json" }, /not its own URL/],
  ["no client_name", { client_name: " " }, /no client_name/],
  ["a missing redirect", { redirect_uris: ["https://example.com/elsewhere"] }, /does not list the redirect/],
  ["a client secret", { client_secret: "x" }, /client_secret/],
  ["a confidential auth method", { token_endpoint_auth_method: "client_secret_basic" }, /token_endpoint_auth_method/],
] as const) {
  test(`the probe document fails on ${name}`, () => {
    assert.match(String(probeDocumentProblem({ ...DOC, ...change }, PROBE_CLIENT_ID, PROBE_REDIRECT)), pattern);
  });
}
