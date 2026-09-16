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
