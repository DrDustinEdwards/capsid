import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { cimdClient } from "./cimd-stub";

// The consent and callback flow, as a browser drives it. Node cannot load
// src/routes.ts or src/index.ts, so this runs here: the Worker's own fetch handler is
// called, the consent form is read out of the dialog and posted back, and the
// upstream's token endpoint is stubbed, so nothing leaves the test. Clients are CIMD
// documents served by ./cimd-stub.

const ORIGIN = "https://capsid.test";
const HTTPS_REDIRECT = "https://client.example.com/callback";
const LOOPBACK_REDIRECT = "http://127.0.0.1:8976/callback";

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch!(request as never, env as never, ctx);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

async function clientId(redirects: string[]): Promise<string> {
  return cimdClient(redirects, "flow-client");
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

describe("consent", () => {
  it("PLANT: approving once does not skip the dialog the next time (no remembered approval, H5)", async () => {
    const id = await clientId([HTTPS_REDIRECT]);
    const approved = await approve(id, HTTPS_REDIRECT);
    expect(approved.status).toBe(302);
    const again = await call(new Request(authorizeUrl(id, HTTPS_REDIRECT), { headers: { Cookie: cookieValues(approved).join("; ") } }));
    expect(again.status, "a second authorization skipped the consent dialog").toBe(200);
  });

  it("the dialog lists every redirect the client registered, and warns when the requested one is on this computer", async () => {
    const id = await clientId([HTTPS_REDIRECT, LOOPBACK_REDIRECT]);
    const https = await (await call(new Request(authorizeUrl(id, HTTPS_REDIRECT)))).text();
    expect(https).toContain(HTTPS_REDIRECT);
    expect(https).toContain(LOOPBACK_REDIRECT);
    expect(https).not.toContain("an app on your computer");
    const loopback = await (await call(new Request(authorizeUrl(id, LOOPBACK_REDIRECT)))).text();
    expect(loopback).toContain("an app on your computer");
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
    expect(fetchSpy, "an unreadable state still reached Access").not.toHaveBeenCalled();
  });
});
