import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCORE_TIMEOUT_MS } from "../src/improve-schema.ts";

// THE WORKFLOW SUPPLY-CHAIN GUARD (residual 6, closed 2026-09-08).
//
// Two properties, one scan, and both were violated in this repo when it was
// written: restore-rehearsal.yml took actions/checkout@v4 and actions/setup-node@v4
// by TAG, in the job that holds BACKUP_CREDENTIAL_KEY, and not one job in ci.yml or
// restore-rehearsal.yml carried a timeout-minutes.
//
//   pin      a tag is a moving pointer its owner can repoint at any time. These
//            jobs check out this repository and sit beside a job holding Cloudflare
//            credentials and a backup credential that reads the whole corpus.
//   timeout  a job with no timeout-minutes inherits GitHub's 360-minute default, so
//            a hung step burns six hours of the Actions budget the improve loop's
//            kill switch is metered against, and holds the concurrency group.
//
// SCOPE, STATED RATHER THAN IMPLIED: this guard reads THIS repository's workflows.
// The same two properties were fixed by hand in the other five roster repos on
// 2026-09-08 (foxhound ci.yml, foxing ci-cf.yml, germomics ci.yml, capsid-backups
// mirror.yml; dustinedwards-info already satisfied both), and nothing offline can
// assert that from here. A guard scoped to one repo is a guess about where the next
// bug will be written, and this is the half of it that can run.

const WORKFLOWS = join(import.meta.dirname, "..", ".github", "workflows");

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

// Jobs are the two-space keys under `jobs:`. Parsed by indentation rather than with
// a YAML library on purpose: the suite takes no dependencies, and the shape being
// checked is exactly the shape a reader sees.
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

test("the scan is NOT VACUOUS: it finds every workflow and parses jobs out of each", () => {
  const files = workflowFiles();
  assert.ok(files.length >= 3, `only ${files.length} workflow files found; the scan is reading the wrong directory`);
  const parsed = jobs();
  assert.ok(parsed.length >= files.length, `${parsed.length} jobs parsed from ${files.length} workflows`);
  // Every workflow contributes at least one job, so a file whose shape the parser
  // cannot read is a failure rather than a silent zero.
  for (const file of files) {
    assert.ok(
      parsed.some((j) => j.workflow === file.name),
      `no job parsed out of ${file.name}; the guard would pass over it without checking anything`
    );
  }
  // And the pin scan reads something too: an `uses:` count of zero would make the
  // pin assertion below pass against a file it never opened.
  const uses = files.flatMap(({ text }) => [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)]);
  assert.ok(uses.length >= 6, `only ${uses.length} action references found across ${files.length} workflows`);
});

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

test("every job declares timeout-minutes", () => {
  const offenders = jobs()
    .filter((job) => !job.lines.some((l) => /^\s{4,}timeout-minutes:\s*\d+/.test(l)))
    .map((job) => `${job.workflow}:${job.id}`);
  assert.deepEqual(
    offenders,
    [],
    "a job has no timeout-minutes and inherits GitHub's 360-minute default. A hung step burns the Actions budget the improve loop is metered against."
  );
});

test("the two credential-holding jobs are pinned, which is the case this guard was written for", () => {
  // Named explicitly so the guard cannot go quiet by no longer finding these two.
  // The mirror job lives in capsid-backups and is out of reach from here; this is
  // its sibling, and the one that holds BACKUP_CREDENTIAL_KEY in this repo.
  const rehearsal = readFileSync(join(WORKFLOWS, "restore-rehearsal.yml"), "utf8");
  assert.match(rehearsal, /BACKUP_CREDENTIAL_KEY/, "the rehearsal no longer holds the backup credential");
  for (const line of rehearsal.split("\n").filter((l) => /uses:/.test(l))) {
    assert.match(line, /@[0-9a-f]{40}/, `restore-rehearsal.yml takes an action by tag: ${line.trim()}`);
  }
  const deployJob = jobs().find((j) => j.workflow === "ci.yml" && j.id === "deploy");
  assert.ok(deployJob, "ci.yml no longer has a deploy job");
  assert.ok(
    deployJob.lines.some((l) => /timeout-minutes:/.test(l)),
    "the deploy job, which holds CLOUDFLARE_API_TOKEN, has no timeout"
  );
});

// ---- the scorer's clock and the Worker's must not drift apart ---------------
//
// SCORE_TIMEOUT_MS is how long the Worker waits for a dispatched scorer before it
// gives up on the attempt. The scorer workflow has its own ceiling: the sum of the
// timeout-minutes along its longest needs chain. When the Worker's wait is SHORTER
// than that ceiling, a perfectly healthy run that takes its time is declared dead
// while it is still working, and its real report is then discarded as stale.
//
// That is what this repo shipped: 20 minutes against a 25 + 20 workflow. It has
// never fired only because the suites are still small, which is exactly the kind of
// defect that surfaces the first night a repo grows.
//
// The fix was to raise the WORKER's timeout above the workflow's ceiling rather
// than to lower the workflow's. Lowering the workflow kills healthy runs on the
// bigger repos, which turns a slow success into a failure; the Worker's timeout
// exists only to stop a run wedging forever, so making it longer costs nothing but
// a slower recovery from a genuinely lost report.
//
// Both sides are DERIVED here, so neither can be edited without the other.

function timeoutMinutes(job: Job): number | null {
  for (const line of job.lines) {
    const m = /^\s{4,}timeout-minutes:\s*(\d+)/.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

function needsOf(job: Job): string[] {
  for (const line of job.lines) {
    const m = /^\s{4,}needs:\s*(.+)$/.exec(line);
    if (!m) continue;
    return m[1]
      .replace(/[[\]]/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return [];
}

// The longest weighted path through the needs graph: the wall clock a run can take
// with every job using its whole allowance.
function sequentialCeilingMinutes(workflow: string): { minutes: number; jobs: number } {
  const all = jobs().filter((j) => j.workflow === workflow);
  const byId = new Map(all.map((j) => [j.id, j]));
  const seen = new Map<string, number>();
  const cost = (id: string, stack: Set<string>): number => {
    const cached = seen.get(id);
    if (cached !== undefined) return cached;
    const job = byId.get(id);
    if (!job || stack.has(id)) return 0;
    stack.add(id);
    const own = timeoutMinutes(job) ?? 0;
    const upstream = needsOf(job).map((n) => cost(n, stack));
    stack.delete(id);
    const total = own + (upstream.length ? Math.max(...upstream) : 0);
    seen.set(id, total);
    return total;
  };
  const minutes = all.length ? Math.max(...all.map((j) => cost(j.id, new Set()))) : 0;
  return { minutes, jobs: all.length };
}

test("THE SCORER'S OWN CEILING IS READ, not assumed: the parse finds both jobs and their timeouts", () => {
  // The count assertion that stops this guard passing vacuously. A parser that
  // matched nothing would report a ceiling of 0, which every timeout clears.
  const all = jobs().filter((j) => j.workflow === "improve-score.yml");
  assert.equal(all.length, 2, `expected build and score in improve-score.yml, parsed ${all.map((j) => j.id).join(", ")}`);
  for (const job of all) {
    assert.ok(timeoutMinutes(job) !== null, `no timeout-minutes parsed out of improve-score.yml:${job.id}`);
  }
  assert.deepEqual(needsOf(all.find((j) => j.id === "score")!), ["build"], "the score job's needs chain was not parsed");
  const { minutes } = sequentialCeilingMinutes("improve-score.yml");
  assert.ok(minutes >= 40, `the parsed sequential ceiling is ${minutes} minutes, which is too small to be the real one`);
});

test("SCORE_TIMEOUT_MS EXCEEDS THE SCORER WORKFLOW'S OWN SEQUENTIAL CEILING", () => {
  const { minutes } = sequentialCeilingMinutes("improve-score.yml");
  const workerMinutes = SCORE_TIMEOUT_MS / 60_000;
  assert.ok(
    workerMinutes > minutes,
    `the Worker gives a dispatched scorer ${workerMinutes} minutes and the workflow may take ${minutes}. ` +
      `A healthy run is declared timed out and its real report is discarded as stale. ` +
      `Raise SCORE_TIMEOUT_MS in src/improve-schema.ts above ${minutes} minutes, or lower the workflow's timeout-minutes.`
  );
});

// ---- the job that runs attempt code caches nothing it can write -------------
//
// Job A checks out the ATTEMPT branch and executes its code. An actions/cache step
// there would persist whatever that code wrote and restore it into later runs, and
// because dispatchWorkflow dispatches the scorer at the DEFAULT branch ref, the
// cache lands in the default branch's scope where every later run in the repository
// restores it, Job B included. That is a write path from an attempt into the
// dependencies of the thing measuring it.
//
// WHAT IS BANNED IS A DIRECTORY ATTEMPT CODE CAN WRITE, not caching as such
// (ruled 2026-09-16). setup-node's `cache: npm` stays: it caches npm's
// content-addressed download cache, whose entries are verified against the
// integrity hashes in the lockfile, and an attempt cannot forge a package that
// passes that check. node_modules and build output are the opposite: they are
// executed directly, with nothing verifying them.
//
// SCOPE: this reads THIS repository's copy. Job A is per-repo by design, so the
// other four copies are guarded by the same test in their own repos, exactly as
// test/sync-scorer.test.ts splits what can run offline from what needs the clones.

const WRITABLE_CACHE_DIR = /(^|[\s"'`|/])(node_modules|dist|build|out|coverage|\.next|\.output|\.improve-build)(\s|\/|$)/;

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

function buildJob(): Job {
  const job = jobs().find((j) => j.workflow === "improve-score.yml" && j.id === "build");
  assert.ok(job, "no build job parsed out of improve-score.yml");
  return job;
}

test("THE JOB A SCAN IS NOT VACUOUS: it parses the build job's steps and sees the cache directive that IS allowed", () => {
  const job = buildJob();
  const steps = stepsOf(job);
  assert.ok(steps.length >= 5, `only ${steps.length} steps parsed out of the build job`);
  // The strongest non-vacuity check available: the allowed directive is known to be
  // in this job, so a parser reading the wrong region fails here rather than
  // reporting a clean scan of nothing.
  assert.ok(
    job.lines.some((l) => /^\s+cache:\s*npm\s*$/.test(l)),
    "setup-node's `cache: npm` was not found in the build job; the scan is reading the wrong region"
  );
});

test("JOB A CACHES NO DIRECTORY ATTEMPT CODE CAN WRITE", () => {
  const job = buildJob();
  const offenders: string[] = [];
  let cacheSteps = 0;
  for (const step of stepsOf(job)) {
    const uses = step.find((l) => /uses:\s*\S*actions\/cache(\/(restore|save))?@/.test(l));
    if (!uses) continue;
    cacheSteps += 1;
    const paths = step.filter((l) => WRITABLE_CACHE_DIR.test(l));
    if (paths.length > 0) {
      offenders.push(`${job.workflow}:${job.id} caches ${paths.map((p) => p.trim()).join(", ")}`);
      continue;
    }
    // FAIL CLOSED: a cache step whose paths this test cannot read is not a pass.
    if (!step.some((l) => /^\s+path:/.test(l))) {
      offenders.push(`${job.workflow}:${job.id} has an actions/cache step with no readable path block`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "the job that runs attempt code is caching a directory that code can write. " +
      "It would be saved at the end of the job and restored into every later run in this repository, Job B included. " +
      `setup-node's cache: npm is exempt and is not counted here; ${cacheSteps} actions/cache step(s) were examined.`
  );
});

test("JOB B IS WHERE CACHING BELONGS, and it caches node_modules on an exact key", () => {
  // The other half of the same rule. If this disappears the loop silently pays for
  // an install on every scored attempt, and the guard above would still be green.
  const job = jobs().find((j) => j.workflow === "improve-score.yml" && j.id === "score");
  assert.ok(job, "no score job parsed out of improve-score.yml");
  const text = job.lines.join("\n");
  assert.match(text, /uses:\s*actions\/cache@[0-9a-f]{40}/, "Job B has no pinned actions/cache step");
  assert.match(text, /^\s+node_modules\s*$/m, "Job B's cache does not name node_modules");
  assert.doesNotMatch(text, /restore-keys:/, "Job B uses restore-keys; a near miss could half-restore and then skip the install");
  assert.match(
    text,
    /if:\s*steps\.deps\.outputs\.cache-hit\s*!=\s*'true'/,
    "the install step is not gated on an exact cache hit, so the cache saves nothing"
  );
});
