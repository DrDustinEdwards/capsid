// Gate 2's decisions, apart from scripts/verify-live.mjs so they can be tested: the
// same reason scripts/canary-lib.mjs and scripts/freshness-lib.mjs exist. verify-live
// is a program that runs on import.
//
// Since design PR 4 of capsid/research/design-capsid-access-login.md the Worker takes
// clients by Client ID Metadata Document only. The probe client is therefore a fixed
// document in this public repo, served by GitHub at PROBE_CLIENT_ID, and the gate
// asserts two things: registration is gone, and the probe document is one the Worker
// can accept. No client record is written by a run, so nothing is reaped afterwards.

// The probe's client id is the URL of its metadata document, and the document's own
// client_id must equal it exactly. The file is scripts/verify-live-client.json on
// master; test/cimd-probe.test.ts reads that file and checks it against these values.
export const PROBE_CLIENT_ID = "https://raw.githubusercontent.com/DrDustinEdwards/capsid/master/scripts/verify-live-client.json";
export const PROBE_REDIRECT = "https://example.com/verify-live-callback";

// The authorization-server metadata and the answer to POST /register. Returns the
// problem, or null. A registration_endpoint, or a /register that answers 2xx, means DCR
// is back; a missing CIMD flag means no client can sign in at all.
export function registrationProblem(metadata, registerStatus) {
  if (!metadata || typeof metadata !== "object") return "the authorization-server metadata is not a JSON object";
  if ("registration_endpoint" in metadata) return `the metadata advertises registration_endpoint ${metadata.registration_endpoint}; DCR is meant to be off`;
  if (metadata.client_id_metadata_document_supported !== true) {
    return "the metadata does not advertise client_id_metadata_document_supported, so no client can sign in (is global_fetch_strictly_public set?)";
  }
  if (registerStatus >= 200 && registerStatus < 300) return `POST /register answered ${registerStatus}; DCR is meant to be off`;
  if (registerStatus !== 404) return `POST /register answered ${registerStatus}, expected 404`;
  return null;
}

// The probe document as fetched from `url`. Returns the problem, or null. The checks are
// the ones the provider makes (workers-oauth-provider resolveClientIdMetadataDocument)
// that a document in this repo could fail, plus the redirect the gates use.
export function probeDocumentProblem(doc, url, redirect) {
  if (!doc || typeof doc !== "object") return "the probe document is not a JSON object";
  if (doc.client_id !== url) return `the probe document's client_id is ${JSON.stringify(doc.client_id)}, not its own URL ${url}`;
  if (typeof doc.client_name !== "string" || !doc.client_name.trim()) return "the probe document has no client_name";
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.includes(redirect)) return `the probe document does not list the redirect ${redirect}`;
  if ("client_secret" in doc) return "the probe document carries a client_secret, which CIMD forbids";
  if (doc.token_endpoint_auth_method !== "none") return `the probe document's token_endpoint_auth_method is ${JSON.stringify(doc.token_endpoint_auth_method)}, expected "none"`;
  return null;
}
