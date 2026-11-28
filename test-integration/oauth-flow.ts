import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect } from "vitest";
import worker from "../src/index";
import { forgetKeys } from "@dustinedwards/site-runtime/access-login";
import { stubAccess } from "@dustinedwards/devkit/access";
import { cimdClient, cimdResponse } from "./cimd-stub";

// The OAuth round trip through the real provider: CIMD client, consent, a stubbed Access sign-in with a real signed ID
// token, then the PKCE exchange.

export const ORIGIN = "https://mcp.dustinedwards.info";
export const REDIRECT = "https://client.example.com/callback";
// RFC 7636 appendix B: this verifier's S256 challenge is E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM.
export const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
export const ISSUER = `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${env.ACCESS_SAAS_CLIENT_ID}`;

export async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch!(
    request as never,
    { ...env, COOKIE_ENCRYPTION_KEY: "integration-cookie-key" } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

const cookieValues = (response: Response): string[] =>
  response.headers.getSetCookie().map((c) => c.split(";")[0]);

function hidden(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  expect(match, `the dialog has no hidden ${name} field`).toBeTruthy();
  return match![1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

export async function tokenRequest(body: Record<string, string>): Promise<Response> {
  return call(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    }),
  );
}

export async function authorize(
  email: string,
  extra: Record<string, unknown> = {},
  sameClient?: string,
  write = true,
): Promise<{
  clientId: string;
  code: string | null;
  callback: Response;
  tokenBodies: URLSearchParams[];
  signIn: URL;
}> {
  const clientId = sameClient ?? cimdClient([REDIRECT], "round-trip");

  const url = new URL(`${ORIGIN}/authorize`);
  for (const [k, v] of Object.entries({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "client-state",
  })) {
    url.searchParams.set(k, v);
  }
  const dialog = await call(new Request(url));
  expect(dialog.status).toBe(200);
  const html = await dialog.text();
  const form = new URLSearchParams({ handle: hidden(html, "handle"), decision: "approve" });
  if (write) form.set("allow_write", "1");
  const approved = await call(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieValues(dialog).join("; "),
      },
      body: form.toString(),
    }),
  );
  expect(approved.status).toBe(302);
  const signIn = new URL(String(approved.headers.get("location")));
  const state = String(signIn.searchParams.get("state"));
  const stateCookie = cookieValues(approved).join("; ");

  // Each stub signs with a key of its own under the same kid, and the verifier keeps the
  // keys it read per JWKS URL, so the last sign-in's key is dropped first.
  forgetKeys();
  // The stub swaps the global fetch outright, so it is put back here rather than by
  // vi.restoreAllMocks. The token exchange after it finds the client documents again.
  const access = await stubAccess({
    issuer: ISSUER,
    audience: env.ACCESS_SAAS_CLIENT_ID!,
    email,
    authorizationUrl: signIn.href,
    claims: extra,
    fallback: (u) => cimdResponse(u) ?? undefined,
  });
  let callback: Response;
  try {
    callback = await call(
      new Request(`${ORIGIN}/callback?code=access-code&state=${state}`, {
        headers: { Cookie: stateCookie },
      }),
    );
  } finally {
    access.restore();
  }
  const tokenBodies = access.tokenRequests;
  const location = callback.headers.get("location");
  const code =
    location && location.startsWith(REDIRECT) ? new URL(location).searchParams.get("code") : null;
  return { clientId, code, callback, tokenBodies, signIn };
}
