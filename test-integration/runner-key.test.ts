import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockJob, claimJob, completeJob, expireJobLeases, failJob, heartbeatJob, postJob, releaseJob, supersedeJob } from "../src/jobs";
import { legacyAgent, resolveAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import { b64urlEncode, b64urlFromBytes } from "../src/encoding";
import { OIDC_ISSUER, exchangeRunnerKey } from "../src/runner-key";
import { opsLive } from "../src/ops-feed";
import { SEAT_START_CAP_KEY, SEAT_START_KEY, setSeatStart, startSeatSession } from "../src/seat-start";
import { buildServer } from "../src/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// /ops/runner-key against real D1, with GitHub's OIDC key set and REST API stubbed at
// fetch and a real RSA key signing the token (capsid/research/design-seat-session-
// hardening.md, section 2). Every pinned claim is refused when wrong, one exchange per
// start, and the minted key works its job and stops when the job ends.

const SECRET = "test-root-secret";
const REPO = "example/capsid";
const REPO_ID = 4242;
// The real clock: the start's audit row takes its `at` from the database's
// datetime('now'), and the exchange's pending window is measured against it.
const NOW = new Date();
const POSTER = legacyAgent("write", "github:DrDustinEdwards");

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

function seatAgent(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.flags.can_merge = true;
  return { id: "agent_seat", name: "seat", kind: "seat", actor: "agent:seat", scopes, admin: false, row: null };
}

let signing: CryptoKeyPair;
let publicJwk: JsonWebKey;

async function signJwt(claims: Record<string, unknown>, key: CryptoKey = signing.privateKey, kid = "k1"): Promise<string> {
  const head = b64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = b64urlEncode(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

function goodClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const at = Math.floor(NOW.getTime() / 1000);
  return {
    iss: OIDC_ISSUER,
    aud: "capsid",
    iat: at - 10,
    nbf: at - 10,
    exp: at + 300,
    repository: REPO,
    repository_id: String(REPO_ID),
    ref: "refs/heads/master",
    job_workflow_ref: `${REPO}/.github/workflows/seat-session.yml@refs/heads/master`,
    workflow_ref: `${REPO}/.github/workflows/seat-session.yml@refs/heads/master`,
    environment: "seat",
    event_name: "repository_dispatch",
    runner_environment: "github-hosted",
    run_id: "99",
    run_attempt: "1",
    ...overrides,
  };
}

// GitHub: the OIDC key set, the repo, and the dispatch the start sends. Counts the
// key-set fetches, because an exchange that is refused on the cheap checks must not
// send anything to GitHub.
let jwksFetches = 0;
function github(opts: { jwksStatus?: number } = {}) {
  jwksFetches = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === `${OIDC_ISSUER}/.well-known/jwks`) {
      jwksFetches++;
      // A JSON error body, so the status check is what refuses rather than a parse
      // failure standing in for it.
      return opts.jwksStatus ? json({ message: "down", keys: [] }, opts.jwksStatus) : json({ keys: [{ ...publicJwk, kid: "k1" }] });
    }
    if (url.pathname === `/repos/${REPO}` && (init?.method ?? "GET") === "GET") {
      return json({ id: REPO_ID, full_name: REPO, default_branch: "master", private: false });
    }
    if (url.pathname === `/repos/${REPO}/dispatches`) return new Response(null, { status: 204 });
    return new Response("not modelled", { status: 404 });
  });
}

async function startedJob(title = "runner work"): Promise<string> {
  const posted = await postJob(jobsEnv(), POSTER, NOW, { namespace: "capsid", title, body: "do the thing" });
  expect(posted.ok, posted.refusal).toBe(true);
  const started = await startSeatSession(jobsEnv(), seatAgent(), NOW, posted.job!.id);
  expect(started.ok, started.refusal).toBe(true);
  return posted.job!.id;
}

const exchange = async (jobId: string, token: string, at = NOW) => exchangeRunnerKey(jobsEnv(), token, JSON.stringify({ job_id: jobId }), at);
const bearer = (key: string) => new Request("https://capsid.example/ops/mcp", { headers: { Authorization: `Bearer ${key}` } });

beforeEach(async () => {
  for (const table of ["jobs", "audit_log", "job_outcomes", "agents"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES ('capsid', ?1)")
    .bind(JSON.stringify([{ repo: REPO, label: "primary" }]))
    .run();
  await env.APP_KV.put(`gh:token:v3:${REPO}`, "test-token");
  const cached = await env.APP_KV.list({ prefix: "gh:get:" });
  for (const key of cached.keys) await env.APP_KV.delete(key.name);
  await env.APP_KV.delete(SEAT_START_CAP_KEY);
  await setSeatStart(env as never, "github:DrDustinEdwards", { value: "on" });
  signing = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  publicJwk = (await crypto.subtle.exportKey("jwk", signing.publicKey)) as JsonWebKey;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.APP_KV.delete(SEAT_START_KEY);
});

describe("the exchange", () => {
  it("mints a key bound to the started job, which resolves and claims that job", async () => {
    github();
    const id = await startedJob();
    const minted = await exchange(id, await signJwt(goodClaims()));
    expect(minted.ok, minted.ok ? "" : minted.refusal).toBe(true);
    if (!minted.ok) return;
    const row = await env.DB.prepare("SELECT kind, job_id, scopes FROM agents WHERE job_id = ?1").bind(id).first<{ kind: string; job_id: string; scopes: string }>();
    expect(row?.kind).toBe("session");
    const scopes = JSON.parse(row!.scopes);
    expect(scopes.namespaces).toEqual(["capsid"]);
    expect(scopes.repos).toEqual([REPO]);
    expect(Object.values(scopes.flags).some(Boolean)).toBe(false);
    const resolved = await resolveAgent(bearer(minted.key), env, NOW);
    expect(resolved?.agent.job).toBe(id);
    const claimed = await claimJob(jobsEnv(), resolved!.agent, NOW, { namespace: "capsid", id });
    expect(claimed.ok, claimed.refusal).toBe(true);
    // The audit row names the claims the token carried, and no claim's value, so the
    // canary can say which of workflow_ref and job_workflow_ref a real run sends.
    const audit = await env.DB.prepare("SELECT params FROM audit_log WHERE action = 'runner-key-minted'").first<{ params: string }>();
    const params = JSON.parse(audit!.params);
    expect(params.claims_present).toEqual(Object.keys(goodClaims()).sort());
    expect(audit!.params).not.toContain("refs/heads/master");
    // The run, which the repository_dispatch that started it could not return: the
    // OIDC run_id claim and the run's page, joined into the Watch Floor's seat list.
    expect(params.run_id).toBe("99");
    expect(params.run_url).toBe(`https://github.com/${REPO}/actions/runs/99`);
    const live = await opsLive(env, NOW);
    const start = live.seat_start.recent.find((s) => s.job_id === id);
    expect(start, "the feed does not list this start").toBeDefined();
    expect(start!.run_id).toBe(99);
    expect(start!.run_url).toBe(`https://github.com/${REPO}/actions/runs/99`);
    expect(start!.namespace).toBe("capsid");
  });

  it("issues one key per start", async () => {
    github();
    const id = await startedJob();
    expect((await exchange(id, await signJwt(goodClaims()))).ok).toBe(true);
    const again = await exchange(id, await signJwt(goodClaims({ run_attempt: "2" })));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.status).toBe(409);
  });

  it("refuses every pinned run claim when it is wrong", async () => {
    github();
    const id = await startedJob();
    const wrong: Array<[string, unknown]> = [
      ["repository_id", "1"],
      ["repository", "example/other"],
      ["ref", "refs/heads/feature"],
      ["job_workflow_ref", `${REPO}/.github/workflows/other.yml@refs/heads/master`],
      ["job_workflow_ref", `${REPO}/.github/workflows/seat-session.yml@refs/heads/feature`],
      // GitHub documents job_workflow_ref for reusable workflows and workflow_ref for
      // every job, so both are pinned, and a token missing either is refused.
      ["workflow_ref", `${REPO}/.github/workflows/other.yml@refs/heads/master`],
      ["workflow_ref", undefined],
      ["job_workflow_ref", undefined],
      ["environment", "production"],
      ["event_name", "workflow_dispatch"],
      ["runner_environment", "self-hosted"],
    ];
    for (const [claim, value] of wrong) {
      const refused = await exchange(id, await signJwt(goodClaims({ [claim]: value })));
      expect(refused.ok, `${claim}=${String(value)} was accepted`).toBe(false);
      if (!refused.ok) expect(refused.status).toBe(403);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM agents").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("refuses a token that is not GitHub's, not for Capsid, or expired", async () => {
    github();
    const id = await startedJob();
    const other = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    const at = Math.floor(NOW.getTime() / 1000);
    const bad: Array<[string, string]> = [
      ["signed by another key", await signJwt(goodClaims(), other.privateKey)],
      ["unknown kid", await signJwt(goodClaims(), signing.privateKey, "k2")],
      ["wrong issuer", await signJwt(goodClaims({ iss: "https://example.com" }))],
      ["wrong audience", await signJwt(goodClaims({ aud: "sts.amazonaws.com" }))],
      ["expired", await signJwt(goodClaims({ exp: at - 1 }))],
      ["not valid yet, past the skew", await signJwt(goodClaims({ nbf: at + 120 }))],
      ["issued in the future, past the skew", await signJwt(goodClaims({ iat: at + 120 }))],
      ["not a JWT", "not-a-jwt"],
    ];
    for (const [why, token] of bad) {
      const refused = await exchange(id, token);
      expect(refused.ok, `${why} was accepted`).toBe(false);
      if (!refused.ok) expect(refused.status, why).toBe(401);
    }
  });

  it("refuses without a pending start, and after the start window", async () => {
    github();
    const posted = await postJob(jobsEnv(), POSTER, NOW, { namespace: "capsid", title: "never started", body: "b" });
    const unstarted = await exchange(posted.job!.id, await signJwt(goodClaims()));
    expect(unstarted.ok).toBe(false);
    const missing = await exchange("job_000000000000", "not-a-jwt");
    expect(missing.ok).toBe(false);
    if (!unstarted.ok && !missing.ok) expect(missing.refusal.replace(/job_\w+/, "")).toBe(unstarted.refusal.replace(/job_\w+/, ""));
    expect(jwksFetches, "a refused exchange for an unstarted job fetched GitHub's key set").toBe(0);
    const id = await startedJob();
    const later = new Date(NOW.getTime() + 21 * 60_000);
    const stale = await exchange(id, await signJwt(goodClaims({ exp: Math.floor(later.getTime() / 1000) + 300 })), later);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.refusal).toMatch(/no seat start/);
  });

  it("fails closed when GitHub's key set cannot be read", async () => {
    github({ jwksStatus: 500 });
    const id = await startedJob();
    const refused = await exchange(id, await signJwt(goodClaims()));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.status).toBe(503);
  });
});

// The path the canary session takes: a key minted by the exchange, resolved as the
// Worker resolves it, then the jobs TOOL, so the registrar and the handler's own scope
// re-check both run. The first two hardened canary runs claimed nothing because the
// handler's re-check refused a bound key; claimJob called directly, as the tests above
// do, never passes through it.
describe("a minted key works its job through the jobs tool", () => {
  async function jobsTool(agent: Agent, args: Record<string, unknown>) {
    const server = buildServer(jobsEnv(), agent);
    const client = new Client({ name: "runner-key", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const result = (await client.callTool({ name: "jobs", arguments: { namespace: "capsid", ...args } })) as { isError?: boolean; content: Array<{ text: string }> };
    await client.close();
    return { isError: result.isError === true, text: result.content[0]?.text ?? "" };
  }

  it("claims and heartbeats its own job, and is refused another", async () => {
    github();
    const id = await startedJob("through the tool");
    const minted = await exchange(id, await signJwt(goodClaims()));
    if (!minted.ok) throw new Error(minted.refusal);
    const agent = (await resolveAgent(bearer(minted.key), env, NOW))!.agent;

    const claimed = await jobsTool(agent, { action: "claim", id });
    expect(claimed.isError, claimed.text.slice(0, 200)).toBe(false);
    const row = await env.DB.prepare("SELECT status, claimed_by FROM jobs WHERE id = ?1").bind(id).first<{ status: string; claimed_by: string }>();
    expect(row).toEqual({ status: "claimed", claimed_by: agent.actor });

    const beat = await jobsTool(agent, { action: "heartbeat", id });
    expect(beat.isError, beat.text.slice(0, 200)).toBe(false);

    const other = await jobsTool(agent, { action: "claim", id: "job_000000000000" });
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/bound to job/);
  });
});

describe("revoked when the job's run ends", () => {
  async function claimedBound(title: string): Promise<{ id: string; agent: Agent; key: string }> {
    const id = await startedJob(title);
    const minted = await exchange(id, await signJwt(goodClaims()));
    if (!minted.ok) throw new Error(minted.refusal);
    const agent = (await resolveAgent(bearer(minted.key), env, NOW))!.agent;
    const claimed = await claimJob(jobsEnv(), agent, NOW, { namespace: "capsid", id });
    expect(claimed.ok, claimed.refusal).toBe(true);
    return { id, agent, key: minted.key };
  }
  const revokedAt = async (id: string) =>
    (await env.DB.prepare("SELECT revoked_at FROM agents WHERE job_id = ?1").bind(id).first<{ revoked_at: string | null }>())?.revoked_at ?? null;

  // Seat review of #174: a job put back to the queue, by release or by an expired lease,
  // is queued again, and the resolver accepts a bound key on a queued job for 20
  // minutes after the key was minted. So the key has to be revoked by the move itself.
  it("is revoked when the job is released, inside the pending window", async () => {
    github();
    const released = await claimedBound("released");
    expect((await releaseJob(jobsEnv(), seatAgent(), NOW, released.id, "runner not coming back")).ok).toBe(true);
    expect(await revokedAt(released.id), "release left the key live").not.toBeNull();
    expect(await resolveAgent(bearer(released.key), env, NOW), "a released job's key still resolves").toBeNull();
  });

  it("is revoked when the job's lease expires, inside the pending window", async () => {
    github();
    const expired = await claimedBound("expired");
    await env.DB.prepare("UPDATE jobs SET lease_expires = ?2 WHERE id = ?1").bind(expired.id, new Date(NOW.getTime() - 1000).toISOString()).run();
    const { requeued } = await expireJobLeases(jobsEnv(), NOW);
    expect(requeued).toContain(expired.id);
    expect(await revokedAt(expired.id), "an expired lease left the key live").not.toBeNull();
    expect(await resolveAgent(bearer(expired.key), env, NOW), "an expired job's key still resolves").toBeNull();
  });

  it("stays live across a heartbeat", async () => {
    github();
    const { id, agent } = await claimedBound("heartbeat");
    expect((await heartbeatJob(jobsEnv(), agent, NOW, id)).ok).toBe(true);
    expect(await revokedAt(id)).toBeNull();
  });

  it("is revoked on complete, fail, block and supersede", async () => {
    github();
    const ends: Array<[string, (id: string, agent: Agent) => Promise<{ ok: boolean; refusal?: string }>]> = [
      ["complete", (id, agent) => completeJob(jobsEnv(), agent, NOW, id, { result_summary: "done" })],
      ["fail", (id, agent) => failJob(jobsEnv(), agent, NOW, id, "could not")],
      ["block", (id, agent) => blockJob(jobsEnv(), agent, NOW, id, { reason: "gate", command: "Merge it" })],
      ["supersede", (id) => supersedeJob(jobsEnv(), seatAgent(), NOW, id, { reason: "replaced" })],
    ];
    for (const [how, end] of ends) {
      const { id, agent, key } = await claimedBound(`ends by ${how}`);
      const ended = await end(id, agent);
      expect(ended.ok, `${how}: ${ended.refusal}`).toBe(true);
      expect(await revokedAt(id), `${how} left the key live`).not.toBeNull();
      expect(await resolveAgent(bearer(key), env, NOW), `${how}: the key still resolves`).toBeNull();
    }
  });
});
