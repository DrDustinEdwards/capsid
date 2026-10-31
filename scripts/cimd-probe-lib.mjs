// Gate 2's decisions, apart from scripts/verify-live.mjs so they can be tested: the
// same reason scripts/canary-lib.mjs and scripts/freshness-lib.mjs exist. verify-live
// is a program that runs on import.
//
// The Worker takes Claude, Claude Code and ChatGPT by Client ID Metadata Document, and
// Grok and Gemini by a tightened Dynamic Client Registration that admits only the
// connector callbacks it allowlists exactly (site-runtime registrationRefusal, capsid/rulings/mcp-2026-10-10.md
// rule 13). The probe client is therefore a fixed document the Worker serves itself at
// PROBE_CLIENT_PATH (src/oauth-client-docs.ts), and the gate asserts three things: CIMD is on, a
// registration naming the probe's unlisted redirect is refused, and the probe document
// is one the Worker can accept. The refused registration writes no client record, so
// nothing is reaped afterwards.

// The probe's client id is the URL of its metadata document, and the document's own
// client_id must equal it exactly. It is served by the Worker under test at a path that
// names no branch (job_bf05bc756c5e, the master to main plan), so the rename cannot change
// the probe's identity. test/cimd-probe.test.ts checks this path against the Worker's.
// Until 2026-10-10 it was scripts/verify-live-client.json on GitHub's master branch; that
// file stays until plan step 4, so a rollback to older code still finds it.
export const PROBE_CLIENT_PATH = "/oauth/clients/verify-live.json";
/** @param {string} origin */
export const probeClientId = (origin) => `${origin}${PROBE_CLIENT_PATH}`;
export const PROBE_REDIRECT = "https://example.com/verify-live-callback";

// The authorization-server metadata and the answer to a POST /register naming the
// probe's redirect, which is on no allowlist. Returns the problem, or null. A 2xx means
// the allowlist is open; a missing CIMD flag means no Claude client can sign in.
export function registrationProblem(metadata, origin, registerStatus, registerBody) {
  if (!metadata || typeof metadata !== "object") return "the authorization-server metadata is not a JSON object";
  if (metadata.client_id_metadata_document_supported !== true) {
    return "the metadata does not advertise client_id_metadata_document_supported, so no client can sign in (is global_fetch_strictly_public set?)";
  }
  if (metadata.registration_endpoint !== `${origin}/register`) {
    return `the metadata advertises registration_endpoint ${JSON.stringify(metadata.registration_endpoint)}, expected ${origin}/register (Grok and Gemini register there)`;
  }
  if (registerStatus >= 200 && registerStatus < 300) return `POST /register answered ${registerStatus} for an unlisted redirect; the DCR allowlist is open`;
  if (registerStatus !== 400) return `POST /register answered ${registerStatus}, expected 400 invalid_redirect_uri`;
  const error = registerBody && typeof registerBody === "object" ? registerBody.error : undefined;
  if (error !== "invalid_redirect_uri") return `POST /register refused with ${JSON.stringify(error)}, expected invalid_redirect_uri`;
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
