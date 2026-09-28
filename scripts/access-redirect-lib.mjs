// verify-live gate 5's check, side-effect free so a test can drive it. Approving the
// consent form must redirect to the MCP login's Access for SaaS app (src/access-login.ts):
// the team domain, the app's authorization endpoint for the pinned client id, this
// origin's /callback, the authorization code flow with PKCE S256, a nonce and a state.
//
// NO node_modules IMPORTS: verify-live runs in the live job, which skips npm ci.

import { ACCESS_SAAS } from "./bindings.mjs";

// null when the redirect is the Access sign-in it should be, otherwise the reason.
export function accessRedirectProblem(status, location, origin, access = ACCESS_SAAS) {
  if (status !== 302) return `status ${status}, not 302`;
  let url;
  try {
    url = new URL(location);
  } catch {
    return `location is not a URL: ${String(location).slice(0, 80) || "(none)"}`;
  }
  const expectedPath = `/cdn-cgi/access/sso/oidc/${access.clientId}/authorization`;
  if (url.origin !== access.teamDomain) return `redirects to ${url.origin}, not the Access team domain ${access.teamDomain}`;
  if (url.pathname !== expectedPath) return `redirects to ${url.pathname}, not the Capsid app's authorization endpoint`;
  const q = url.searchParams;
  if (q.get("client_id") !== access.clientId) return "client_id is not the Capsid app's";
  if (q.get("redirect_uri") !== `${origin}/callback`) return `redirect_uri is ${q.get("redirect_uri")}, not ${origin}/callback`;
  if (q.get("response_type") !== "code") return `response_type is ${q.get("response_type")}, not code`;
  if (q.get("code_challenge_method") !== "S256") return `code_challenge_method is ${q.get("code_challenge_method")}, not S256`;
  if (!/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? "")) return "code_challenge is not a S256 challenge";
  if (!q.get("nonce")) return "no nonce";
  if (!q.get("state")) return "no state";
  return null;
}
