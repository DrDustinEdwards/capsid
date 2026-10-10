import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error scripts/ is plain .mjs with no declarations, deliberately: it
// runs in the live CI job with no npm ci and no build step.
import { PROBE_CLIENT_ID, PROBE_REDIRECT, probeDocumentProblem, registrationProblem } from "../scripts/cimd-probe-lib.mjs";

// verify-live gate 2 (scripts/cimd-probe-lib.mjs): CIMD is on, tightened DCR refuses a
// registration naming the probe's unlisted redirect (src/dcr.ts), and the probe client's
// metadata document is one the Worker accepts. The live half is the gate; these pin its
// decisions and the committed document.

const DOC = JSON.parse(readFileSync(join(import.meta.dirname, "..", "scripts", "verify-live-client.json"), "utf8"));
const ORIGIN = "https://capsid.example";
const METADATA = { issuer: ORIGIN, client_id_metadata_document_supported: true, registration_endpoint: `${ORIGIN}/register` };
const REFUSED = { error: "invalid_redirect_uri" };

test("the committed probe document passes, at the URL GitHub serves it from", () => {
  assert.equal(PROBE_CLIENT_ID, "https://raw.githubusercontent.com/DrDustinEdwards/capsid/master/scripts/verify-live-client.json");
  assert.equal(probeDocumentProblem(DOC, PROBE_CLIENT_ID, PROBE_REDIRECT), null);
});

test("CIMD advertised, the registration endpoint on this origin, and the probe's redirect refused passes", () => {
  assert.equal(registrationProblem(METADATA, ORIGIN, 400, REFUSED), null);
});

for (const [name, metadata, status, body, pattern] of [
  ["no registration_endpoint", { issuer: ORIGIN, client_id_metadata_document_supported: true }, 400, REFUSED, /expected https:\/\/capsid.example\/register/],
  ["a registration_endpoint elsewhere", { ...METADATA, registration_endpoint: "https://elsewhere.example/register" }, 400, REFUSED, /registration_endpoint/],
  ["a /register that registers the unlisted redirect", METADATA, 201, {}, /answered 201 for an unlisted redirect; the DCR allowlist is open/],
  ["CIMD not advertised", { issuer: ORIGIN, registration_endpoint: `${ORIGIN}/register` }, 400, REFUSED, /client_id_metadata_document_supported/],
  ["CIMD advertised false", { ...METADATA, client_id_metadata_document_supported: false }, 400, REFUSED, /client_id_metadata_document_supported/],
  ["a /register that answers 404", METADATA, 404, null, /expected 400 invalid_redirect_uri/],
  ["a /register that is rate limited", METADATA, 429, { error: "slow_down" }, /answered 429/],
  ["a 400 for some other reason", METADATA, 400, { error: "invalid_client_metadata" }, /expected invalid_redirect_uri/],
  ["metadata that is not JSON", null, 400, REFUSED, /not a JSON object/],
] as const) {
  test(`gate 2 fails on ${name}`, () => {
    assert.match(String(registrationProblem(metadata, ORIGIN, status, body)), pattern);
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
