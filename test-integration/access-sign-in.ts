import { stubAccess } from "@dustinedwards/devkit/access";
import { vi } from "vitest";
import { cimdResponse } from "./cimd-stub";

// One sign-in as `email` against the Access SaaS application the test bindings in
// vitest.config.ts name, on top of devkit's Access stub (@dustinedwards/devkit/access).
// Matches those bindings.

export const ISSUER = "https://sample.cloudflareaccess.com/cdn-cgi/access/sso/oidc/sample-client";

// ONE STUB, ONE KEY, FOR THE WHOLE FILE. devkit's stub makes a new signing key each time
// it is created, and the Worker keeps the JWKS it fetched for ISSUER across sign-ins, by
// kid. A key made per sign-in would be refused by the cached one. The stub is not
// installed as fetch: the spy below answers the token route, because the nonce belongs
// to the sign-in and the stub reads it only when it is created.
const access = await stubAccess({ issuer: ISSUER, audience: "sample-client", email: "unused@example.com", install: false, fallback: (url) => cimdResponse(url) ?? undefined });

// Stubs fetch for one sign-in as `email`. The nonce is read from the authorization URL
// the flow sent the browser to, as Access would echo it. Returns the token requests'
// bodies so a test can read the PKCE verifier and redirect_uri sent. The caller puts
// fetch back with vi.restoreAllMocks().
export function stubSignIn(email: string, authorizationUrl: string, extra: Record<string, unknown> = {}): URLSearchParams[] {
  const nonce = new URL(authorizationUrl).searchParams.get("nonce");
  const bodies: URLSearchParams[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input instanceof Request ? input.url : input) === access.tokenUrl) {
      bodies.push(new URLSearchParams(String(init?.body ?? "")));
      return Response.json({ id_token: await access.token({ email, nonce, ...extra }), token_type: "bearer" });
    }
    return access.fetch(input, init);
  });
  return bodies;
}
