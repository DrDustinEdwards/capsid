// Client ID Metadata Documents, served by a wrapper on globalThis.fetch installed at module load, not a vi spy:
// the flows restore their spies after the Access callback and the token exchange looks the client up again.

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

export function cimdResponse(url: string): Response | null {
  if (!url.startsWith("https://client.example.com/oauth/")) return null;
  const doc = documents.get(url);
  // no-store, so the provider's cache never answers for a document this module did not serve.
  if (!doc)
    return new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return Response.json(doc, { headers: { "Cache-Control": "no-store" } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  return cimdResponse(url) ?? realFetch(input, init);
}) as typeof fetch;
