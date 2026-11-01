import { env } from "cloudflare:test";
import { resetCapsidDb } from "./reset-db";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { postJob } from "../src/jobs";
import { legacyAgent } from "../src/agents";
import { handleShadowJob, handleShadowResult } from "../src/shadow";

// The shadow test's two routes (src/shadow.ts): only shadow-test.yml on a pull request in
// the capsid namespace's repo reads the job that pull request names. GitHub's OIDC issuer
// and the pull request are fetch stubs; the tokens are signed here with a local key.

const ISSUER = "https://token.actions.githubusercontent.com";
const REPO = "example/capsid";
let key: CryptoKey;
let jwk: object;
let jobId = "";

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: "test-root-secret" } as unknown as Parameters<typeof postJob>[0];
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
});

beforeEach(async () => {
  await resetCapsidDb();
  await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES ('capsid', ?1)").bind(JSON.stringify([{ repo: REPO, label: "primary" }])).run();
  await env.APP_KV.put(`gh:token:v3:${REPO}`, "test-token");
  const seat = legacyAgent("write", "access:seat@example.com");
  jobId = (await postJob(jobsEnv(), seat, new Date(), { namespace: "capsid", title: "shadow", body: "do the thing" } as Parameters<typeof postJob>[3])).job!.id;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks` });
    if (url === `${ISSUER}/.well-known/jwks`) return Response.json({ keys: [jwk] });
    if (url.endsWith(`/repos/${REPO}/pulls/7`)) return Response.json({ body: `Closes ${jobId}.`, head: { sha: "a".repeat(40) } });
    return new Response("not stubbed", { status: 404 });
  });
});

afterEach(() => vi.restoreAllMocks());

const token = (claims: Record<string, string>) =>
  new SignJWT({ repository: REPO, event_name: "pull_request", ref: "refs/pull/7/merge", workflow_ref: `${REPO}/.github/workflows/shadow-test.yml@refs/pull/7/merge`, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience("capsid-shadow")
    .setExpirationTime("5m")
    .sign(key);

const get = async (claims: Record<string, string> = {}) =>
  handleShadowJob(new Request("https://capsid.example.com/shadow/job", { headers: { Authorization: `Bearer ${await token(claims)}` } }), env as never);

it("only the shadow workflow on a pull request reads the job it names, and its result is kept", async () => {
  expect((await get({ workflow_ref: `${REPO}/.github/workflows/other.yml@refs/pull/7/merge` })).status).toBe(403);
  expect((await get({ repository: "example/elsewhere" })).status).toBe(403);
  expect((await get({ event_name: "push", ref: "refs/heads/master" })).status).toBe(403);

  const read = await get();
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ job_id: jobId, body: "do the thing", test: null });

  const post = async (test: string) =>
    handleShadowResult(
      new Request("https://capsid.example.com/shadow/result", {
        method: "POST",
        headers: { Authorization: `Bearer ${await token({})}` },
        body: JSON.stringify({ path: "test/shadow.test.ts", test, base: "failed", head: "passed" }),
      }),
      env as never
    );
  expect((await post("first")).status).toBe(200);
  expect((await post("second")).status).toBe(200);
  expect(await (await get()).json()).toMatchObject({ test: { path: "test/shadow.test.ts", test: "first" } });
  const rows = await env.DB.prepare("SELECT params FROM audit_log WHERE action = 'shadow-test'").all<{ params: string }>();
  expect(rows.results.map((r) => JSON.parse(r.params))).toMatchObject([{ job_id: jobId, pr: 7, base: "failed", head: "passed" }, { job_id: jobId }]);
});
