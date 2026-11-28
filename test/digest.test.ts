import assert from "node:assert/strict";
import { test } from "node:test";
import { DIGEST_LAST_KEY, digestProblem, digestState, digestTick } from "../src/digest.ts";
import { selectRows, type Row } from "./fake-sql.ts";
import { fakeKv } from "./fakes.ts";

const NOON = new Date("2026-10-11T12:05:00.000Z");
const H = 3_600_000;

function world(
  opts: {
    routing?: string;
    email?: boolean;
    send?: (m: unknown) => Promise<void>;
    last?: object;
    deploys?: Row[];
    findings?: Row[];
    findingsThrow?: boolean;
  } = {},
) {
  const sent: Array<{ from: string; to: string; subject: string; text: string }> = [];
  const kv = fakeKv({
    seed: opts.last ? { [DIGEST_LAST_KEY]: JSON.stringify(opts.last) } : {},
  });
  const deploys = opts.deploys ?? [];
  const bound: unknown[][] = [];
  const db = {
    prepare: (sql: string) => {
      let params: unknown[] = [];
      const st = {
        bind: (...p: unknown[]) => ((params = p), bound.push(p), st),
        all: async () => {
          if (opts.findingsThrow && /FROM watcher_findings/.test(sql)) throw new Error("D1 down");
          return {
            results: selectRows(
              /FROM watcher_findings/.test(sql) ? (opts.findings ?? []) : deploys,
              sql,
              params,
            ),
          };
        },
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
  return { env, sent, kv, bound };
}

test("Email Routing not on: nothing is read or sent, and the reason names it", async () => {
  for (const routing of ["", "off", "yes"]) {
    const w = world({ routing });
    const report = await digestTick(w.env, NOON);
    assert.equal(report.ran, false);
    assert.match(report.note, /Email Routing is not on/);
    assert.equal(w.sent.length, 0);
    assert.deepEqual(w.kv.puts, [], "the digest wrote state while off");
  }
});

test("routing on but an address or the binding missing: still nothing, and it says which", () => {
  assert.match(
    digestProblem({ EMAIL_ROUTING: "on", EMAIL: {}, ALERT_EMAIL: "a@example.com" } as never)!,
    /ALERT_FROM is not set/,
  );
  assert.match(
    digestProblem({
      EMAIL_ROUTING: "on",
      ALERT_EMAIL: "a@example.com",
      ALERT_FROM: "b@example.com",
    } as never)!,
    /the send_email binding EMAIL/,
  );
  assert.equal(
    digestProblem({
      EMAIL_ROUTING: "on",
      EMAIL: {},
      ALERT_EMAIL: "a@example.com",
      ALERT_FROM: "b@example.com",
    } as never),
    null,
  );
});

test("nothing before 12:00 UTC; then one mail, and none again that day", async () => {
  const w = world();
  assert.equal((await digestTick(w.env, new Date("2026-10-11T11:59:00Z"))).ran, false);
  const first = await digestTick(w.env, NOON);
  assert.equal(first.sent, true);
  assert.equal(w.sent.length, 1);
  const again = await digestTick(w.env, new Date(NOON.getTime() + 6 * H));
  assert.equal(again.ran, false);
  assert.equal(w.sent.length, 1);
  assert.equal(
    (await digestTick(w.env, new Date(NOON.getTime() + 24 * H))).sent,
    true,
    "the next day sent nothing",
  );
});

test("the mail lists the rollbacks since the last digest and links the Portal", async () => {
  const w = world({
    deploys: [
      {
        repo: "owner/capsid",
        head_sha: "a".repeat(40),
        outcome: "rolled_back",
        recorded_at: "2026-10-11 02:00:00",
      },
    ],
  });
  await digestTick(w.env, NOON);
  const m = w.sent[0]!;
  assert.equal(m.to, "admin@example.com");
  assert.equal(m.from, "capsid@example.com");
  assert.equal(m.subject, "Capsid digest 2026-10-11: 1 rollback(s)");
  assert.match(m.text, /Rollbacks \(1\)\n- owner\/capsid at aaaaaaa: rolled back/);
  assert.match(m.text, /https:\/\/portal\.dustinedwards\.info\//);
  const quiet = world();
  await digestTick(quiet.env, NOON);
  assert.equal(quiet.sent[0]!.subject, "Capsid digest 2026-10-11: no rollbacks");
  assert.match(quiet.sent[0]!.text, /Nothing happened\./);
});

test("a refused send is recorded for the day and not retried every tick", async () => {
  const w = world({
    send: async () => {
      throw new Error("destination address not verified");
    },
  });
  const report = await digestTick(w.env, NOON);
  assert.deepEqual({ ran: report.ran, sent: report.sent }, { ran: true, sent: false });
  assert.match(report.note, /destination address not verified/);
  assert.equal((await digestTick(w.env, new Date(NOON.getTime() + H))).ran, false);
  const state = await digestState(w.env);
  assert.equal(state.last?.outcome, "failed");
});

test("a digest covers the time since the last one sent, or the last day", async () => {
  const since = async (last?: object) => {
    const w = world(last ? { last } : {});
    await digestTick(w.env, NOON);
    return w.bound[0]![0];
  };
  assert.deepEqual(
    [
      await since({ at: "2026-10-09T12:00:00.000Z", outcome: "sent", note: "" }),
      await since(),
      await since({ at: "2026-10-10T12:00:00.000Z", outcome: "failed", note: "" }),
    ],
    ["2026-10-09 12:00:00", "2026-10-10 12:05:00", "2026-10-10 12:05:00"],
  );
});

const FINDING = (fingerprint: string, namespace: string, headline: string): Row => ({
  fingerprint,
  namespace,
  title: `Watcher: ${headline} [${fingerprint}]`,
  state: "open",
  first_seen_at: "2026-10-05T10:00:00.000Z",
  last_seen_at: "2026-10-12T11:00:00.000Z",
  seen_count: 4,
  evidence: "[]",
});
const MONDAY = new Date("2026-10-12T12:05:00.000Z");

test("on Monday the mail lists the open digest-class findings per site; other days and other classes do not", async () => {
  const findings = [
    FINDING("live-csp-script-sample-home", "sample", "Sample's CSP blocks the beacon script"),
    FINDING("live-headers-sample-home", "sample", "Sample is missing security headers"),
    FINDING("live-headers-other-home", "other", "Other is missing security headers"),
    FINDING("anomaly-rate-sample-driver", "capsid", "an agent is busy"),
    FINDING("site-down-sample", "sample", "Sample is down"),
  ];
  const monday = world({ findings });
  await digestTick(monday.env, MONDAY);
  const text = monday.sent[0]!.text;
  assert.match(text, /Weekly digest \(3 open/);
  assert.match(
    text,
    /sample\n- Sample's CSP blocks the beacon script \(since 2026-10-05\)\n- Sample is missing security headers/,
  );
  assert.match(text, /other\n- Other is missing security headers/);
  assert.doesNotMatch(text, /busy/, "an attention-class finding was in the weekly digest");
  assert.doesNotMatch(text, /is down/, "an alert-class finding was in the weekly digest");
  const sunday = world({ findings });
  await digestTick(sunday.env, NOON);
  assert.doesNotMatch(sunday.sent[0]!.text, /Weekly digest/);
  const none = world();
  await digestTick(none.env, MONDAY);
  assert.doesNotMatch(none.sent[0]!.text, /Weekly digest/);
});

test("a failing weekly read is a one-line note and the mail still goes out", async () => {
  const w = world({ findingsThrow: true });
  const report = await digestTick(w.env, MONDAY);
  assert.equal(report.sent, true);
  assert.match(w.sent[0]!.text, /Weekly digest could not be read\./);
  const other = world({ findingsThrow: true });
  await digestTick(other.env, NOON);
  assert.doesNotMatch(other.sent[0]!.text, /Weekly digest/, "a non-Monday read the findings");
});
