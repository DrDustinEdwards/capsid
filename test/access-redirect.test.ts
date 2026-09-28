import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error scripts/ is plain .mjs with no declarations, deliberately: it
// runs in the live CI job with no npm ci and no build step.
import { accessRedirectProblem } from "../scripts/access-redirect-lib.mjs";
// @ts-expect-error scripts/ is plain .mjs with no declarations, deliberately: it
// runs in the live CI job with no npm ci and no build step.
import { ACCESS_SAAS } from "../scripts/bindings.mjs";

// verify-live gate 5: approving the consent form must redirect to the MCP login's Access
// for SaaS app. The URL shape below is the one production answered after #185 deployed
// (actions run 36360666932), with this test's own state, nonce and challenge.

const ORIGIN = "https://capsid.dustin-edwards.workers.dev";

function signIn(overrides: Record<string, string | null> = {}, base = `${ACCESS_SAAS.teamDomain}/cdn-cgi/access/sso/oidc/${ACCESS_SAAS.clientId}/authorization`): string {
  const url = new URL(base);
  const params: Record<string, string | null> = {
    client_id: ACCESS_SAAS.clientId,
    redirect_uri: `${ORIGIN}/callback`,
    response_type: "code",
    scope: "openid email profile",
    state: "5f1a20d5-0eda-46e3-bbff-455da19b88a9",
    nonce: "9c460290-58c0-4995-b0cb-e780bdc54f4d",
    code_challenge: "U-Ke_2XExx4265F-_EEzQRVvGzmWqqSjFGmFWgzzQZs",
    code_challenge_method: "S256",
    ...overrides,
  };
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url.href;
}

test("the Access sign-in production answered with passes", () => {
  assert.equal(accessRedirectProblem(302, signIn(), ORIGIN), null);
});

test("the GitHub authorize URL gate 5 used to expect is refused now", () => {
  assert.match(accessRedirectProblem(302, "https://github.com/login/oauth/authorize?client_id=x", ORIGIN) ?? "", /not the Access team domain/);
});

for (const [name, status, location, reason] of [
  ["not a redirect", 200, signIn(), /status 200/],
  ["no location", 302, "", /not a URL/],
  ["another team", 302, signIn({}, `https://elsewhere.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${ACCESS_SAAS.clientId}/authorization`), /not the Access team domain/],
  ["another app's endpoint", 302, signIn({}, `${ACCESS_SAAS.teamDomain}/cdn-cgi/access/sso/oidc/other-app/authorization`), /not the Capsid app's authorization endpoint/],
  ["another client_id", 302, signIn({ client_id: "other-app" }), /client_id is not/],
  ["a redirect_uri on another host", 302, signIn({ redirect_uri: "https://capsid.dustinedwards.info/callback" }), /redirect_uri is/],
  ["the console callback", 302, signIn({ redirect_uri: `${ORIGIN}/console/callback` }), /redirect_uri is/],
  ["no PKCE method", 302, signIn({ code_challenge_method: null }), /not S256/],
  ["plain PKCE", 302, signIn({ code_challenge_method: "plain" }), /not S256/],
  ["no challenge", 302, signIn({ code_challenge: null }), /not a S256 challenge/],
  ["no nonce", 302, signIn({ nonce: null }), /no nonce/],
  ["no state", 302, signIn({ state: null }), /no state/],
  ["the implicit flow", 302, signIn({ response_type: "token" }), /not code/],
] as const) {
  test(`refused: ${name}`, () => {
    assert.match(accessRedirectProblem(status, location, ORIGIN) ?? "(passed)", reason);
  });
}
