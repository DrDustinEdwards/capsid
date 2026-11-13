import { env } from "cloudflare:test";
import { expect } from "vitest";
import type { Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import { GATE_CLASSES, GATE_POLICY_PATH } from "../src/gate-policy";
import { blockJob, claimJob, postJob } from "../src/jobs";
import { signTaskBody } from "../src/signed-docs";

// The job tests' shared setup: the Worker's env with a signing secret, the seat and driver
// agents they act as, and a job's row as stored. Fake data only (CLAUDE.md, public repo rule).

/** The secret job bodies and approvals are signed with in these tests. */
export const TEST_SECRET = "test-root-secret";

type JobsEnv = Parameters<typeof postJob>[0];

/** The test Worker's env with the signing secret set; `extra` adds or overrides bindings. */
export function jobsEnv(extra: Record<string, unknown> = {}): JobsEnv {
  return { ...env, IMPROVE_SCORE_SECRET: TEST_SECRET, ...extra } as unknown as JobsEnv;
}

/** The seat: reads and writes capsid, and may merge. */
export function seatAgent(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.flags.can_merge = true;
  return {
    id: "agent_aaaabbbbcccc",
    name: "seat",
    kind: "seat",
    actor: "agent:seat",
    scopes,
    admin: false,
    row: null,
  };
}

/** A driver that reads and writes one namespace (capsid unless named). */
export function driverAgent(
  actor = "agent:capsid-driver",
  { id = `agent_${actor.length}`, namespace = "capsid" }: { id?: string; namespace?: string } = {},
): Agent {
  const scopes = defaultScopes([namespace]);
  scopes.grants = ["read", "write"];
  return {
    id,
    name: actor.slice("agent:".length),
    kind: "driver",
    actor,
    scopes,
    admin: false,
    row: null,
  };
}

/** A job's row as stored. */
export function jobRow(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1")
    .bind(id)
    .first<Record<string, unknown>>();
}

/** The gate policy, signed with TEST_SECRET and enabled, pre-approving every gate class. */
export async function seedGatePolicy(): Promise<void> {
  const policy = [
    "# Pre-approved gates",
    "",
    "- version: 1",
    "- enabled: true",
    "",
    "## Classes",
    "",
    ...GATE_CLASSES.map((c) => `- \`${c}\` a bounded command.`),
    "",
  ].join("\n");
  await env.DB.prepare(
    "INSERT INTO documents (namespace, path, title, body, type, status) VALUES ('capsid', ?1, 'gates', ?2, 'procedural', 'published')",
  )
    .bind(GATE_POLICY_PATH, await signTaskBody(TEST_SECRET, policy))
    .run();
}

/** The capsid namespace, registered with one repository: posting a job requires it. */
export async function seedCapsidNamespace(): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }]))
    .run();
}

const SAMPLE_TOKEN_KEY = "gh:token:v3:example/sample";

/** The sample namespace on example/sample, with a GitHub token cached so nothing asks the App
 *  for one. Pair it with dropSampleToken after each test. */
export async function seedSampleRepo(): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("sample", JSON.stringify([{ repo: "example/sample", label: "primary" }]))
    .run();
  await env.APP_KV.put(SAMPLE_TOKEN_KEY, "test-token");
}

/** Forgets the token seedSampleRepo cached. */
export async function dropSampleToken(): Promise<void> {
  await env.APP_KV.delete(SAMPLE_TOKEN_KEY);
}

/** A gate-required capsid job `poster` posted at `at`; its id. */
export async function postGatedJob(poster: Agent, at: Date, title: string): Promise<string> {
  const posted = await postJob(jobsEnv(), poster, at, {
    namespace: "capsid",
    title,
    body: "do the thing",
    gate_required: true,
  });
  expect(posted.ok, posted.refusal).toBe(true);
  return posted.job!.id;
}

/** A gated job `holder` claimed and blocked at `at` on `block`; its id. */
export async function blockedJob(
  poster: Agent,
  holder: Agent,
  at: Date,
  title: string,
  block: { reason: string; command: string },
): Promise<string> {
  const id = await postGatedJob(poster, at, title);
  expect((await claimJob(jobsEnv(), holder, at, { id })).ok).toBe(true);
  expect((await blockJob(jobsEnv(), holder, at, id, block)).ok).toBe(true);
  return id;
}
