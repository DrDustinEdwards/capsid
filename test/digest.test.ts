import assert from "node:assert/strict";
import { test } from "node:test";
import { AWAITING_SEAT_KEY } from "../src/auto-merge-tick.ts";
import { DIGEST_LAST_KEY, digestProblem, digestState, digestTick } from "../src/digest.ts";
import type { OvernightDigest } from "../src/ops-types.ts";
import { selectRows, type Row } from "./fake-sql.ts";
import { fakeKv } from "./fakes.ts";

// The daily email digest (docs/design/design-merge-pipeline.md section 5; DECIDE 5 of
// 2026-10-09). It sends nothing until Email Routing is on, once a UTC day after 12:00,
// and says in the Portal why it is off.

const NOON = new Date("2026-10-11T12:05:00.000Z");
const H = 3_600_000;

const usage = { cost_usd: null, active_seconds: null, tokens: { input: null, output: null, cache_read: null, cache_creation: null } } as never;
const EMPTY: OvernightDigest = {
  generated: NOON.toISOString(),
  since: "",
  for_namespace: null,
  finished: [],
  blocked: [],
  pull_requests_ready: [],
  pull_requests_merged: 0,
  totals: { telemetry: { jobs: 0 } as never, reported: { jobs: 0 } as never, jobs_without_usage: 0 },
  truncated: [],
};
const FULL: OvernightDigest = {
  ...EMPTY,
  finished: [{ id: "job_done", namespace: "capsid", title: "Ship the thing", status: "done", result_kind: "pr", duration_minutes: 30, blocked_count: 0, usage, usage_source: "none" }],
  blocked: [
    { id: "job_q", namespace: "carrel", title: "Which domain?", at: NOON.toISOString(), summary: "QUESTION: which domain?", pull_requests: [], usage, usage_source: "none" },
    { id: "job_b", namespace: "foxing", title: "Create the bucket", at: NOON.toISOString(), summary: "run this", pull_requests: [], usage, usage_source: "none" },
  ],
  pull_requests_ready: [{ job_id: "job_done", namespace: "capsid", url: "https://github.com/owner/capsid/pull/9", state: "open", source: "outcome" }],
  pull_requests_merged: 2,
};

const awaiting = [
  { namespace: "foxhound", repo: "owner/foxhound", number: 7, failed: "money", why: "", at: "", class: "typed" },
  { namespace: "capsid", repo: "owner/capsid", number: 8, failed: "path", why: "", at: "", class: "approve" },
  { namespace: "capsid", repo: "owner/capsid", number: 9, failed: "ci", why: "", at: "", class: "wait" },
];

function world(opts: { routing?: string; email?: boolean; send?: (m: unknown) => Promise<void>; last?: object; deploys?: Row[] } = {}) {
  const sent: Array<{ from: string; to: string; subject: string; text: string }> = [];
  const kv = fakeKv({ seed: { [AWAITING_SEAT_KEY]: JSON.stringify(awaiting), ...(opts.last ? { [DIGEST_LAST_KEY]: JSON.stringify(opts.last) } : {}) } });
  const deploys = opts.deploys ?? [];
  const db = {
    prepare: (sql: string) => {
      let params: unknown[] = [];
      const st = {
        bind: (...p: unknown[]) => ((params = p), st),
        all: async () => ({ results: selectRows(deploys, sql, params) }),
      };
      return st;
    },
  };
  const env = {
    DB: db,
    APP_KV: kv.kv,
    EMAIL_ROUTING: opts.routing ?? "on",
    ALERT_EMAIL: "admin@example.com",
    ALERT_FROM: "capsid@example.com",
    EMAIL:
      opts.email === false
        ? undefined
        : {
            send: async (m: { from: string; to: string; subject: string; text: string }) => {
              if (opts.send) await opts.send(m);
              sent.push(m);
            },
          },
  } as never;
  return { env, sent, kv };
}

const read = (d: OvernightDigest) => async () => d;

test("Email Routing not on: nothing is read or sent, and the reason names it", async () => {
  for (const routing of ["", "off", "yes"]) {
    const w = world({ routing });
    const report = await digestTick(w.env, NOON, read(FULL));
    assert.equal(report.ran, false);
    assert.match(report.note, /Email Routing is not on/);
    assert.equal(w.sent.length, 0);
    assert.deepEqual(w.kv.puts, [], "the digest wrote state while off");
  }
});

test("routing on but an address or the binding missing: still nothing, and it says which", () => {
  assert.match(digestProblem({ EMAIL_ROUTING: "on", EMAIL: {}, ALERT_EMAIL: "a@example.com" } as never)!, /ALERT_FROM is not set/);
  assert.match(digestProblem({ EMAIL_ROUTING: "on", ALERT_EMAIL: "a@example.com", ALERT_FROM: "b@example.com" } as never)!, /the send_email binding EMAIL/);
  assert.equal(digestProblem({ EMAIL_ROUTING: "on", EMAIL: {}, ALERT_EMAIL: "a@example.com", ALERT_FROM: "b@example.com" } as never), null);
});

test("the Portal's state says off and why, or on and where", async () => {
  const off = await digestState(world({ routing: "" }).env);
  assert.equal(off.on, false);
  assert.match(off.problem!, /Email Routing is not on/);
  assert.equal(off.to, null);
  const on = await digestState(world().env);
  assert.deepEqual({ on: on.on, to: on.to, hour: on.hour_utc }, { on: true, to: "admin@example.com", hour: 12 });
});

test("nothing before 12:00 UTC; then one mail, and none again that day", async () => {
  const w = world();
  assert.equal((await digestTick(w.env, new Date("2026-10-11T11:59:00Z"), read(FULL))).ran, false);
  const first = await digestTick(w.env, NOON, read(FULL));
  assert.equal(first.sent, true);
  assert.equal(w.sent.length, 1);
  const again = await digestTick(w.env, new Date(NOON.getTime() + 6 * H), read(FULL));
  assert.equal(again.ran, false);
  assert.equal(w.sent.length, 1);
  assert.equal((await digestTick(w.env, new Date(NOON.getTime() + 24 * H), read(FULL))).sent, true, "the next day sent nothing");
});

test("the mail lists what waits by class, questions, blocked jobs, rollbacks and what finished", async () => {
  const w = world({ deploys: [{ repo: "owner/capsid", head_sha: "a".repeat(40), outcome: "rolled_back", recorded_at: "2026-10-11 02:00:00" }] });
  await digestTick(w.env, NOON, read(FULL));
  const m = w.sent[0]!;
  assert.equal(m.to, "admin@example.com");
  assert.equal(m.from, "capsid@example.com");
  assert.equal(m.subject, "Capsid digest 2026-10-11: 4 waiting on you");
  assert.match(m.text, /owner\/foxhound#7, class typed \(money: approve by typing its number\)/);
  assert.match(m.text, /owner\/capsid#8, class approve/);
  assert.doesNotMatch(m.text, /#9/, "a wait-class pull request was listed as waiting on Dustin");
  assert.match(m.text, /Questions \(1\)\n- carrel job_q: Which domain\?/);
  assert.match(m.text, /Blocked \(1\)\n- foxing job_b: Create the bucket/);
  assert.match(m.text, /Rollbacks \(1\)\n- owner\/capsid at aaaaaaa: rolled back/);
  assert.match(m.text, /Finished \(1\), 2 pull request\(s\) merged/);
  assert.match(m.text, /https:\/\/portal\.dustinedwards\.info\//);
});

test("a quiet day says so", async () => {
  const w = world();
  await w.kv.kv.put(AWAITING_SEAT_KEY, "[]");
  await digestTick(w.env, NOON, read(EMPTY));
  assert.equal(w.sent[0]!.subject, "Capsid digest 2026-10-11: nothing waits on you");
  assert.match(w.sent[0]!.text, /Nothing waits on you and nothing happened/);
});

test("a refused send is recorded for the day and not retried every tick", async () => {
  const w = world({
    send: async () => {
      throw new Error("destination address not verified");
    },
  });
  const report = await digestTick(w.env, NOON, read(FULL));
  assert.deepEqual({ ran: report.ran, sent: report.sent }, { ran: true, sent: false });
  assert.match(report.note, /destination address not verified/);
  assert.equal((await digestTick(w.env, new Date(NOON.getTime() + H), read(FULL))).ran, false);
  const state = await digestState(w.env);
  assert.equal(state.last?.outcome, "failed");
});

test("a digest covers the time since the last one sent, or the last day", async () => {
  const seen: string[] = [];
  const spy = async (_e: unknown, a: { since: string }) => (seen.push(a.since), EMPTY);
  await digestTick(world({ last: { at: "2026-10-09T12:00:00.000Z", outcome: "sent", note: "" } }).env, NOON, spy as never);
  await digestTick(world().env, NOON, spy as never);
  await digestTick(world({ last: { at: "2026-10-10T12:00:00.000Z", outcome: "failed", note: "" } }).env, NOON, spy as never);
  assert.deepEqual(seen, ["2026-10-09T12:00:00.000Z", "2026-10-10T12:05:00.000Z", "2026-10-10T12:05:00.000Z"]);
});
