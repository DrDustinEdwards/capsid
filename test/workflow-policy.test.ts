import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// The workflow policy: every text scan of .github/workflows/, with one parser.
//
// Every scan reaches a job or a step through jobs(), jobNamed() and stepsOf(),
// which fail when the thing they look for is missing, so a renamed step cannot leave
// a scan reading an empty string and passing on nothing.
//
// Nothing offline can run these workflows, so the policy is checked as text. This
// reads only this repository's workflows.

const ROOT = join(import.meta.dirname, "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

interface Job {
  workflow: string;
  id: string;
  lines: string[];
}

function workflowFiles(): Array<{ name: string; text: string }> {
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(WORKFLOWS, name), "utf8") }));
}

// Jobs are the two-space keys under `jobs:`. Parsed by indentation because the suite
// takes no dependencies.
function jobs(): Job[] {
  const found: Job[] = [];
  for (const { name, text } of workflowFiles()) {
    const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
    const start = lines.findIndex((l) => l === "jobs:");
    if (start === -1) continue;
    let current: Job | null = null;
    for (const line of lines.slice(start + 1)) {
      const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (header) {
        if (current) found.push(current);
        current = { workflow: name, id: header[1], lines: [] };
      } else if (current) {
        current.lines.push(line);
      }
    }
    if (current) found.push(current);
  }
  return found;
}

function jobNamed(workflow: string, id: string): Job {
  const job = jobs().find((j) => j.workflow === workflow && j.id === id);
  assert.ok(job, `no ${id} job parsed out of ${workflow}`);
  return job;
}

const jobText = (job: Job): string => job.lines.join("\n");

// Steps are the six-space list items of a job.
function stepsOf(job: Job): string[][] {
  const steps: string[][] = [];
  let current: string[] | null = null;
  for (const line of job.lines) {
    if (/^ {6}- /.test(line)) {
      if (current) steps.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) steps.push(current);
  return steps;
}

const stepName = (step: string[]): string => /^ {6}- name:\s*(.+)$/.exec(step[0])?.[1].trim() ?? "";

test("the scan is NOT VACUOUS: it finds every workflow and parses jobs out of each", () => {
  const files = workflowFiles();
  assert.ok(files.length >= 3, `only ${files.length} workflow files found; the scan is reading the wrong directory`);
  const parsed = jobs();
  assert.ok(parsed.length >= files.length, `${parsed.length} jobs parsed from ${files.length} workflows`);
  // A file whose shape the parser cannot read fails here rather than counting zero.
  for (const file of files) {
    assert.ok(
      parsed.some((j) => j.workflow === file.name),
      `no job parsed out of ${file.name}; the guard would pass over it without checking anything`
    );
  }
  // A `uses:` count of zero would make the pin assertion pass vacuously.
  const uses = files.flatMap(({ text }) => [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)]);
  assert.ok(uses.length >= 6, `only ${uses.length} action references found across ${files.length} workflows`);
  // ci.yml's checks job parses into named steps, which the lint scan below reads.
  const named = stepsOf(jobNamed("ci.yml", "checks")).filter((s) => stepName(s) !== "");
  assert.ok(named.length >= 5, `only ${named.length} named steps parsed out of ci.yml:checks`);
});

// Supply chain: pins and timeouts.
//
//   pin      a tag is a moving pointer its owner can repoint at any time, and these
//            jobs sit beside jobs holding Cloudflare and backup credentials.
//   timeout  a job with no timeout-minutes inherits GitHub's 360-minute default, so
//            a hung step burns the Actions budget and holds the concurrency group.

test("every third-party action is pinned by commit sha, never by tag", () => {
  const offenders: string[] = [];
  for (const { name, text } of workflowFiles()) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const m = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
      if (!m) return;
      const ref = m[1];
      // A local action (./path) and a reusable workflow in this repo are this
      // repository's own bytes and carry no upstream pointer to repoint.
      if (ref.startsWith("./")) return;
      const at = ref.lastIndexOf("@");
      const version = at === -1 ? "" : ref.slice(at + 1);
      if (!/^[0-9a-f]{40}$/.test(version)) {
        offenders.push(`${name}:${i + 1} ${ref}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "an action is referenced by tag. A tag is a moving pointer; pin the commit sha and leave the version in a trailing comment."
  );
});

// A job that calls a reusable workflow (a `uses:` of its own) cannot carry
// timeout-minutes: GitHub refuses the key there, and the called workflow's jobs declare
// their own (devkit's ai-author.yml and no-bloat.yml do).
const callsWorkflow = (job: Job): boolean => job.lines.some((l) => /^ {4}uses:\s*\S+\/\.github\/workflows\/\S+\.ya?ml@/.test(l));

test("every job declares timeout-minutes", () => {
  const offenders = jobs()
    .filter((job) => !callsWorkflow(job))
    .filter((job) => !job.lines.some((l) => /^\s{4,}timeout-minutes:\s*\d+/.test(l)))
    .map((job) => `${job.workflow}:${job.id}`);
  assert.deepEqual(
    offenders,
    [],
    "a job has no timeout-minutes and inherits GitHub's 360-minute default. A hung step burns the Actions budget."
  );
});

// The lints still run in CI.
//
// The checks in test/lint/ are not in `npm test`; ci.yml is the only thing that runs
// them. The step is not on the auto-merge policy's required list, so it must come
// before the required Tests step: its failure skips Tests, and a skipped required
// step refuses the merge.

test("the checks job runs npm run lint, before the Tests step", () => {
  const steps = stepsOf(jobNamed("ci.yml", "checks")).map((s) => ({ name: stepName(s), text: s.join("\n") }));
  const lint = steps.findIndex((s) => /^\s+run:\s*npm run lint\s*$/m.test(s.text));
  const tests = steps.findIndex((s) => s.name === "Tests");
  assert.ok(lint >= 0, "no step in ci.yml's checks job runs `npm run lint`; the lints in test/lint/ run nowhere");
  assert.ok(tests >= 0, "no Tests step parsed out of ci.yml's checks job");
  assert.ok(lint < tests, "the lint step runs after Tests, so its failure no longer stops a merge");
  assert.doesNotMatch(steps[lint].text, /continue-on-error/, "the lint step must fail the job");
});

// The restore rehearsal (Grok audit 2026-10, P1 and U4). It mints bucket keys and reads
// a prefix out of the bucket listing, so neither may reach the log or a shell unchecked.

function rehearsalStep(name: string): string {
  const [job] = jobs().filter((j) => j.workflow === "restore-rehearsal.yml");
  assert.ok(job, "no job parsed out of restore-rehearsal.yml");
  const step = stepsOf(job).find((s) => stepName(s) === name);
  assert.ok(step, `no step named ${name} in restore-rehearsal.yml`);
  return step.join("\n");
}

test("PLANT: the rehearsal masks each minted AWS value before it exports them", () => {
  const pull = rehearsalStep("Mint a credential and pull the newest dump");
  const exportAt = pull.search(/^\s+export AWS_ACCESS_KEY_ID\b/m);
  assert.ok(exportAt > -1, "the pull step no longer exports the minted keys; this test is stale");
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
    const maskAt = pull.indexOf(`echo "::add-mask::\${${name}}"`);
    assert.ok(maskAt > -1, `${name} is never masked`);
    assert.ok(maskAt < exportAt, `${name} is masked only after it is exported`);
  }
});

test("PLANT: the rehearsal's run prefix reaches a run block only through env, after a character check", () => {
  const text = workflowFiles().find((f) => f.name === "restore-rehearsal.yml")?.text ?? "";
  const runLines = text.split("\n").filter((l) => /^\s+run:/.test(l) || /^\s{10,}\S/.test(l));
  const interpolated = runLines.filter((l) => /\$\{\{\s*steps\./.test(l) && !/^\s+[A-Z_]+:\s*\$\{\{/.test(l));
  assert.deepEqual(interpolated, [], "a step output is interpolated into a shell line");
  const pull = rehearsalStep("Mint a credential and pull the newest dump");
  const checkAt = pull.indexOf("=~ ^[A-Za-z0-9_./-]+$");
  const outputAt = pull.indexOf("run_prefix=");
  assert.ok(checkAt > -1, "the run prefix is not checked against a path character set");
  assert.ok(checkAt < outputAt, "the run prefix is written to the step output before it is checked");
  assert.match(rehearsalStep("Check the dump's own invariants"), /RUN_PREFIX: \$\{\{ steps\.pull\.outputs\.run_prefix \}\}/);
});
