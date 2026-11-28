import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { resetCapsidDb } from "./reset-db";
import { expect } from "vitest";
import worker from "../src/index";
import { grantAgent } from "../src/agents";
import { portalSessionCookie } from "../src/portal-auth";
import type { Env } from "../src/env";
import { APP_ROSTER } from "../src/roster";
import { blockJob, claimJob, postJob } from "../src/jobs";
import {
  PORTAL_CSRF_HEADER,
  PORTAL_PERFORM_PATH,
  PORTAL_PREVIEW_PATH,
} from "../src/portal-actions";
import type { PortalPreview } from "../src/ops-types/portal";
import { OVERNIGHT_DECISION_KEY, OVERNIGHT_MODE_KEY } from "../src/overnight";
import { BREAKER_THRESHOLD_KEY, breakerResetKey } from "../src/job-breaker";
import { seedCapsidNamespace } from "./jobs-fixture";

export const ORIGIN = "https://capsid.test";
export const SECRET = "integration-portal-cookie-key";
export const CSRF = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
export const NOW = new Date();
export const ACTOR = "access:admin@example.com";
export const DRIVER = grantAgent("write", "agent:capsid-driver");

export const OPERATOR_TOKEN = "integration-operator-token-0000000000000";

export const CF_ACCOUNT = "sample-account";

export function workerEnv(): Env {
  return {
    ...(env as unknown as Env),
    COOKIE_ENCRYPTION_KEY: SECRET,
    DUSTINEDWARDS_OPERATOR_TOKEN: OPERATOR_TOKEN,
    CF_SECRETS_TOKEN: "sample-secrets-token",
    CF_ACCOUNT_ID: CF_ACCOUNT,
  } as Env;
}

// Only these routes are answered; any other fetch goes on as before.
export const operatorCalls: Array<{ url: string; auth: string | null; body: string }> = [];
export const githubCalls: string[] = [];
export const GITHUB_PR = "https://api.github.com/repos/example/capsid/pulls/41";
// The secret value is read here only to check both sides got the same one and that it reached no audit row.
export const secretPuts: Array<{ script: string; name: string; text: string }> = [];
export const SECRETS_URL = new RegExp(
  `^https://api\\.cloudflare\\.com/client/v4/accounts/${CF_ACCOUNT}/workers/scripts/([^/]+)/secrets$`,
);
export const passThrough = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const secret = SECRETS_URL.exec(url);
  if (secret && method === "PUT") {
    const body = JSON.parse(String(init?.body)) as { name: string; text: string };
    secretPuts.push({ script: secret[1], name: body.name, text: body.text });
    return Response.json({
      success: true,
      errors: [],
      result: { name: body.name, type: "secret_text" },
    });
  }
  if (url.startsWith("https://api.github.com/repos/example/capsid")) {
    githubCalls.push(`${method} ${url}`);
    if (url === GITHUB_PR && method === "PATCH")
      return Response.json({
        number: 41,
        state: "closed",
        html_url: "https://github.com/example/capsid/pull/41",
      });
    if (url === GITHUB_PR)
      return Response.json({
        head: { ref: "feat/sample", sha: "c".repeat(40), repo: { full_name: "example/capsid" } },
        base: { ref: "main" },
        state: "open",
        merged: false,
      });
    if (url === "https://api.github.com/repos/example/capsid")
      return Response.json({ default_branch: "main" });
    if (url.endsWith("/git/refs/heads/feat/sample") && method === "DELETE")
      return new Response(null, { status: 204 });
    return new Response("not stubbed", { status: 404 });
  }
  if (url !== "https://dustinedwards.info/api/operator") return passThrough(input, init);
  operatorCalls.push({
    url,
    auth: new Headers(init?.headers).get("authorization"),
    body: String(init?.body),
  });
  if ((JSON.parse(String(init?.body)) as { tool?: string }).tool === "run_job")
    return Response.json({
      ok: true,
      data: { runs: [{ job: "media-backup", status: "ok", ms: 20 }] },
    });
  return Response.json({
    ok: true,
    data: { repaired: 1, expected: 14, present: 14, converged: true },
  });
}) as typeof fetch;

export async function call(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const session = (
    await portalSessionCookie({ email: "admin@example.com" }, SECRET, new Date())
  ).split(";")[0];
  const headers = new Headers({
    Cookie: `${session}; __Secure-capsid_portal_csrf=${CSRF}`,
    "Sec-Fetch-Site": "same-origin",
  });
  if (init.body !== undefined) {
    headers.set(PORTAL_CSRF_HEADER, CSRF);
    headers.set("Content-Type", "application/json");
  }
  const ctx = createExecutionContext();
  const request = new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers,
    redirect: "manual",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const response = await worker.fetch!(request as never, workerEnv() as never, ctx);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

export async function jobsEnv() {
  return workerEnv() as unknown as Parameters<typeof postJob>[0];
}

export async function postedJob(title: string): Promise<string> {
  const posted = await postJob(
    await jobsEnv(),
    grantAgent("write", "github:DrDustinEdwards"),
    NOW,
    { namespace: "capsid", title, body: "do the thing", gate_required: true },
  );
  expect(posted.ok, posted.refusal).toBe(true);
  return posted.job!.id;
}

export async function claimedJob(title: string, by = DRIVER): Promise<string> {
  const id = await postedJob(title);
  const claimed = await claimJob(await jobsEnv(), by, NOW, { id });
  expect(claimed.ok, claimed.refusal).toBe(true);
  return id;
}

export async function blockedJob(title: string, by = DRIVER): Promise<string> {
  const id = await claimedJob(title, by);
  const blocked = await blockJob(await jobsEnv(), by, NOW, id, {
    reason: "waiting on the push",
    command: "git push -u origin feat/x",
  });
  expect(blocked.ok, blocked.refusal).toBe(true);
  return id;
}

export async function parkedJob(title: string): Promise<string> {
  const id = await postedJob(title);
  await env.DB.prepare(
    "UPDATE jobs SET status = 'parked', result_summary = 'comes back when the design is ruled' WHERE id = ?1",
  )
    .bind(id)
    .run();
  return id;
}

export async function auditRows(): Promise<
  Array<{ id: number; actor: string; action: string; params: string }>
> {
  const { results } = await env.DB.prepare(
    "SELECT id, actor, action, params FROM audit_log ORDER BY id",
  ).all<{ id: number; actor: string; action: string; params: string }>();
  return results ?? [];
}

export const KEYS = [
  OVERNIGHT_MODE_KEY,
  OVERNIGHT_DECISION_KEY,
  BREAKER_THRESHOLD_KEY,
  ...APP_ROSTER.map(breakerResetKey),
];

export async function resetPortal() {
  await resetCapsidDb();
  await seedCapsidNamespace();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("sample", JSON.stringify([{ repo: "example/sample", label: "primary" }]))
    .run();
  await env.DB.prepare("DELETE FROM ops_sites WHERE namespace = 'sample'").run();
  for (const key of KEYS) await env.APP_KV.delete(key);
}

export async function packageRow(name: string) {
  return env.DB.prepare("SELECT * FROM ops_packages WHERE name = ?1")
    .bind(name)
    .first<Record<string, unknown>>();
}

export async function siteRow(namespace: string) {
  return env.DB.prepare("SELECT * FROM ops_sites WHERE namespace = ?1")
    .bind(namespace)
    .first<Record<string, unknown>>();
}

export type Case = {
  params: () => Promise<Record<string, string>>;
  after: (params: Record<string, string>) => Promise<void>;
};

export const performToken = (token: string) =>
  call(PORTAL_PERFORM_PATH, { method: "POST", body: { token } });

export async function previewAndPerform(
  action: string,
  params: Record<string, string>,
): Promise<PortalPreview> {
  const preview = (await (
    await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action, params } })
  ).json()) as PortalPreview;
  const performed = await performToken(preview.token);
  expect(performed.status, await performed.clone().text()).toBe(200);
  return preview;
}
