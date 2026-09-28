// Client ID Metadata Documents, as the provider fetches them. Since design PR 4 of
// capsid/research/design-capsid-access-login.md there is no /register: a client's id is
// the https URL of its metadata document, and the provider fetches that URL when the
// client appears at /authorize and /token.
//
// The documents are served by a wrapper around globalThis.fetch installed when this
// module loads, not by a vi spy, because the flows restore their spies halfway
// (after the Access callback) and the token exchange looks the client up again. A spy
// that stubs Access falls through to cimdResponse for the same reason.

const documents = new Map<string, Record<string, unknown>>();
let counter = 0;

// A fresh client whose metadata document names `redirects`. Each call is a new URL, so
// the provider's CIMD cache never answers one test with another test's document.
export function cimdClient(redirects: string[], name = "integration-client"): string {
  const url = `https://client.example.com/oauth/client-${++counter}-${crypto.randomUUID()}.json`;
  documents.set(url, {
    client_id: url,
    client_name: name,
    redirect_uris: redirects,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  return url;
}

// Takes a client's document down, so its id no longer resolves.
export function withdrawCimdClient(url: string): void {
  documents.delete(url);
}

// The document for a URL this module published, or a 404 for one it withdrew, or null
// for any URL that is not a client document.
export function cimdResponse(url: string): Response | null {
  if (!url.startsWith("https://client.example.com/oauth/")) return null;
  const doc = documents.get(url);
  // no-store, so the provider's cache cannot keep a withdrawn document alive.
  if (!doc) return new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return Response.json(doc, { headers: { "Cache-Control": "no-store" } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  return cimdResponse(url) ?? realFetch(input, init);
}) as typeof fetch;
