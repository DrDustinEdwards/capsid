import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { APPROVAL_MAX_AGE_SECONDS } from "../src/approval";
import { checkRate, REGISTRATION_LIMIT } from "../src/rate-limit";

// THE CONSENT AND CALLBACK FLOW, AS A BROWSER DRIVES IT (job_3e1596235513).
//
// These replace tests in test/oauth-flow.test.ts that read src/routes.ts and
// src/index.ts as text, because node cannot load either. Here the Worker's own fetch
// handler is called, the consent form is read out of the dialog and posted back, and
// GitHub's token endpoint is stubbed, so nothing leaves the test.

const ORIGIN = "https://capsid.test";
const HTTPS_REDIRECT = "https://client.example.com/callback";
const LOOPBACK_REDIRECT = "http://127.0.0.1:8976/callback";

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  // The approval cookie is signed, and the pool binds no key for it, so one is supplied.
  const response = await worker.fetch!(request as never, { ...env, COOKIE_ENCRYPTION_KEY: "integration-cookie-key" } as never, ctx);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

async function register(redirects: string[], ip = "198.51.100.10"): Promise<Response> {
  return call(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ client_name: "flow-client", redirect_uris: redirects, token_endpoint_auth_method: "none" }),
    })
  );
}

async function clientId(redirects: string[]): Promise<string> {
  const response = await register(redirects);
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

function authorizeUrl(id: string, redirect: string): string {
  const url = new URL(`${ORIGIN}/authorize`);
  url.searchParams.set("client_id", id);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "flow-state");
  return url.toString();
}

function cookieValues(response: Response): string[] {
  return response.headers.getSetCookie().map((c) => c.split(";")[0]);
}

function hidden(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  expect(match, `the dialog has no hidden ${name} field`).toBeTruthy();
  return match![1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

// Approve a client for one redirect the way a browser does: render the dialog, then
// post its form back with the CSRF cookie it set. Returns the approval response.
async function approve(id: string, redirect: string): Promise<Response> {
  const dialog = await call(new Request(authorizeUrl(id, redirect)));
  expect(dialog.status).toBe(200);
  const html = await dialog.text();
  const form = new URLSearchParams({ csrf: hidden(html, "csrf"), req: hidden(html, "req") });
  return call(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieValues(dialog).join("; ") },
      body: form.toString(),
    })
  );
}

describe("registration", () => {
  it("a caller over the registration limit is refused with 429", async () => {
    const ip = "198.51.100.77";
    let verdict = await checkRate(env.APP_KV as never, ip, new Date(), REGISTRATION_LIMIT);
    for (let i = 0; i < REGISTRATION_LIMIT.perHour + 1 && verdict.allowed; i++) {
      verdict = await checkRate(env.APP_KV as never, ip, new Date(), REGISTRATION_LIMIT);
    }
    expect(verdict.allowed, "the limiter never refused, so this test proves nothing").toBe(false);
    const refused = await register([HTTPS_REDIRECT], ip);
    expect(refused.status).toBe(429);
    const other = await register([HTTPS_REDIRECT], "198.51.100.78");
    expect(other.status, "a different caller was refused too").toBe(201);
  });
});

describe("approval", () => {
  it("the approval cookie lives 30 days", async () => {
    const id = await clientId([HTTPS_REDIRECT]);
    const approved = await approve(id, HTTPS_REDIRECT);
    expect(approved.status).toBe(302);
    const cookies = approved.headers.getSetCookie();
    expect(cookies.some((c) => c.includes(`Max-Age=${APPROVAL_MAX_AGE_SECONDS}`)), cookies.join(" | ")).toBe(true);
    expect(APPROVAL_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it("an approval covers the exact redirect it was given, and a sibling redirect comes back to the dialog", async () => {
    const id = await clientId([HTTPS_REDIRECT, LOOPBACK_REDIRECT]);
    const approved = await approve(id, HTTPS_REDIRECT);
    const cookie = cookieValues(approved).join("; ");
    const same = await call(new Request(authorizeUrl(id, HTTPS_REDIRECT), { headers: { Cookie: cookie } }));
    expect(same.status, "the approved redirect did not skip the dialog").toBe(302);
    const sibling = await call(new Request(authorizeUrl(id, LOOPBACK_REDIRECT), { headers: { Cookie: cookie } }));
    expect(sibling.status, "approving one redirect skipped the dialog for another").toBe(200);
  });

  it("the dialog lists every redirect the client registered, not only the requested one", async () => {
    const id = await clientId([HTTPS_REDIRECT, LOOPBACK_REDIRECT]);
    const dialog = await call(new Request(authorizeUrl(id, HTTPS_REDIRECT)));
    const html = await dialog.text();
    expect(html).toContain(HTTPS_REDIRECT);
    expect(html).toContain(LOOPBACK_REDIRECT);
  });

  it("an approval for a client that no longer resolves does not skip anything", async () => {
    const id = await clientId([HTTPS_REDIRECT]);
    const cookie = cookieValues(await approve(id, HTTPS_REDIRECT)).join("; ");
    const keys = await env.OAUTH_KV.list({ prefix: "client:" });
    for (const key of keys.keys) if (key.name.includes(id)) await env.OAUTH_KV.delete(key.name);
    const after = await call(new Request(authorizeUrl(id, HTTPS_REDIRECT), { headers: { Cookie: cookie } }));
    expect(after.status).not.toBe(302);
  });
});

describe("callback", () => {
  // Starts a real flow and returns the state token and the cookie that goes with it.
  async function started(): Promise<{ state: string; cookie: string }> {
    const id = await clientId([HTTPS_REDIRECT]);
    const approved = await approve(id, HTTPS_REDIRECT);
    const location = new URL(String(approved.headers.get("location")));
    const state = String(location.searchParams.get("state"));
    const cookie = cookieValues(approved).find((c) => c.startsWith("capsid_state=")) ?? "";
    expect(cookie, "the flow set no state cookie").not.toBe("");
    return { state, cookie };
  }

  it("a failed token exchange leaves the state in place, so the flow can be retried", async () => {
    const { state, cookie } = await started();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ error: "bad_verification_code" }));
    const response = await call(new Request(`${ORIGIN}/callback?code=c&state=${state}`, { headers: { Cookie: cookie } }));
    expect(response.status).toBe(502);
    expect(await env.OAUTH_KV.get(`capsid:oauth-state:${state}`), "the state was consumed before the exchange succeeded").not.toBeNull();
  });

  it("a corrupt stored state answers 403 and is removed", async () => {
    const { state, cookie } = await started();
    await env.OAUTH_KV.put(`capsid:oauth-state:${state}`, "{not json");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await call(new Request(`${ORIGIN}/callback?code=c&state=${state}`, { headers: { Cookie: cookie } }));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("stored authorization state is unreadable. Restart from your MCP client.");
    expect(await env.OAUTH_KV.get(`capsid:oauth-state:${state}`)).toBeNull();
    expect(fetchSpy, "an unreadable state still reached GitHub").not.toHaveBeenCalled();
  });
});
