import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCORE_TIMEOUT_MS } from "../src/improve-schema.ts";

// The workflow policy: every text scan of .github/workflows/, with one parser.
//
// Every scan reaches a job or a step through jobs(), jobNamed() and stepNamed(),
// which fail when the thing they look for is missing, so a renamed step cannot leave
// a scan reading an empty string and passing on nothing.
//
// Nothing offline can run these workflows, so the policy is checked as text. The
// behaviour checks (the scorer's stream parsing and the sandbox recompute run as a
// process) are in test/scorer-isolation.test.ts and test/secondary-recompute.test.ts.
// This reads only this repository's workflows.

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

// The one step whose name starts with `prefix`, as text. Exactly one, so a renamed
// step fails here instead of leaving the scan with nothing to read.
function stepNamed(job: Job, prefix: string): string {
  const matches = stepsOf(job).filter((s) => stepName(s).startsWith(prefix));
  assert.equal(matches.length, 1, `expected one step named "${prefix}..." in ${job.workflow}:${job.id}, found ${matches.length}`);
  return matches[0].join("\n");
}

// Strips YAML comments and shell comments inside run: blocks (both start a line with
// '#'), because workflow comments quote old attacks verbatim and must not count as
// commands.
const executable = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

const SCORER_WORKFLOW = "improve-score.yml";
const WORKFLOW = readFileSync(join(WORKFLOWS, SCORER_WORKFLOW), "utf8");
const EXECUTABLE = executable(WORKFLOW);

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
  // The scorer's two jobs parse into named steps, which every scorer scan below reads.
  for (const id of ["build", "score"]) {
    const named = stepsOf(jobNamed(SCORER_WORKFLOW, id)).filter((s) => stepName(s) !== "");
    assert.ok(named.length >= 5, `only ${named.length} named steps parsed out of ${SCORER_WORKFLOW}:${id}`);
  }
});

// Supply chain: pins and timeouts.
//
//   pin      a tag is a moving pointer its owner can repoint at any time, and these
//            jobs sit beside jobs holding Cloudflare and backup credentials.
//   timeout  a job with no timeout-minutes inherits GitHub's 360-minute default, so
//            a hung step burns the Actions budget the improve loop's kill switch is
//            metered against, and holds the concurrency group.

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

// The scorer's clock and the Worker's must not drift apart.
//
// SCORE_TIMEOUT_MS is how long the Worker waits for a dispatched scorer. The scorer
// workflow's own ceiling is the sum of the timeout-minutes along its longest needs
// chain. When the Worker's wait is shorter, a healthy slow run is declared dead and
// its real report is discarded as stale. The Worker's timeout is the side to raise:
// lowering the workflow's kills healthy runs on the bigger repos.
//
// Both sides are derived here, so neither can be edited without the other.

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
  // A parser that matched nothing would report a ceiling of 0, which every timeout clears.
  const all = jobs().filter((j) => j.workflow === SCORER_WORKFLOW);
  assert.equal(all.length, 2, `expected build and score in ${SCORER_WORKFLOW}, parsed ${all.map((j) => j.id).join(", ")}`);
  for (const job of all) {
    assert.ok(timeoutMinutes(job) !== null, `no timeout-minutes parsed out of ${SCORER_WORKFLOW}:${job.id}`);
  }
  assert.deepEqual(needsOf(jobNamed(SCORER_WORKFLOW, "score")), ["build"], "the score job's needs chain was not parsed");
  const { minutes } = sequentialCeilingMinutes(SCORER_WORKFLOW);
  assert.ok(minutes >= 40, `the parsed sequential ceiling is ${minutes} minutes, which is too small to be the real one`);
});

test("SCORE_TIMEOUT_MS EXCEEDS THE SCORER WORKFLOW'S OWN SEQUENTIAL CEILING", () => {
  const { minutes } = sequentialCeilingMinutes(SCORER_WORKFLOW);
  const workerMinutes = SCORE_TIMEOUT_MS / 60_000;
  assert.ok(
    workerMinutes > minutes,
    `the Worker gives a dispatched scorer ${workerMinutes} minutes and the workflow may take ${minutes}. ` +
      `A healthy run is declared timed out and its real report is discarded as stale. ` +
      `Raise SCORE_TIMEOUT_MS in src/improve-schema.ts above ${minutes} minutes, or lower the workflow's timeout-minutes.`
  );
});

// The job that runs attempt code caches nothing it can write.
//
// Job A checks out the attempt branch and executes its code. The scorer is
// dispatched at the default branch ref, so an actions/cache step there would land
// in the default branch's scope and be restored into every later run, Job B
// included: a write path from an attempt into the thing measuring it.
//
// Banned is a directory attempt code can write, not caching as such. setup-node's
// `cache: npm` stays: its entries are verified against the lockfile's integrity
// hashes. node_modules and build output are executed with nothing verifying them.

const WRITABLE_CACHE_DIR = /(^|[\s"'`|/])(node_modules|dist|build|out|coverage|\.next|\.output|\.improve-build)(\s|\/|$)/;

test("THE JOB A SCAN IS NOT VACUOUS: it parses the build job's steps and sees the cache directive that IS allowed", () => {
  const job = jobNamed(SCORER_WORKFLOW, "build");
  const steps = stepsOf(job);
  assert.ok(steps.length >= 5, `only ${steps.length} steps parsed out of the build job`);
  // The allowed directive is known to be in this job, so a parser reading the wrong
  // region fails here rather than reporting a clean scan of nothing.
  assert.ok(
    job.lines.some((l) => /^\s+cache:\s*npm\s*$/.test(l)),
    "setup-node's `cache: npm` was not found in the build job; the scan is reading the wrong region"
  );
});

test("JOB A CACHES NO DIRECTORY ATTEMPT CODE CAN WRITE", () => {
  const job = jobNamed(SCORER_WORKFLOW, "build");
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
  // Without this cache the loop pays for an install on every scored attempt, and the
  // guard above would still pass.
  const text = jobText(jobNamed(SCORER_WORKFLOW, "score"));
  assert.match(text, /uses:\s*actions\/cache@[0-9a-f]{40}/, "Job B has no pinned actions/cache step");
  assert.match(text, /^\s+node_modules\s*$/m, "Job B's cache does not name node_modules");
  assert.doesNotMatch(text, /restore-keys:/, "Job B uses restore-keys; a near miss could half-restore and then skip the install");
  assert.match(
    text,
    /if:\s*steps\.deps\.outputs\.cache-hit\s*!=\s*'true'/,
    "the install step is not gated on an exact cache hit, so the cache saves nothing"
  );
});

// Scorer isolation. Three attacks, and where each is stopped:
//
//   1. Attempt code writes code/scripts/improve-report.mjs so an overlay replaces
//      the scorer that holds IMPROVE_SCORE_KEY. Stopped by Job A wiping code/, Job B
//      never overlaying anything, and the trusted script being stashed outside the
//      workspace before any untrusted byte exists.
//   2. Planted .improve-holdout/*.test.* files count as passes. Stopped by wiping
//      the holdout directory before the sync and keeping it outside the workspace.
//   3. Attempt code rewrites a seekable holdout TAP file after the reporter flushes.
//      Stopped by having no destination file: TAP is a stdout pipe out of a
//      --network none --read-only container.

const CONTAINER_STEP = "Run the holdout suite";

test("PLANT: Job B never overlays attempt code onto the runner", () => {
  assert.ok(
    !/cp -r attempt\/code\/\.\s/.test(EXECUTABLE),
    "the whole-tree overlay `cp -r attempt/code/. .` is what let an attempt replace scripts/improve-report.mjs; it must not exist"
  );
  assert.ok(
    !/Overlay the attempt source/.test(EXECUTABLE),
    "the overlay step must be gone entirely, not renamed"
  );
});

test("the trusted scorer is stashed outside the workspace and only that copy is invoked", () => {
  assert.match(
    WORKFLOW,
    /cp scripts\/improve-report\.mjs "\$\{RUNNER_TEMP\}\/trusted\/improve-report\.mjs"/,
    "the trusted script must be copied out before anything untrusted lands"
  );
  // Every invocation in the score job must go through the stash.
  const scoreJob = jobText(jobNamed(SCORER_WORKFLOW, "score"));
  const invocations = [...scoreJob.matchAll(/improve-report\.mjs/g)];
  assert.ok(invocations.length >= 3, "expected the stash copy plus at least two uses");
  const workspaceInvocation = /\bnode\s+scripts\/improve-report\.mjs/.test(scoreJob);
  assert.ok(!workspaceInvocation, "the score job must never invoke the workspace copy of the scorer script");
});

test("Job A wipes the staging directory before staging", () => {
  assert.match(
    jobText(jobNamed(SCORER_WORKFLOW, "build")),
    /rm -rf code\s*\n\s*mkdir -p code/,
    "without `rm -rf code` first, attempt code that created code/scripts during the test step rides into the artifact"
  );
});

test("the holdout directory is wiped before the sync and lives outside the workspace", () => {
  assert.match(WORKFLOW, /rm -rf "\$\{RUNNER_TEMP\}\/holdout"/, "a stale or planted case file must not survive into the count");
  assert.match(WORKFLOW, /aws s3 sync "s3:\/\/\$\{HOLDOUT_BUCKET\}\/\$\{HOLDOUT_PREFIX\}" "\$\{RUNNER_TEMP\}\/holdout\/"/);
  assert.ok(
    !/aws s3 sync .* \.improve-holdout/.test(EXECUTABLE),
    "the holdout must not be synced into the workspace, where an overlay could reach it"
  );
});

test("attempt code runs only inside a network-less, read-only, digest-pinned container", () => {
  assert.match(WORKFLOW, /docker run --rm/, "the holdout must run in a container");
  assert.match(WORKFLOW, /--network none/, "no network: nothing the attempt learns can leave");
  assert.match(WORKFLOW, /--read-only/, "read-only root: bind mounts stay immutable");
  assert.match(WORKFLOW, /--tmpfs \/work:rw/, "the only writable surface is scratch that dies with the run");
  assert.match(
    WORKFLOW,
    /node:24\.14\.1-bookworm@sha256:[0-9a-f]{64}/,
    "the image must be pinned by digest, not by tag"
  );
  // The full image, not slim, because it carries git: tests that shell out to git
  // need it, and apt-get cannot run behind --network none.
  assert.ok(!/node:[\d.]+-bookworm-slim/.test(EXECUTABLE), "slim carries no git, and a test that shells out to it fails for the environment");
  // glibc, not musl: the container mounts node_modules installed on the Ubuntu
  // runner, and on Alpine every package with a native binary looks for its musl
  // build and finds only the gnu one.
  assert.ok(!/node:[\d.]+-alpine/.test(EXECUTABLE), "an Alpine image cannot load the runner's native modules");
  for (const mount of [
    /-v "\$\{RUNNER_TEMP\}\/attempt\/code:\/attempt:ro"/,
    /-v "\$\{RUNNER_TEMP\}\/holdout:\/holdout:ro"/,
    /-v "\$\{RUNNER_TEMP\}\/trusted:\/trusted:ro"/,
    // The whole default-branch checkout, read-only: the sandbox runs the repo's own
    // test and lint commands, which need its tests, configs and node_modules, and
    // those protected paths come from the trusted checkout, not the artifact.
    /-v "\$\{GITHUB_WORKSPACE\}:\/repo:ro"/,
  ]) {
    assert.match(WORKFLOW, mount, `every bind mount must be read-only: ${mount}`);
  }
  assert.ok(
    !/-v "\$\{GITHUB_WORKSPACE\}:\/[a-z-]+"(?!:ro)/.test(EXECUTABLE),
    "no writable workspace mount"
  );
});

test("the holdout TAP has no seekable destination the attempt can rewrite", () => {
  assert.ok(
    !/--test-reporter-destination/.test(executable(jobText(jobNamed(SCORER_WORKFLOW, "score")))),
    "a destination file inside the attempt's filesystem is what attack 3 rewrote; results must come out as a pipe"
  );
  assert.match(WORKFLOW, /> "\$\{RUNNER_TEMP\}\/holdout\.tap"/, "the pipe is captured outside the container");
  assert.match(WORKFLOW, /--holdout-stream "\$\{RUNNER_TEMP\}\/holdout\.tap"/, "and counted by the trusted stash copy");
});

test("PLANT: a rewritten metrics.json cannot set the build_passes anchor", () => {
  // The artifact is written on a runner that has already executed attempt code, so
  // build_passes must come from Job A's job output, set from the build step's outcome.
  assert.match(
    WORKFLOW,
    /build_passes: \$\{\{ steps\.build\.outcome == 'success' && '1' \|\| '0' \}\}/,
    "Job A must export build_passes as a job output from the step outcome"
  );
  assert.match(
    WORKFLOW,
    /BUILD_PASSES: \$\{\{ needs\.build\.outputs\.build_passes \}\}/,
    "the Post step must read the anchor from the job output"
  );
  const report = readFileSync(join(ROOT, "scripts", "improve-report.mjs"), "utf8");
  assert.match(
    report,
    /process\.env\.BUILD_PASSES === "1" \? 1 : 0/,
    "the body builder must take the anchor from the environment, never from the parsed artifact"
  );
  assert.ok(
    !/m\.build_passes/.test(report),
    "metrics.json's build_passes field must no longer be read at all"
  );
});

test("no step but the signing step and the credential mint sees the key", () => {
  const score = jobNamed(SCORER_WORKFLOW, "score");
  const secret = /IMPROVE_SCORE_KEY: \$\{\{ secrets\.IMPROVE_SCORE_KEY \}\}/;
  const holding = stepsOf(score)
    .filter((step) => secret.test(step.join("\n")))
    .map(stepName);
  assert.deepEqual(
    holding,
    ["Pull the holdout suite", "Post the score report"],
    "exactly two steps may carry the key: the credential mint (in the holdout pull) and the post"
  );
  // The step that runs attempt code names the key nowhere, not even as a variable.
  assert.doesNotMatch(stepNamed(score, CONTAINER_STEP), /IMPROVE_SCORE_KEY/, "the step that runs attempt code must not hold the key");
});

test("node and curl are absolute-pathed in every credentialed step", () => {
  const scoreJob = jobText(jobNamed(SCORER_WORKFLOW, "score"));
  assert.ok(!/\bcurl --silent/.test(scoreJob.replace(/\/usr\/bin\/curl --silent/g, "")), "curl must be absolute-pathed");
  assert.match(WORKFLOW, /echo "node=\$\(command -v node\)" >> "\$GITHUB_OUTPUT"/, "node is resolved once, in a trusted step");
  assert.match(WORKFLOW, /NODE_BIN: \$\{\{ steps\.trusted\.outputs\.node \}\}/, "and passed to the steps that need it");
});

// The secondaries come out of the sandbox, and the sandbox is sound.
//
// test_pass_rate and lint_count are measured by the repo's own commands inside the
// same --network none --read-only container as the holdout, so metrics.json cannot
// forge them. test/secondary-recompute.test.ts drives the scorer script; these check
// the workflow runs it the way that file assumes.

test("the sandbox runs the secondary phases, framed by the nonce", () => {
  assert.match(WORKFLOW, /--secondary-scripts "\$\{IMPROVE_NAMESPACE\}" "\$\{RUNNER_TEMP\}\/trusted"/);
  assert.match(WORKFLOW, /M="##CAPSID-\$\{CAPSID_NONCE\}"/, "the container builds its marker prefix from the nonce");
  assert.match(WORKFLOW, /unset CAPSID_NONCE/, "and drops it from the environment before any attempt code runs");
  assert.match(WORKFLOW, /sh \/trusted\/secondary-test\.sh 2>&1/, "the test phase runs inside the container");
  assert.match(WORKFLOW, /sh \/trusted\/secondary-lint\.sh 2>&1/, "so does the lint phase");
  assert.match(WORKFLOW, /--secondary \\\n\s+"\$\{RUNNER_TEMP\}\/holdout\.tap"/, "and the trusted copy parses the stream");
  assert.match(
    WORKFLOW,
    /SECONDARY_TEST_PASS_RATE: \$\{\{ steps\.secondary\.outputs\.test_pass_rate \}\}/,
    "the signing step reads the recomputed value from a step output"
  );
  assert.match(WORKFLOW, /SECONDARY_LINT_COUNT: \$\{\{ steps\.secondary\.outputs\.lint_count \}\}/);
});

test("PLANT: the container script carries no apostrophe, comments included", () => {
  // The whole script is one single-quoted shell argument: one apostrophe ends it and
  // every line after it runs on the runner, outside the container, with the
  // workspace writable. A quoting slip here is an isolation failure.
  const step = stepNamed(jobNamed(SCORER_WORKFLOW, "score"), CONTAINER_STEP);
  const open = step.indexOf("--entrypoint /bin/sh");
  assert.ok(open > 0, "the container invocation moved; this scan is reading nothing");
  const scriptStart = step.indexOf("-c '", open);
  const scriptEnd = step.indexOf("\n            ' >", scriptStart);
  assert.ok(scriptStart > 0 && scriptEnd > scriptStart, "could not bound the container script");
  const script = step.slice(scriptStart + 4, scriptEnd);
  assert.ok(script.includes("docker") === false, "the slice is the script body, not the docker line");
  assert.ok(script.length > 500, `the container script sliced to ${script.length} characters; the bounds are wrong`);
  const offenders = script
    .split("\n")
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes("'"));
  assert.deepEqual(
    offenders.map((o) => o.line.trim()),
    [],
    "an apostrophe anywhere in this script closes the shell argument early"
  );
});

test("PLANT: the sandbox is a real git repository, with one commit and no history", () => {
  // The sandbox assembles its tree by copying, without .git, so a test that asks git
  // needs a repository: one commit of the assembled tree, so rev-parse and status answer.
  const container = executable(stepNamed(jobNamed(SCORER_WORKFLOW, "score"), CONTAINER_STEP));
  assert.match(container, /git init -q/, "the sandbox must be a repository, not just a machine with git on it");
  assert.match(container, /git commit -q -m sandbox/, "one commit, so HEAD exists");
  assert.match(
    container,
    /printf "node_modules\\n\.holdout\\n" > \/work\/\.git\/info\/exclude/,
    "node_modules and the holdout stay out of the index, so it is the source tree and nothing else"
  );
  // No real history and no remote: the commit tells an attempt nothing about the
  // actual repository.
  assert.ok(!/git remote add/.test(container), "the sandbox must have no remote");
  assert.ok(!/git fetch|git clone|git pull/.test(container), "and no network operation, behind --network none");
  // It runs BEFORE the phases that might ask, and the holdout is not in the tree yet, so
  // the exclude entry is a second check rather than the fix.
  assert.ok(
    container.indexOf("git init") < container.indexOf("secondary-test.sh"),
    "the repository must exist before any repo command runs"
  );
});

test("PLANT: the trusted tree is COPIED into the sandbox, not symlinked", () => {
  // A symlinked /work/test makes a test file's real path /repo/test/x.test.ts, so
  // node resolves its `../src` import against /repo and the sandbox measures the
  // default branch instead of the attempt.
  const container = executable(stepNamed(jobNamed(SCORER_WORKFLOW, "score"), CONTAINER_STEP));
  assert.ok(
    !/ln -s "\$e" "\/work\/\$b"/.test(container),
    "blanket-symlinking the trusted tree into /work is what made relative imports resolve outside the sandbox"
  );
  assert.match(container, /find \. -path \.\/\.git -prune -o -name node_modules -prune -o -type f -print/, "source files are copied");
  // node_modules is the one thing not copied: it is a real directory in the tmpfs
  // whose entries are symlinks to the read-only originals, so every package stays
  // read-only while tools like vite can still write inside the directory.
  assert.match(container, /find \. -path \.\/\.git -prune -o -name node_modules -print -prune/, "the relink must prune");
  assert.match(container, /mkdir -p "\/work\/\$rel"/, "node_modules is a real directory, so a tool can write inside it");
  assert.match(container, /ln -s "\$e" "\/work\/\$rel\/\$\{e##\*\/\}"/, "and its entries are symlinks to the read-only originals");
  assert.ok(
    !/ln -s "\/repo\/\$\{d#\.\/\}" "\/work\/\$d"/.test(container),
    "symlinking the node_modules DIRECTORY makes it read-only, which is what broke vite"
  );
  assert.ok(
    !/-name node_modules -print \|/.test(container),
    "the relink must prune, or it walks the whole dependency tree it just made read-only"
  );
});
