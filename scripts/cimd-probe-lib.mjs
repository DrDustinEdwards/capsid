// Gate 2's decisions, apart from verify-live.mjs so they can be tested. The Worker takes Claude, Claude Code and ChatGPT by CIMD, and Grok and Gemini by a tightened DCR that admits only allowlisted connector callbacks (capsid/rulings/mcp-2026-10-10.md rule 13).
// The probe client is a fixed document the Worker serves at PROBE_CLIENT_PATH (src/oauth-client-docs.ts). The gate asserts CIMD is on, a registration naming the probe's unlisted redirect is refused (nothing is written), and the document is acceptable.
// Its client id is that document's URL, at a path naming no branch so the master-to-main rename cannot change it (test/cimd-probe.test.ts checks the path). scripts/verify-live-client.json stays until plan step 4 for rollbacks to older code.
export const PROBE_CLIENT_PATH = "/oauth/clients/verify-live.json";
/** @param {string} origin */
export const probeClientId = (origin) => `${origin}${PROBE_CLIENT_PATH}`;
export const PROBE_REDIRECT = "https://example.com/verify-live-callback";

// Returns the problem or null. A 2xx means the allowlist is open; a missing CIMD flag means no Claude client can sign in.
export function registrationProblem(metadata, origin, registerStatus, registerBody) {
  if (!metadata || typeof metadata !== "object")
    return "the authorization-server metadata is not a JSON object";
  if (metadata.client_id_metadata_document_supported !== true) {
    return "the metadata does not advertise client_id_metadata_document_supported, so no client can sign in (is global_fetch_strictly_public set?)";
  }
  if (metadata.registration_endpoint !== `${origin}/register`) {
    return `the metadata advertises registration_endpoint ${JSON.stringify(metadata.registration_endpoint)}, expected ${origin}/register (Grok and Gemini register there)`;
  }
  if (registerStatus >= 200 && registerStatus < 300)
    return `POST /register answered ${registerStatus} for an unlisted redirect; the DCR allowlist is open`;
  if (registerStatus !== 400)
    return `POST /register answered ${registerStatus}, expected 400 invalid_redirect_uri`;
  const error = registerBody && typeof registerBody === "object" ? registerBody.error : undefined;
  if (error !== "invalid_redirect_uri")
    return `POST /register refused with ${JSON.stringify(error)}, expected invalid_redirect_uri`;
  return null;
}

// Returns the problem or null. Checks what the provider's resolveClientIdMetadataDocument would reject that this repo's document could fail, plus the gates' redirect.
export function probeDocumentProblem(doc, url, redirect) {
  if (!doc || typeof doc !== "object") return "the probe document is not a JSON object";
  if (doc.client_id !== url)
    return `the probe document's client_id is ${JSON.stringify(doc.client_id)}, not its own URL ${url}`;
  if (typeof doc.client_name !== "string" || !doc.client_name.trim())
    return "the probe document has no client_name";
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.includes(redirect))
    return `the probe document does not list the redirect ${redirect}`;
  if ("client_secret" in doc)
    return "the probe document carries a client_secret, which CIMD forbids";
  if (doc.token_endpoint_auth_method !== "none")
    return `the probe document's token_endpoint_auth_method is ${JSON.stringify(doc.token_endpoint_auth_method)}, expected "none"`;
  return null;
}
