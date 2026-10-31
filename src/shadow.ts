import { remoteKeys, verifyJwt, type KeySource } from "@dustinedwards/site-runtime/access-login";
import type { Env } from "./env";
import { ghFetch, resolveRepo } from "./github/client";
import { textResponse } from "./http";
import { readJob } from "./jobs-transition";
import { jobDocPath } from "./jobs-schema";
import { splitSignedTask } from "./signed-docs";
import { readBoundedText } from "./signed-requests";
import { auditStatement } from "./store-guards";

// THE SHADOW TEST (docs/work-queue.md, "The shadow test"; Grok design review 2026-10-23,
// build step 8). On a capsid pull request that names its job, .github/workflows/shadow-test.yml
// has a model read the job and the code at the base, never the diff, write one test of
// what the job asks, and run it on the base and on the head. It blocks nothing and is
// not in the study: the results are recorded so they can show, over many jobs, whether
// a test written blind catches work that CI and the gates on complete let through.
//
// The workflow proves which workflow it is with its GitHub Actions OIDC token, so no key
// is stored anywhere: the token's repository must be the capsid namespace's primary
// repo, its workflow this file, its event a pull request, and the job it reads the one
// that pull request's description names, in the capsid namespace.
//
//   GET  /shadow/job     the job's title and body, and the test already written for it
//   POST /shadow/result  the test (kept for the job's later pushes) and its two results

export const SHADOW_JOB_PATH = "/shadow/job";
export const SHADOW_RESULT_PATH = "/shadow/result";
const SHADOW_ACTION = "shadow-test";
const NAMESPACE = "capsid";
const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "capsid-shadow";
const WORKFLOW = ".github/workflows/shadow-test.yml";
const MAX_TEST_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 80 * 1024;
const TEST_TTL_S = 30 * 24 * 3600;
const RESULTS = ["failed", "passed", "error", "not-run"] as const;
const testKey = (jobId: string) => `shadow:test:${jobId}`;

// The key set's address comes from the issuer's discovery document, as OIDC defines,
// and must be on the issuer's own host.
let keys: KeySource | null = null;
async function issuerKeys(): Promise<KeySource> {
  if (keys) return keys;
  const resp = await fetch(`${ISSUER}/.well-known/openid-configuration`);
  if (!resp.ok) throw new Error(`the issuer's discovery document answered ${resp.status}`);
  const uri = new URL(String(((await resp.json()) as { jwks_uri?: unknown }).jwks_uri));
  if (uri.origin !== ISSUER) throw new Error("the issuer's key set is on another host");
  keys = remoteKeys(uri.href);
  return keys;
}

type Caller = { ok: true; pr: number; jobId: string; headSha: string } | { ok: false; response: Response };

async function caller(request: Request, env: Env): Promise<Caller> {
  const refuse = (status: number, why: string): Caller => ({ ok: false, response: textResponse(why, status) });
  const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!token) return refuse(401, "a GitHub Actions OIDC token is required");
  let claims: Record<string, unknown>;
  const claim = (name: string) => (typeof claims[name] === "string" ? (claims[name] as string) : "");
  try {
    const verdict = await verifyJwt(token, await issuerKeys(), { issuer: ISSUER, audience: AUDIENCE });
    if (!verdict.ok) return refuse(401, "the OIDC token does not verify");
    claims = verdict.claims;
  } catch {
    return refuse(401, "the OIDC token does not verify");
  }
  const repo = (await resolveRepo(env, NAMESPACE)).full;
  const pr = /^refs\/pull\/(\d+)\/merge$/.exec(claim("ref"))?.[1];
  if (
    claim("repository").toLowerCase() !== repo.toLowerCase() ||
    claims.event_name !== "pull_request" ||
    !claim("workflow_ref").toLowerCase().startsWith(`${repo}/${WORKFLOW}@`.toLowerCase()) ||
    !pr
  ) {
    return refuse(403, `only ${WORKFLOW} on a pull request in ${repo} may read the shadow test's job`);
  }
  const [owner, name] = repo.split("/");
  const resp = await ghFetch(env, owner, name, `/repos/${owner}/${name}/pulls/${pr}`);
  if (!resp.ok) return refuse(502, `GitHub answered ${resp.status} for pull request ${pr}`);
  const pull = (await resp.json()) as { body?: string | null; head?: { sha?: string } };
  const jobId = /\bjob_[0-9a-f]{12}\b/.exec(pull.body ?? "")?.[0];
  if (!jobId) return refuse(404, `pull request ${pr} names no job`);
  const job = await readJob(env.DB, jobId);
  if (!job || job.namespace !== NAMESPACE) return refuse(404, `${jobId} is not a ${NAMESPACE} job`);
  return { ok: true, pr: Number(pr), jobId, headSha: pull.head?.sha ?? "" };
}

export async function handleShadowJob(request: Request, env: Env): Promise<Response> {
  const who = await caller(request, env);
  if (!who.ok) return who.response;
  const job = (await readJob(env.DB, who.jobId))!;
  const test = await env.APP_KV.get(testKey(who.jobId), "json");
  // The body as its poster wrote it, without the signature frontmatter.
  return Response.json({ job_id: job.id, title: job.title, body: splitSignedTask(job.body).body, test });
}

export async function handleShadowResult(request: Request, env: Env): Promise<Response> {
  const who = await caller(request, env);
  if (!who.ok) return who.response;
  const raw = await readBoundedText(request, MAX_RESULT_BYTES);
  if (!raw.ok) return textResponse(`the body is over ${MAX_RESULT_BYTES} bytes`, 413);
  let r: { path?: unknown; test?: unknown; base?: unknown; head?: unknown };
  try {
    r = JSON.parse(raw.text);
  } catch {
    return textResponse("the body is not JSON", 400);
  }
  const path = typeof r.path === "string" && /^(test|test-integration)\/shadow\.test\.ts$/.test(r.path) ? r.path : null;
  const test = typeof r.test === "string" && r.test.length > 0 && r.test.length <= MAX_TEST_BYTES ? r.test : null;
  const result = (v: unknown) => (RESULTS as readonly unknown[]).includes(v) ? (v as (typeof RESULTS)[number]) : null;
  const base = result(r.base);
  const head = result(r.head);
  if (!path || !test || !base || !head) return textResponse(`path, test, base and head are required; base and head are one of ${RESULTS.join(", ")}`, 400);
  // The first test written for a job is the one kept: a later push runs it again rather
  // than asking the model for another.
  if ((await env.APP_KV.get(testKey(who.jobId))) === null) await env.APP_KV.put(testKey(who.jobId), JSON.stringify({ path, test }), { expirationTtl: TEST_TTL_S });
  await auditStatement(env.DB, "system:shadow-test", SHADOW_ACTION, NAMESPACE, jobDocPath(who.jobId), {
    job_id: who.jobId,
    pr: who.pr,
    head_sha: who.headSha,
    path,
    base,
    head,
  }).run();
  return Response.json({ ok: true, job_id: who.jobId, base, head });
}
