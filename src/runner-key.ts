import type { Env } from "./env";
import { sha256Hex } from "./auth";
import { defaultScopes, mintAgentId, mintAgentKey, serializeScopes } from "./agents-schema";
import { PENDING_START_MINUTES, jobDocPath } from "./jobs-schema";
import { readJob } from "./jobs-transition";
import { SEAT_START_NAMESPACES } from "./seat-start";
import { ghFetch, resolveRepo } from "./github/client";
import { auditStatement } from "./store-guards";
import { b64urlDecode } from "./encoding";

// /ops/runner-key: a seat-started session trades its GitHub OIDC token for a Capsid
// key bound to the one job it was started for (capsid/research/design-seat-session-
// hardening.md, section 2; ruled in capsid/decisions.md, 2026-09-26). No long-lived
// runner secret exists anywhere: the OIDC token is minted by GitHub for this one job
// run, and the key it buys resolves only while that job is live for it (src/agents.ts)
// and may work that job only (src/scope.ts).
//
// What authorizes the request is the token's signature and its claims, every one of
// which is pinned below against what GitHub says about the repo at the moment of the
// exchange, not against a copy held here.

export const RUNNER_KEY_PATH = "/ops/runner-key";
export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "capsid";
const SEAT_SESSION_WORKFLOW = ".github/workflows/seat-session.yml";

// What a runner may call. Enough to claim, read, heartbeat, open its pull request and
// hand the job on; nothing that writes a document or touches a repo directly.
const RUNNER_TOOLS = ["jobs", "read", "list", "search", "brief", "open_pr", "improve_status"] as const;

// Clock skew allowed on iat and nbf. exp gets none.
const SKEW_SECONDS = 60;
const MAX_TOKEN_CHARS = 8192;
const MAX_BODY_CHARS = 512;

export type Exchange = { ok: true; key: string; agent: string; job_id: string } | { ok: false; status: number; refusal: string };

const refuse = (status: number, refusal: string): Exchange => ({ ok: false, status, refusal });

interface OidcClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  repository?: string;
  repository_id?: string;
  ref?: string;
  job_workflow_ref?: string;
  workflow_ref?: string;
  environment?: string;
  event_name?: string;
  runner_environment?: string;
  run_id?: string;
  run_attempt?: string;
}

function decodePart<T>(part: string): T | null {
  try {
    return JSON.parse(b64urlDecode(part)) as T;
  } catch {
    return null;
  }
}

function b64urlBytes(part: string): Uint8Array {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Verify a GitHub Actions OIDC token's signature and time claims. The claims about
 *  WHICH run it is are checked by the caller, against GitHub. */
async function verifyGithubOidc(token: string, now: Date): Promise<{ ok: true; claims: OidcClaims } | { ok: false; status: number; refusal: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 401, refusal: "the bearer is not a JWT" };
  const header = decodePart<{ alg?: string; kid?: string }>(parts[0]);
  const claims = decodePart<OidcClaims>(parts[1]);
  if (!header || !claims) return { ok: false, status: 401, refusal: "the JWT header or payload does not decode" };
  if (header.alg !== "RS256" || !header.kid) return { ok: false, status: 401, refusal: `the JWT must be RS256 with a kid; got alg '${header.alg}'` };

  // Fetched per exchange: exchanges are rare, and a cached key set is one more thing
  // that can be stale. An unreachable key set is a refusal, never a pass.
  let keys: Array<JsonWebKey & { kid?: string }>;
  try {
    const res = await fetch(`${OIDC_ISSUER}/.well-known/jwks`);
    if (!res.ok) return { ok: false, status: 503, refusal: `GitHub's OIDC key set answered ${res.status}, so the token cannot be verified` };
    keys = ((await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> }).keys ?? [];
  } catch (err) {
    return { ok: false, status: 503, refusal: `GitHub's OIDC key set could not be read (${err instanceof Error ? err.message : String(err)}), so the token cannot be verified` };
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk || jwk.kty !== "RSA") return { ok: false, status: 401, refusal: `no RSA key '${header.kid}' in GitHub's OIDC key set` };
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), signed))) {
    return { ok: false, status: 401, refusal: "the JWT signature does not verify against GitHub's key" };
  }

  const at = Math.floor(now.getTime() / 1000);
  if (claims.iss !== OIDC_ISSUER) return { ok: false, status: 401, refusal: `issuer '${claims.iss}' is not ${OIDC_ISSUER}` };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(OIDC_AUDIENCE)) return { ok: false, status: 401, refusal: `audience is not '${OIDC_AUDIENCE}'` };
  if (typeof claims.exp !== "number" || claims.exp <= at) return { ok: false, status: 401, refusal: "the token has expired" };
  if (typeof claims.nbf === "number" && claims.nbf > at + SKEW_SECONDS) return { ok: false, status: 401, refusal: "the token is not valid yet" };
  if (typeof claims.iat === "number" && claims.iat > at + SKEW_SECONDS) return { ok: false, status: 401, refusal: "the token was issued in the future" };
  return { ok: true, claims };
}

/** A run's Actions page, or null for a run id that is not a positive integer. GitHub
 *  sends run_id as a string; a number is accepted too rather than dropped. */
export function runUrl(repository: string, runId: unknown): string | null {
  const id = typeof runId === "number" ? String(runId) : runId;
  if (typeof id !== "string" || !/^[1-9][0-9]{0,14}$/.test(id)) return null;
  return `https://github.com/${repository}/actions/runs/${id}`;
}

// D1's datetime text form, so the minted row's created_at is the instant the resolver's
// pending window counts from.
const sqliteTime = (now: Date) => now.toISOString().slice(0, 19).replace("T", " ");

/** The exchange: a verified OIDC token and a job id in, a bound key out, or a refusal. */
export async function exchangeRunnerKey(env: Env, token: string, rawBody: string, now: Date): Promise<Exchange> {
  if (!token || token.length > MAX_TOKEN_CHARS) return refuse(401, "no OIDC bearer token");
  if (rawBody.length > MAX_BODY_CHARS) return refuse(400, `the body exceeds ${MAX_BODY_CHARS} characters`);
  let jobId: unknown;
  try {
    jobId = (JSON.parse(rawBody) as { job_id?: unknown }).job_id;
  } catch {
    return refuse(400, "the body is not JSON");
  }
  if (typeof jobId !== "string" || !/^job_[0-9a-f]{12}$/.test(jobId)) return refuse(400, "the body must name a job_id");

  // The cheap checks first, and before anything is fetched: this route takes no
  // credential until the token verifies, so an unstarted job must cost one D1 read and
  // nothing sent to GitHub. One refusal for all four cases, so a caller without a valid
  // token learns nothing about a job it names.
  //
  // The start this exchange belongs to is the newest job-seat-started row for this job
  // inside the pending window. Its id is in the agent's name, and the name is UNIQUE, so
  // a second exchange for the same start fails at the insert whatever order two
  // concurrent requests commit in.
  const noStart = refuse(403, `no seat start for ${jobId} in the last ${PENDING_START_MINUTES} minutes`);
  const job = await readJob(env.DB, jobId);
  if (!job || !SEAT_START_NAMESPACES.includes(job.namespace) || job.status !== "queued") return noStart;
  const since = new Date(now.getTime() - PENDING_START_MINUTES * 60_000).toISOString();
  const start = await env.DB.prepare(
    `SELECT id FROM audit_log WHERE action = 'job-seat-started' AND path = ?1 AND at >= datetime(?2) ORDER BY id DESC LIMIT 1`
  )
    .bind(jobDocPath(jobId), since)
    .first<{ id: number }>();
  if (!start) return noStart;

  const verified = await verifyGithubOidc(token, now);
  if (!verified.ok) return verified;
  const claims = verified.claims;

  // Every run claim is pinned against GitHub as it is now: the repo id (a renamed or
  // recreated repo has a new one), the default branch the workflow must run from, and
  // public visibility, which the start also required.
  const repo = await resolveRepo(env, job.namespace);
  const meta = await ghFetch(env, repo.owner, repo.repo, `/repos/${repo.owner}/${repo.repo}`);
  if (!meta.ok) return refuse(503, `${repo.full} could not be read from GitHub (${meta.status}), so the token's claims cannot be checked`);
  const facts = (await meta.json()) as { id?: number; default_branch?: string; private?: boolean };
  if (facts.id === undefined || !facts.default_branch) return refuse(503, `GitHub's answer for ${repo.full} carried no id or default branch`);
  if (facts.private !== false) return refuse(403, `${repo.full} is not public`);

  const expected: Array<[keyof OidcClaims, string]> = [
    ["repository_id", String(facts.id)],
    ["repository", repo.full],
    ["ref", `refs/heads/${facts.default_branch}`],
    // GitHub's OIDC reference documents workflow_ref for every job and job_workflow_ref
    // "for jobs using a reusable workflow". seat-session.yml calls none, so both must
    // name it; a token missing either is refused rather than trusted on the other. The
    // PR 5 canary reports which of the two a real run carries.
    ["workflow_ref", `${repo.full}/${SEAT_SESSION_WORKFLOW}@refs/heads/${facts.default_branch}`],
    ["job_workflow_ref", `${repo.full}/${SEAT_SESSION_WORKFLOW}@refs/heads/${facts.default_branch}`],
    ["environment", "seat"],
    ["event_name", "repository_dispatch"],
    ["runner_environment", "github-hosted"],
  ];
  for (const [claim, want] of expected) {
    if (claims[claim] !== want) return refuse(403, `claim ${claim} is '${String(claims[claim])}', expected '${want}'`);
  }

  const scopes = defaultScopes([job.namespace]);
  scopes.repos = [repo.full];
  scopes.tools = [...RUNNER_TOOLS];
  scopes.grants = ["read", "write"];
  const key = mintAgentKey();
  const name = `runner-${jobId}-s${start.id}`;
  const actor = `github-oidc:${repo.full}@${claims.run_id ?? "?"}.${claims.run_attempt ?? "?"}`;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at, job_id) VALUES (?1, ?2, 'session', ?3, ?4, ?5, ?6, ?7)"
      ).bind(mintAgentId(), name, await sha256Hex(key), serializeScopes(scopes), actor, sqliteTime(now), jobId),
      auditStatement(env.DB, actor, "runner-key-minted", job.namespace, jobDocPath(jobId), {
        job_id: jobId,
        agent: name,
        start_audit_id: start.id,
        run_id: claims.run_id ?? null,
        run_attempt: claims.run_attempt ?? null,
        // The run's page, for the Watch Floor's seat-start list (src/ops-feed.ts). A
        // repository_dispatch returns no run id, so this row is the first place the
        // Worker learns which run a start became. run_id is GitHub's OIDC claim "The ID
        // of the workflow run that triggered the workflow"
        // (https://docs.github.com/en/actions/reference/security/oidc), and the
        // repository is repo.full, which the claim was pinned to above.
        run_url: runUrl(repo.full, claims.run_id),
        // The names only, never a value: what the canary reads to say which claims a
        // real run carries (job_workflow_ref is documented for reusable workflows only).
        claims_present: Object.keys(claims).sort(),
      }),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(message)) return refuse(409, `a key was already issued for this start of ${jobId}; one exchange per start`);
    throw err;
  }
  return { ok: true, key, agent: `agent:${name}`, job_id: jobId };
}
