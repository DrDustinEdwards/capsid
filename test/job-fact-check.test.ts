import assert from "node:assert/strict";
import { test } from "node:test";
import { adminAgentForEmail } from "../src/agents.ts";
import { editJob } from "../src/jobs-edit.ts";
import { checkBodyFacts, factClaims, type FactReaders } from "../src/job-fact-check.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// Improvement 24: a body that states a pull request merged, a version tagged or a package
// version published is checked against GitHub and npm at post and edit. job_d62abdbfc270
// was told Enarratio 0.3.0 was on npm while it was only staged.

const kinds = (body: string) => factClaims(body).map((c) => `${c.kind}:${c.kind === "merged" ? `${c.repo ?? ""}#${c.number}` : `${c.name ?? ""}@${c.version}`}`);

test("claims stated as done are parsed", () => {
  assert.deepEqual(kinds("#12 is merged."), ["merged:#12"]);
  assert.deepEqual(kinds("We merged #12 and #13 yesterday."), ["merged:#12", "merged:#13"]);
  assert.deepEqual(kinds("- #14 merged"), ["merged:#14"]);
  assert.deepEqual(kinds("https://github.com/acme/widget/pull/7 was merged."), ["merged:acme/widget#7"]);
  assert.deepEqual(kinds("Tagged v1.2.0 this morning."), ["tagged:@v1.2.0"]);
  assert.deepEqual(kinds("v1.2.0 has been tagged."), ["tagged:@v1.2.0"]);
  assert.deepEqual(kinds("Published 0.3.0 to npm."), ["published:@0.3.0"]);
  assert.deepEqual(kinds("Enarratio 0.3.0 was on npm while the docs lagged."), ["published:Enarratio@0.3.0"]);
  assert.deepEqual(kinds("sample-pkg@2.0.1 is published."), ["published:sample-pkg@2.0.1"]);
  assert.deepEqual(kinds("Published version 1.0.0 to npm."), ["published:@1.0.0"]);
});

test("plans, conditions, questions and negations are not claims", () => {
  for (const body of [
    "Merge #12.",
    "Once 0.3.0 is published, update the docs.",
    "After tagging v1.2.0, open the release.",
    "#12 will be merged tonight.",
    "0.3.0 is not published yet.",
    "#12 isn't merged.",
    "Is #12 merged?",
    "Make sure #12 is merged.",
    "Confirm v1.2.0 is tagged.",
    "Publish 0.3.0 to npm.",
    "If #12 is merged, close the job.",
    "The seat said 0.3.0 is on npm.",
    "#12 should be merged first.",
  ]) {
    assert.deepEqual(kinds(body), [], body);
  }
});

test("code, fences, quotes, block quotes and the DONE WHEN and OUT OF SCOPE parts are exempt", () => {
  const body = [
    "GOAL: write the notes",
    "```",
    "#12 is merged",
    "```",
    "~~~external source=review ref=1",
    "0.3.0 is published to npm",
    "~~~",
    "Quote: `v1.2.0 is tagged`.",
    'He wrote "#9 is merged" earlier.',
    "> #8 is merged",
    "DONE WHEN:",
    "- #12 is merged",
    "- 0.3.0 is on npm",
    "OUT OF SCOPE: tagged v9.9.9",
    "RULES: none",
  ].join("\n");
  assert.deepEqual(kinds(body), []);
  // A part after DONE WHEN is read again.
  assert.deepEqual(kinds("DONE WHEN: #1 is merged\nDECIDED: #2 is merged"), ["merged:#2"]);
});

test("a claim carries its line and its words", () => {
  const [claim] = factClaims("GOAL: x\n- #14 merged");
  assert.equal(claim.line, 2);
  assert.equal(claim.said, "#14 merged");
});

// ---- Checking against injected readers --------------------------------------------------

function readers(over: Partial<FactReaders> = {}, calls: string[] = []): FactReaders {
  return {
    repos: async () => ({ ok: true, value: ["acme/widget"] }),
    packages: async () => ({ ok: true, value: [{ name: "@acme/enarratio", repo: "acme/widget" }] }),
    pull: async (repo, n) => {
      calls.push(`pull ${repo}#${n}`);
      return { ok: true, value: n === 12 ? { merged: true, state: "closed" } : { merged: false, state: "open" } };
    },
    tag: async (repo, tag) => {
      calls.push(`tag ${repo} ${tag}`);
      return { ok: true, value: tag === "v1.2.0" };
    },
    npm: async (name) => {
      calls.push(`npm ${name}`);
      return { ok: true, value: name === "@acme/enarratio" ? ["0.1.0", "0.2.0"] : null };
    },
    ...over,
  };
}

test("true claims pass with no warning", async () => {
  const calls: string[] = [];
  const out = await checkBodyFacts("sample", "#12 is merged. Tagged v1.2.0. Published 0.2.0 to npm.", readers({}, calls));
  assert.deepEqual(out, { refusal: null, warnings: [] });
  assert.deepEqual(calls, ["pull acme/widget#12", "tag acme/widget v1.2.0", "npm @acme/enarratio"]);
});

test("the Enarratio case is refused, naming the claim and what npm lists", async () => {
  const out = await checkBodyFacts("sample", "GOAL: docs\nEnarratio 0.3.0 was on npm.", readers());
  assert.ok(out.refusal);
  assert.match(out.refusal, /line 2, "Enarratio 0\.3\.0 was on npm"/);
  assert.match(out.refusal, /npm lists no version 0\.3\.0 of @acme\/enarratio \(the last it lists: 0\.1\.0, 0\.2\.0\)/);
  assert.match(out.refusal, /code block or an external fence/);
});

test("an open pull request said to be merged and a missing tag are refused", async () => {
  const pr = await checkBodyFacts("sample", "#13 is merged.", readers());
  assert.match(pr.refusal ?? "", /acme\/widget#13 open, not merged/);
  const tag = await checkBodyFacts("sample", "v2.0.0 is tagged.", readers());
  assert.match(tag.refusal ?? "", /no tag v2\.0\.0, 2\.0\.0 exists in acme\/widget/);
  const pkg = await checkBodyFacts("sample", "nosuch@1.0.0 is published.", readers());
  assert.match(pkg.refusal ?? "", /npm has no package nosuch/);
});

test("a claim that could not be read is a warning, never a refusal", async () => {
  const failing = readers({
    pull: async () => ({ ok: false, reason: "GitHub answered 502" }),
    tag: async () => ({ ok: false, reason: "GitHub answered 502" }),
    npm: async () => ({ ok: false, reason: "registry.npmjs.org answered 503" }),
  });
  const out = await checkBodyFacts("sample", "#13 is merged. v9.0.0 is tagged. Published 9.0.0 to npm.", failing);
  assert.equal(out.refusal, null);
  assert.equal(out.warnings.length, 3);
  assert.match(out.warnings[0], /could not check line 1, "#13 is merged": GitHub answered 502\. Not refused/);
});

test("an unmapped repo, an ambiguous number and an unknown package are warnings", async () => {
  const unmapped = await checkBodyFacts("sample", "https://github.com/other/repo/pull/3 is merged.", readers());
  assert.equal(unmapped.refusal, null);
  assert.match(unmapped.warnings[0], /other\/repo is not a repo sample maps/);
  const two = await checkBodyFacts("sample", "#13 is merged.", readers({ repos: async () => ({ ok: true, value: ["acme/a", "acme/b"] }) }));
  assert.equal(two.refusal, null);
  assert.match(two.warnings[0], /maps 2 repos/);
  const unknown = await checkBodyFacts("sample", "Widget 9.0.0 is on npm.", readers());
  assert.equal(unknown.refusal, null);
  assert.match(unknown.warnings[0], /no package configured in the Portal is named Widget/);
});

test("published without npm and naming no known package is not read at all", async () => {
  const calls: string[] = [];
  const out = await checkBodyFacts("sample", "Widget 9.0.0 is published.", readers({}, calls));
  assert.deepEqual(out, { refusal: null, warnings: [] });
  assert.deepEqual(calls, []);
});

test("a body with no claims reads nothing", async () => {
  const calls: string[] = [];
  const out = await checkBodyFacts("sample", "GOAL: x\nDO: merge #12 and publish 0.3.0", readers({ repos: async () => assert.fail("read") }, calls));
  assert.deepEqual(out, { refusal: null, warnings: [] });
  assert.deepEqual(calls, []);
});

test("the claims and reads one body spends are bounded", async () => {
  const calls: string[] = [];
  const body = Array.from({ length: 14 }, (_, i) => `#${100 + i} is merged.`).join("\n");
  const out = await checkBodyFacts("sample", body, readers({ pull: async (r, n) => (calls.push(`${n}`), { ok: true, value: { merged: true, state: "closed" } }) }));
  assert.equal(calls.length, 10);
  assert.match(out.warnings.at(-1) ?? "", /states 14 .* the first 10 were checked/);
  // A tag claim tries two spellings in each mapped repo, so across two repos the 20 reads
  // run out after five claims, and the rest are warnings, not refusals.
  const tags = Array.from({ length: 8 }, (_, i) => `v3.0.${i} is tagged.`).join("\n");
  const tagCalls: string[] = [];
  const bounded = await checkBodyFacts("sample", tags, readers({ repos: async () => ({ ok: true, value: ["acme/a", "acme/b"] }) }, tagCalls));
  assert.equal(tagCalls.length, 20);
  assert.equal(bounded.refusal?.match(/no tag v3\.0\.\d/g)?.length, 5);
  assert.equal(bounded.warnings.length, 3);
  assert.match(bounded.warnings[0], /limit of 20 reads/);
});

// ---- Wiring --------------------------------------------------------------------------

test("edit refuses a body whose pull request GitHub shows open", async () => {
  const env = fakeEnv({
    IMPROVE_SCORE_SECRET: "test-secret",
    DB: fakeD1({
      namespaces: [{ namespace: "sample", repos: JSON.stringify([{ repo: "owner/repo", label: "primary" }]) }],
      jobs: [{ id: "job_x", namespace: "sample", title: "t", body: "old", status: "queued", priority: 0, gate_required: 0 }],
    }).db,
    APP_KV: fakeKv({ seed: { "gh:token:v3:owner/repo": "test-token" } }).kv,
  });
  await withFetch({ "GET /repos/owner/repo/pulls/12": { body: { state: "open", merged: false, merged_at: null } } }, async (calls) => {
    const out = await editJob(env, adminAgentForEmail("admin@example.com"), new Date("2026-10-18T00:00:00Z"), "job_x", { body: "GOAL: x\n#12 is merged." });
    assert.equal(out.ok, false);
    assert.match(out.refusal ?? "", /owner\/repo#12 open, not merged/);
    assert.deepEqual(calls.map((c) => c.path), ["/repos/owner/repo/pulls/12"]);
  });
});
