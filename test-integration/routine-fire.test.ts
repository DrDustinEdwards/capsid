import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimJob, postJob } from "../src/jobs";
import { beginJob } from "../src/jobs-begin";
import { legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import { REFIRE_MINUTES, fireRoutine, fireText, routineTokenName, routineUrlKey, setRoutine } from "../src/routine-fire";

// Capsid fires a namespace's Claude Code routine for one queued job (job_a7d6f6009242,
// docs/routines.md), against a real D1, with Anthropic's fire endpoint stubbed at fetch.

const SECRET = "test-root-secret";
// The real clock: audit_log stamps its own time, and the refire window reads those stamps.
const NOW = new Date();
const POSTER = legacyAgent("write", "github:DrDustinEdwards");
const FIRE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOP/fire";
const TOKEN = "fake-routine-token-not-a-key";
const SESSION = "session_01HJKLMNOPQRSTUVWXYZ";

function jobsEnv(token: string | null = TOKEN) {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET, ...(token === null ? {} : { ROUTINE_CAPSID_TOKEN: token }) } as unknown as Parameters<typeof postJob>[0];
}

function seatAgent(namespaces = ["capsid"]): Agent {
  const scopes = defaultScopes(namespaces);
  scopes.grants = ["read", "write"];
  scopes.flags.can_merge = true;
  return { id: "agent_seat", name: "seat", kind: "seat", actor: "agent:seat", scopes, admin: false, row: null };
}

function driver(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_capsid-driver", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", scopes, admin: false, row: null };
}

interface Fire {
  url: string;
  headers: Record<string, string>;
  body: { text?: string };
}

// A fake fire endpoint: answers with the given status and body, and records each fire.
function anthropic(opts: { status?: number; body?: unknown; headers?: Record<string, string>; throws?: boolean } = {}) {
  const fires: Fire[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (opts.throws) throw new Error("connection reset");
    fires.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
    const body = opts.body ?? { type: "routine_fire", claude_code_session_id: SESSION, claude_code_session_url: `https://claude.ai/code/${SESSION}` };
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: opts.status ?? 200, headers: { "Content-Type": "application/json", ...opts.headers } });
  });
  return fires;
}

async function queued(title = "a job") {
  const posted = await postJob(jobsEnv(), POSTER, NOW, { namespace: "capsid", title, body: "do the thing" });
  expect(posted.ok, posted.refusal).toBe(true);
  return posted.job!.id;
}

// The started label taken off by hand, so a test reaches the fire window behind it.
const clearLabel = (id: string) => env.DB.prepare("UPDATE jobs SET started_at = NULL, started_by = NULL WHERE id = ?1").bind(id).run();

const fireRows = async () =>
  (await env.DB.prepare("SELECT actor, params FROM audit_log WHERE action = 'job-routine-fired' ORDER BY id").all<{ actor: string; params: string }>()).results ?? [];

beforeEach(async () => {
  for (const table of ["jobs", "audit_log", "job_outcomes", "agents"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES ('capsid', ?1)")
    .bind(JSON.stringify([{ repo: "example/capsid", label: "primary" }]))
    .run();
  await env.APP_KV.put(routineUrlKey("capsid"), FIRE_URL);
  await env.APP_KV.delete(routineUrlKey("sample"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the routine setting", () => {
  it("names the token secret per namespace, dashes as underscores", () => {
    expect(routineTokenName("capsid")).toBe("ROUTINE_CAPSID_TOKEN");
    expect(routineTokenName("dustin-edwards")).toBe("ROUTINE_DUSTIN_EDWARDS_TOKEN");
  });

  it("the seat sets, reads and clears a fire URL, audited, and never sees the token", async () => {
    await env.APP_KV.delete(routineUrlKey("capsid"));
    const set = await setRoutine(jobsEnv(), seatAgent(), "capsid", FIRE_URL);
    expect(set.ok, set.refusal).toBe(true);
    expect(set.routine).toEqual({ namespace: "capsid", routine_id: "trig_01ABCDEFGHJKLMNOP", token_secret: "ROUTINE_CAPSID_TOKEN", token_set: true });
    expect(JSON.stringify(set)).not.toContain(TOKEN);
    expect(await env.APP_KV.get(routineUrlKey("capsid"))).toBe(FIRE_URL);
    const audit = await env.DB.prepare("SELECT params FROM audit_log WHERE action = 'routine-set'").first<{ params: string }>();
    expect(JSON.parse(audit!.params)).toEqual({ namespace: "capsid", routine_id: "trig_01ABCDEFGHJKLMNOP" });
    const cleared = await setRoutine(jobsEnv(null), seatAgent(), "capsid", "off");
    expect(cleared.routine).toMatchObject({ routine_id: null, token_set: false });
    expect(cleared.note).toMatch(/npx wrangler secret put ROUTINE_CAPSID_TOKEN/);
    expect(await env.APP_KV.get(routineUrlKey("capsid"))).toBeNull();
  });

  it("refuses a URL that is not Anthropic's fire endpoint, and a caller that is not the seat", async () => {
    for (const bad of ["https://example.com/v1/claude_code/routines/trig_01ABCDEFGH/fire", "http://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGH/fire", `${FIRE_URL}?x=1`]) {
      const refused = await setRoutine(jobsEnv(), seatAgent(), "capsid", bad);
      expect(refused.ok).toBe(false);
      expect(refused.refusal).toMatch(/must be a fire URL/);
    }
    expect(await env.APP_KV.get(routineUrlKey("capsid"))).toBe(FIRE_URL);
    expect((await setRoutine(jobsEnv(), driver(), "capsid", FIRE_URL)).refusal).toMatch(/seat's act/);
  });
});

describe("a fire", () => {
  it("posts the job id to the routine with the token, records the session, and leaves the job queued", async () => {
    const fires = anthropic();
    const id = await queued();
    const fired = await fireRoutine(jobsEnv(), seatAgent(), NOW, id);
    expect(fired.ok, fired.refusal).toBe(true);
    expect(fired.session).toEqual({ id: SESSION, url: `https://claude.ai/code/${SESSION}` });
    expect(fires).toHaveLength(1);
    expect(fires[0].url).toBe(FIRE_URL);
    expect(fires[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fires[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(fires[0].body.text).toBe(fireText(fired.job!));
    expect(fires[0].body.text).toContain(`job_id: ${id}`);
    expect(JSON.stringify(fired)).not.toContain(TOKEN);
    const rows = await fireRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("agent:seat");
    expect(JSON.parse(rows[0].params)).toEqual({ job_id: id, routine_id: "trig_01ABCDEFGHJKLMNOP", session_id: SESSION, session_url: `https://claude.ai/code/${SESSION}`, token_secret: "ROUTINE_CAPSID_TOKEN" });
    const job = await env.DB.prepare("SELECT status, started_by, started_at FROM jobs WHERE id = ?1").bind(id).first<{ status: string; started_by: string; started_at: string }>();
    expect(job).toEqual({ status: "queued", started_by: "agent:seat", started_at: NOW.toISOString() });
    expect(fired.started?.by).toBe("agent:seat");
    const label = await env.DB.prepare("SELECT params FROM audit_log WHERE action = 'job-started' AND json_extract(params, '$.started_at') IS NOT NULL").first<{ params: string }>();
    expect(JSON.parse(label!.params)).toMatchObject({ job_id: id, session_url: `https://claude.ai/code/${SESSION}` });
  });

  it("refuses a second fire for the same job inside the window, and allows one after it", async () => {
    const fires = anthropic();
    const id = await queued();
    expect((await fireRoutine(jobsEnv(), seatAgent(), NOW, id)).ok).toBe(true);
    // A refire is refused first because the job is started; with the label gone, the
    // window still refuses it.
    expect((await fireRoutine(jobsEnv(), seatAgent(), NOW, id)).refusal).toMatch(/^already_started/);
    await clearLabel(id);
    const again = await fireRoutine(jobsEnv(), seatAgent(), NOW, id);
    expect(again.refusal).toMatch(new RegExp(`^already_fired: ${id} was fired at .*claude\\.ai/code/${SESSION}`));
    expect(fires).toHaveLength(1);
    // The first fire and its reservation, moved back past the window.
    await env.DB.prepare(`UPDATE audit_log SET at = datetime('now', ?1) WHERE action IN ('job-routine-fired', 'job-routine-firing')`).bind(`-${REFIRE_MINUTES + 1} minutes`).run();
    const later = await fireRoutine(jobsEnv(), seatAgent(), NOW, id);
    expect(later.ok, later.refusal).toBe(true);
    expect(fires).toHaveLength(2);
  });
});

describe("two fires racing for one job", () => {
  it("post once: the reservation is one statement, so the second is refused before it posts", async () => {
    const fires = anthropic();
    const id = await queued();
    const [a, b] = await Promise.all([fireRoutine(jobsEnv(), seatAgent(), NOW, id), fireRoutine(jobsEnv(), seatAgent(), NOW, id)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect((a.ok ? b : a).refusal).toMatch(/^already_fired/);
    expect(fires).toHaveLength(1);
  });

  it("any 2xx is a started session, recorded", async () => {
    anthropic({ status: 201 });
    const id = await queued();
    const fired = await fireRoutine(jobsEnv(), seatAgent(), NOW, id);
    expect(fired.ok, fired.refusal).toBe(true);
    expect(await fireRows()).toHaveLength(1);
  });
});

describe("each refusal is named, and nothing is fired or recorded", () => {
  async function refusedWith(pattern: RegExp, opts: { env?: ReturnType<typeof jobsEnv>; agent?: Agent; answer?: Parameters<typeof anthropic>[0]; id?: string } = {}) {
    const fires = anthropic(opts.answer);
    const id = opts.id ?? (await queued());
    const refused = await fireRoutine(opts.env ?? jobsEnv(), opts.agent ?? seatAgent(), NOW, id);
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(pattern);
    expect(refused.refusal).not.toContain(TOKEN);
    expect(await fireRows()).toEqual([]);
    return fires;
  }

  it("routine_missing: no fire URL for the namespace", async () => {
    await env.APP_KV.delete(routineUrlKey("capsid"));
    expect(await refusedWith(/^routine_missing: capsid has no routine/)).toEqual([]);
  });

  it("routine_token_missing: no Worker secret for the namespace", async () => {
    expect(await refusedWith(/^routine_token_missing: ROUTINE_CAPSID_TOKEN is not set/, { env: jobsEnv(null) })).toEqual([]);
  });

  it("routine_unauthorized: Anthropic answers 401", async () => {
    const fires = await refusedWith(/^routine_unauthorized: .*\(401\).*npx wrangler secret put ROUTINE_CAPSID_TOKEN/, {
      answer: { status: 401, body: { type: "error", error: { type: "authentication_error", message: "bad token" } } },
    });
    expect(fires).toHaveLength(1);
  });

  it("routine_rate_limited: Anthropic answers 429, with when to retry", async () => {
    await refusedWith(/^routine_rate_limited: .*\(429; .*Retry after 1200 seconds\./, {
      answer: { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, headers: { "Retry-After": "1200" } },
    });
  });

  it("routine_not_found: Anthropic answers 404", async () => {
    await refusedWith(/^routine_not_found: Anthropic has no routine trig_01ABCDEFGHJKLMNOP \(404\)/, {
      answer: { status: 404, body: { type: "error", error: { type: "not_found_error", message: "gone" } } },
    });
  });

  it("routine_refused: any other answer, with the error type and never the message", async () => {
    await refusedWith(/^routine_refused: Anthropic answered 400 invalid_request_error /, {
      answer: { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "<script>paused</script>" } } },
    });
  });

  it("routine_token_missing: an empty secret is no token, and action routine says so too", async () => {
    expect(await refusedWith(/^routine_token_missing/, { env: jobsEnv("") })).toEqual([]);
    expect((await setRoutine(jobsEnv(""), seatAgent(), "capsid", undefined)).routine?.token_set).toBe(false);
  });

  it("routine_unreachable: no answer is recorded as a fire whose session is unknown, so a second waits", async () => {
    anthropic({ throws: true });
    const id = await queued();
    const refused = await fireRoutine(jobsEnv(), seatAgent(), NOW, id);
    expect(refused.refusal).toMatch(/^routine_unreachable: .*connection reset.*A session may have started/);
    const rows = await fireRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].params)).toMatchObject({ job_id: id, session_url: null, outcome: "unknown" });
    expect((await fireRoutine(jobsEnv(), seatAgent(), NOW, id)).refusal).toMatch(/^already_fired/);
  });

  it("a namespace whose token name could be another's is refused", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES ('cap_sid', '[]')").run();
    const admin = { ...seatAgent(), admin: true };
    admin.scopes = { ...admin.scopes, namespaces: "*" };
    expect((await setRoutine(jobsEnv(), admin, "cap_sid", FIRE_URL)).refusal).toMatch(/lowercase letters and digits joined by single dashes/);
    expect(await env.APP_KV.get(routineUrlKey("cap_sid"))).toBeNull();
  });

  it("already_started: a job somebody began is not fired, whoever began it", async () => {
    const id = await queued();
    expect((await beginJob(jobsEnv(), driver(), NOW, id)).ok).toBe(true);
    expect(await refusedWith(/^already_started: agent:capsid-driver started this job at /, { id })).toEqual([]);
  });

  it("a driver, a job that is not queued, and a job that does not exist", async () => {
    expect(await refusedWith(/seat's act/, { agent: driver() })).toEqual([]);
    const claimed = await queued("claimed");
    expect((await claimJob(jobsEnv(), driver(), NOW, { namespace: "capsid", id: claimed })).ok).toBe(true);
    expect(await refusedWith(/is claimed, not queued/, { id: claimed })).toEqual([]);
    expect(await refusedWith(/^no job job_000000000000/, { id: "job_000000000000" })).toEqual([]);
  });
});

describe("one routine for every namespace", () => {
  const SAMPLE_TOKEN = "fake-sample-token-not-a-key";
  const OTHER_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01ZZZZZZZZZZZZZZZ/fire";

  const BOTH = ["capsid", "sample"];

  const sampleEnv = (tokens: Record<string, string>) => ({ ...jobsEnv(null), ...tokens }) as unknown as ReturnType<typeof jobsEnv>;

  beforeEach(async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES ('sample', '[]')").run();
  });

  const auditParams = async () => (await env.DB.prepare("SELECT params FROM audit_log").all<{ params: string | null }>()).results.map((r) => r.params ?? "").join("\n");

  it("a namespace's own token wins over another namespace's on the same routine", async () => {
    await env.APP_KV.put(routineUrlKey("sample"), FIRE_URL);
    const fires = anthropic();
    const id = await queued();
    const fired = await fireRoutine(sampleEnv({ ROUTINE_CAPSID_TOKEN: TOKEN, ROUTINE_SAMPLE_TOKEN: SAMPLE_TOKEN }), seatAgent(BOTH), NOW, id);
    expect(fired.ok, fired.refusal).toBe(true);
    expect(fires).toHaveLength(1);
    expect(fires[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("falls back to the token of a namespace whose fire URL names the same routine", async () => {
    await env.APP_KV.put(routineUrlKey("sample"), FIRE_URL);
    const shared = sampleEnv({ ROUTINE_SAMPLE_TOKEN: SAMPLE_TOKEN });
    const fires = anthropic();
    const id = await queued();
    const fired = await fireRoutine(shared, seatAgent(BOTH), NOW, id);
    expect(fired.ok, fired.refusal).toBe(true);
    expect(fires[0].headers.authorization).toBe(`Bearer ${SAMPLE_TOKEN}`);
    const read = await setRoutine(shared, seatAgent(BOTH), "capsid", undefined);
    expect(read.routine).toEqual({ namespace: "capsid", routine_id: "trig_01ABCDEFGHJKLMNOP", token_secret: "ROUTINE_SAMPLE_TOKEN", token_set: true });
    expect(read.note).toBeUndefined();
  });

  it("a different routine id never borrows", async () => {
    await env.APP_KV.put(routineUrlKey("sample"), OTHER_URL);
    const other = sampleEnv({ ROUTINE_SAMPLE_TOKEN: SAMPLE_TOKEN });
    const fires = anthropic();
    const id = await queued();
    const refused = await fireRoutine(other, seatAgent(BOTH), NOW, id);
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/^routine_token_missing: ROUTINE_CAPSID_TOKEN is not set.*no namespace sharing routine trig_01ABCDEFGHJKLMNOP/);
    expect(fires).toEqual([]);
    expect(await fireRows()).toEqual([]);
    const read = await setRoutine(other, seatAgent(BOTH), "capsid", undefined);
    expect(read.routine).toMatchObject({ token_secret: "ROUTINE_CAPSID_TOKEN", token_set: false });
    expect(read.note).toMatch(/ROUTINE_CAPSID_TOKEN/);
  });

  it("the token value appears in no response and no audit row", async () => {
    await env.APP_KV.put(routineUrlKey("sample"), FIRE_URL);
    const shared = sampleEnv({ ROUTINE_SAMPLE_TOKEN: SAMPLE_TOKEN });
    anthropic();
    const id = await queued();
    const fired = await fireRoutine(shared, seatAgent(BOTH), NOW, id);
    expect(fired.ok, fired.refusal).toBe(true);
    const set = await setRoutine(shared, seatAgent(BOTH), "capsid", FIRE_URL);
    const read = await setRoutine(shared, seatAgent(BOTH), "capsid", undefined);
    for (const text of [JSON.stringify(fired), JSON.stringify(set), JSON.stringify(read), await auditParams()]) expect(text).not.toContain(SAMPLE_TOKEN);
    expect(await auditParams()).toContain("ROUTINE_SAMPLE_TOKEN");
  });

  it("never lends a token from a namespace the caller may not act in", async () => {
    await env.APP_KV.put(routineUrlKey("sample"), FIRE_URL);
    const shared = sampleEnv({ ROUTINE_SAMPLE_TOKEN: SAMPLE_TOKEN });
    const fires = anthropic();
    const id = await queued();
    const refused = await fireRoutine(shared, seatAgent(["capsid"]), NOW, id);
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/^routine_token_missing/);
    expect(fires).toEqual([]);
    const read = await setRoutine(shared, seatAgent(["capsid"]), "capsid", undefined);
    expect(read.routine).toMatchObject({ token_secret: "ROUTINE_CAPSID_TOKEN", token_set: false });
  });
});
