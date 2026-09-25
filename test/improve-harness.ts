// THE IMPROVE LOOP HARNESS, shared by test/improve-run.test.ts and
// test/improve-unjudged.test.ts. It used to be copied between the two files (audit
// item C1-13), so a fixture fixed in one stayed wrong in the other.
import { anchorChecksum, parseScoresDoc, seedScoresDoc } from "../src/improve-scores.ts";
import type { ScoreReport } from "../src/improve-scorer.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, type FakeD1Options } from "./fakes.ts";

export const NOW = new Date("2026-09-04T08:05:00Z");
export const SCORES = seedScoresDoc("capsid");

export async function pin(): Promise<string> {
  return anchorChecksum(parseScoresDoc("capsid", SCORES));
}

// A baseline the attempt is compared against, written as improve_scores rows with
// a null attempt_id, exactly as the baseline ingest writes them.
export const BASELINE = [
  { run_id: "capsid-r1", namespace: "capsid", metric: "build_passes", value: 1, attempt_id: null },
  { run_id: "capsid-r1", namespace: "capsid", metric: "holdout_pass_rate", value: 1, attempt_id: null },
  { run_id: "capsid-r1", namespace: "capsid", metric: "test_pass_rate", value: 0.9, attempt_id: null },
  { run_id: "capsid-r1", namespace: "capsid", metric: "lint_count", value: 10, attempt_id: null },
  { run_id: "capsid-r1", namespace: "capsid", metric: "error_count", value: 4, attempt_id: null },
  { run_id: "capsid-r1", namespace: "capsid", metric: "p95_latency_ms", value: 200, attempt_id: null },
  { run_id: "capsid-r1", namespace: "capsid", metric: "bundle_size_bytes", value: 100_000, attempt_id: null },
];

export function report(over: Partial<ScoreReport> = {}): ScoreReport {
  return {
    namespace: "capsid",
    run_id: "capsid-r1",
    attempt_id: "capsid-r1-a01",
    head_sha: "head01",
    jti: "jti-run-01",
    anchors: { build_passes: 1 },
    secondary: {
      test_pass_rate: 0.9,
      lint_count: 5,
      error_count: 4,
      p95_latency_ms: 200,
      bundle_size_bytes: 100_000,
    },
    holdout: { total: 11, passed: 11 },
    ci_minutes: 3,
    ...over,
  };
}

// The archive document the monitor reads, in the shape renderChange writes.
export const CLEAN_CHANGE = "=== src/format.ts (42 bytes, complete new contents) ===\nexport const x = 1;\n";

export async function harness(opts: {
  documents?: FakeD1Options["documents"];
  improveRuns?: FakeD1Options["improveRuns"];
  improveAttempts?: FakeD1Options["improveAttempts"];
  improveScores?: FakeD1Options["improveScores"];
  improveSkills?: FakeD1Options["improveSkills"];
  kv?: Record<string, string>;
  holdoutTotal?: number | null;
  apiKey?: string;
}) {
  const d1 = fakeD1({
    documents: [
      { namespace: "capsid", path: "improve/scores.md", title: "scores", body: SCORES, type: "reference" },
      ...(opts.documents ?? []),
    ],
    namespaces: [{ namespace: "capsid", repos: JSON.stringify([{ repo: "DrDustinEdwards/capsid-mcp", label: "primary" }]) }],
    improveRuns: opts.improveRuns,
    improveAttempts: opts.improveAttempts,
    improveScores: opts.improveScores,
    improveSkills: opts.improveSkills,
  });
  // improve_mode defaults to "api" here, and opts.kv still overrides it. Ingest
  // now refuses when the mode is off, when the namespace is paused, or when the
  // budget is exceeded (2026-09-07, Grok MAJOR 6), so a harness that left the
  // mode unset would make every ingest test assert the refusal instead of the
  // thing it is about. The refusals have their own tests in
  // test/ingest-hardening.test.ts rather than being asserted by accident here.
  const kv = fakeKv({ seed: { improve_mode: "api", "improve:anchor:capsid": await pin(), ...(opts.kv ?? {}) }, seedToken: true });
  const holdout = fakeR2(
    opts.holdoutTotal === null
      ? {}
      : {
          "improve/holdout/capsid/manifest.json": JSON.stringify({
            namespace: "capsid",
            total: opts.holdoutTotal ?? 11,
            updated_at: "2026-09-01T00:00:00Z",
          }),
        }
  );
  const media = fakeR2();
  const env = fakeEnv({
    DB: d1.db,
    APP_KV: kv.kv,
    HOLDOUT: holdout.bucket,
    MEDIA: media.bucket,
    ...(opts.apiKey === undefined ? {} : { ANTHROPIC_API_KEY: opts.apiKey }),
    GITHUB_APP_CLIENT_ID: "x",
    GITHUB_APP_PRIVATE_KEY: "x",
  });
  return { d1, kv, holdout, env };
}

// The Anthropic route. Answers the monitor with "clean" and the abstraction stage
// with "not transferable", keyed on the model so one route serves both.
export const MODEL_ROUTE = {
  "POST /v1/messages": (body: unknown) => {
    const model = String((body as { model?: string })?.model ?? "");
    const payload = model.includes("haiku")
      ? JSON.stringify({ reward_hacking: false, reason: "" })
      : JSON.stringify({ transferable: false, title: "", body: "" });
    return {
      body: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: payload }],
        stop_reason: "end_turn",
        stop_details: null,
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    };
  },
};

export const AWAITING = {
  id: "capsid-r1",
  namespace: "capsid",
  // started IS SET EXPLICITLY. The fake's default is three days before NOW, and
  // without this the six hour age guard fires on every tick test and every one of
  // them fails with "aged out" rather than the thing it was checking. Which is the
  // age guard working, and is why it is set here rather than defaulted.
  started: "2026-09-04 08:00:00",
  status: "awaiting-score",
  attempts: 1,
  current_attempt: "capsid-r1-a01",
  base_sha: "base000",
  advanced_at: "2026-09-04 08:04:00",
};

export const ATTEMPT = {
  id: "capsid-r1-a01",
  namespace: "capsid",
  run_id: "capsid-r1",
  status: "awaiting-score",
  change_summary: "drop a dead branch",
  diff_ref: "improve/archive/capsid-r1/capsid-r1-a01.md",
  branch: "improve/capsid-r1-a01",
  head_sha: "head01",
  base_sha: "base000",
  dispatched_at: "2026-09-04 08:04:00",
};

export const ARCHIVE_DOC = {
  namespace: "capsid",
  path: "improve/archive/capsid-r1/capsid-r1-a01.md",
  title: "improve attempt capsid-r1-a01",
  body: CLEAN_CHANGE,
  type: "reference",
};

// ---- improve_run's control actions -------------------------------------------
//
// For test/improve-control.test.ts and test/improve-driver-lock.test.ts, which each
// held an identical copy. A KV the control actions write, and a D1 that records
// their audit batches.
export function controlHarness(seed: Record<string, string> = {}) {
  const kv = fakeKv({ seed });
  const d1 = fakeD1();
  return { env: fakeEnv({ APP_KV: kv.kv, DB: d1.db }), kv, d1 };
}

export const audited = (d1: ReturnType<typeof fakeD1>) => d1.batches.some((b) => b.some((s) => /INSERT INTO audit_log/.test(s)));
