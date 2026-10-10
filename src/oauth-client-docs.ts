// OAuth client documents the Worker serves itself (job_bf05bc756c5e, the master to main
// plan; Dustin 2026-10-03: "the two OAuth client documents are served by the capsid Worker
// itself at a stable path, so no client id depends on a branch name again").
//
// Since design PR 4 of capsid/research/design-capsid-access-login.md the Worker takes
// clients by Client ID Metadata Document only, and a client id is the URL of its document.
// The verify-live probe's document was a file on the master branch
// (scripts/verify-live-client.json, through raw.githubusercontent.com), so renaming the
// branch would have changed the probe's identity. Here it is served at a path that names
// no branch. The document's client_id is the URL it was fetched at, which is what the
// provider requires (scripts/cimd-probe-lib.mjs, probeDocumentProblem).
//
// Public by nature: a CIMD document is fetched by the authorization server with no
// credential and holds no secret (token_endpoint_auth_method "none").

const OAUTH_CLIENT_PREFIX = "/oauth/clients/";
export const VERIFY_LIVE_CLIENT_PATH = `${OAUTH_CLIENT_PREFIX}verify-live.json`;

const DOCUMENTS: Record<string, Record<string, unknown>> = {
  [VERIFY_LIVE_CLIENT_PATH]: {
    client_name: "capsid verify-live probe",
    redirect_uris: ["https://example.com/verify-live-callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  },
};

/** The client document at `url`, or null when no document lives at that path. */
export function clientDocument(url: URL): Record<string, unknown> | null {
  const doc = DOCUMENTS[url.pathname];
  return doc ? { client_id: `${url.origin}${url.pathname}`, ...doc } : null;
}

export function handleClientDocument(request: Request): Response {
  const url = new URL(request.url);
  const doc = clientDocument(url);
  if (!doc) return new Response("no such client document", { status: 404, headers: { "Content-Type": "text/plain;charset=utf-8" } });
  return Response.json(doc, { headers: { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
}
