// Re-copy the byte-identical scorer surface from this repo to the four roster repos.
//
// WHY THIS EXISTS. The score job and scripts/improve-report.mjs are byte-identical
// across all five roster repos, and nothing enforced that. On 2026-09-10 a comment
// pass (PR #10) rewrote both here and the four copies silently diverged; the same
// pass also deleted four executable diagnostics from the score job, which is why a
// "comment sync" is not a thing anyone should do by hand.
//
// CROSS-REPO IDENTITY CANNOT BE ASSERTED BY AN OFFLINE TEST. The other four repos
// are not on this disk in CI, so test/sync-scorer.test.ts checks the half that can
// run here (the marker is unique, the split is lossless, the hash is stable) and
// the dry run below checks the half that needs the clones.
//
//   node scripts/sync-scorer.mjs           report what would change, write nothing
//   node scripts/sync-scorer.mjs --apply   write the files into each clone
//
// It stops at the working tree on purpose. Branch, commit, push and PR are the
// human's gate: merging these repos deploys them.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

export const MARKER = "BYTE-IDENTICAL BELOW THIS LINE";
export const WORKFLOW = ".github/workflows/improve-score.yml";
export const REPORT = "scripts/improve-report.mjs";

const DEV = join(import.meta.dirname, "..", "..");

// THE SOURCE IS THIS REPO, RESOLVED FROM THIS FILE RATHER THAN NAMED.
//
// It was a hardcoded folder name, and 4c1a089 rewrote it along with every other
// mention of the renamed repository. The REPOSITORY is capsid; the clone on this
// machine deliberately keeps its pre-rename folder name, as capsid/core.md says,
// so the rename pointed this at a directory that does not exist and the copier
// threw on its first git call ever after. Nothing caught it because nothing had
// run it and no test resolved the path. The folder is not named here on purpose:
// deriving the path means no spelling is needed at all.
//
// Deriving it from import.meta.dirname removes the class rather than correcting
// the spelling: this file lives in the source repo, so the source is wherever
// this file is, whatever anyone renames.
export const SOURCE_ROOT = join(import.meta.dirname, "..");
const SOURCE = { dir: SOURCE_ROOT, ref: "master", label: basename(SOURCE_ROOT) };

// EVERY TARGET IS AN ABSOLUTE PATH, and dustinedwards-info is NOT its clone.
//
// Ruling 60 (dustinedwards/decisions-vol-18.md, 2026-09-11): every rollout the
// Capsid seat makes to dustinedwards-info runs in dev/worktrees/capsid on branch
// improve/capsid, never in dev/dustinedwards-info, because the site session owns
// that clone and main. This list named the clone, so running --apply would have
// written into it. The job that ordered this rollout says the same thing in its
// own words, which is what surfaced the conflict.
//
// A ROLLOUT BRANCH IS NOT WHAT THE REPO RUNS, and comparing against one hides drift.
//
// `ref` is where the copier WRITES. `runs` is what the repo actually RUNS: its
// default branch, the ref CI reads and the one the watcher hashes. They are the same
// everywhere except dustinedwards-info, where ruling 60 sends the write to a rollout
// branch in the worktree.
//
// Measured 2026-09-18, job_3bde47744566. improve/capsid carried this copier's own
// last output, synced on 2026-09-16 and never landed. main did not: 748f859 that
// morning recut the comment headers of 93 files repo-wide, scripts/improve-report.mjs
// among them, leaving a696dd63 against this repo's 6ab6cc8c. The executable lines
// were byte-identical and 352 comment lines were not. The watcher reads default
// branches and reported the drift; the copier read the rollout branch, compared its
// own last output with itself, and printed identical.
//
// A report of agreement that does not exist is the same defect as a report of drift
// that does not exist, which is what capsid/decisions.md ruled on 2026-09-16 and what
// the stale-clone fix in PR #78 corrected the same morning. This is that defect one
// ref further out: the clone was current, and the ref was not the one that matters.
//
// `runs` is read from the REMOTE-TRACKING ref, never the local branch, because capsid
// may require nothing of a local branch it does not own. main in that repository is
// checked out in dev/dustinedwards-info and belongs to the site session, so no fetch
// run from the worktree can move it.
export const TARGETS = [
  {
    dir: join(DEV, "worktrees", "capsid"),
    ref: "improve/capsid",
    runs: "main",
    label: "dustinedwards-info (worktree, ruling 60)",
  },
  { dir: join(DEV, "foxhound"), ref: "main", label: "foxhound" },
  { dir: join(DEV, "foxing"), ref: "main", label: "foxing" },
  { dir: join(DEV, "germomics"), ref: "main", label: "germomics" },
];

// A REF BEHIND ITS REMOTE IS A REFUSAL, and this is the one that nearly shipped.
//
// The copier reads `git show <ref>:<path>`, which is whatever the LOCAL ref points
// at. On 2026-09-16 this repo's local master was 26 commits behind origin and did
// not contain the Job B cache the rollout existed to propagate. The dry run duly
// reported three of four targets as "identical", because they matched a source
// that was stale, and --apply would have written the PRE-cache block into all of
// them while printing that nothing needed to change.
//
// IT ASKS THE REMOTE, AND AN UNREACHABLE REMOTE IS A REFUSAL.
//
// This used to compare the local ref to its own remote-tracking branch and go no
// further, on the reasoning that a copier reaching the network can fail for reasons
// unrelated to the copy. That check cannot see the case it exists for: when the
// remote-tracking ref is ITSELF stale, both sides are the same old commit and the
// check passes.
//
// Measured 2026-09-18 on foxhound. Its clone had never been fetched, so `main` and
// `origin/main` were both 826b67f while the real remote was 3360275, seven days and
// one merged sync PR ahead. The check passed, the copier read the stale blobs, and
// the dry run reported foxhound's scorer as diverged from capsid's. It was not:
// every one of the five repos was byte-identical on its actual remote. A report of
// drift that does not exist is the same defect as a report of agreement that does
// not exist, which is what capsid/decisions.md ruled on 2026-09-16; this one cost
// job_63f96b1d1a32, which was posted to investigate a divergence that was never there.
//
// So `git ls-remote` is asked, and the original concern is answered by failing
// CLOSED: a remote that cannot be reached refuses the run and says so, rather than
// falling back to comparing two local refs that agree with each other and nothing else.
export function requireCurrent(dir, ref, label) {
  const at = (/** @type {string} */ r) =>
    execFileSync("git", ["-C", dir, "rev-parse", r], { encoding: "utf8" }).trim();
  let remote;
  try {
    remote = at(`origin/${ref}`);
  } catch {
    throw new Error(`${label}: no origin/${ref} to check ${ref} against. Fetch first. Nothing was written.`);
  }
  const local = at(ref);
  if (local !== remote) {
    throw new Error(
      `${label}: ${ref} is ${local.slice(0, 7)} and origin/${ref} is ${remote.slice(0, 7)}. ` +
        `The copier reads the local ref, so this would copy something other than what is on the remote. ` +
        `Run: git -C ${dir} fetch origin. Nothing was written.`
    );
  }
  const actual = remoteHead(dir, ref, label);
  if (actual !== remote) {
    throw new Error(
      `${label}: origin/${ref} is ${remote.slice(0, 7)} but the remote is at ${actual.slice(0, 7)}. ` +
        `This clone has not fetched, so ${ref} and origin/${ref} agree with each other and with nothing else. ` +
        `Run: git -C ${dir} fetch origin. Nothing was written.`
    );
  }
}

/**
 * The commit the REAL remote has for a ref. A remote that cannot be reached refuses
 * the run: the whole point of this check is that the local refs are not evidence.
 * @param {string} dir
 * @param {string} ref
 * @param {string} label
 * @returns {string}
 */
export function remoteHead(dir, ref, label) {
  let out;
  try {
    out = execFileSync("git", ["-C", dir, "ls-remote", "origin", `refs/heads/${ref}`], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    throw new Error(
      `${label}: the remote could not be reached to check ${ref} (${err instanceof Error ? err.message.split("\n")[0] : String(err)}). ` +
        `Refusing rather than trusting this clone's own refs. Nothing was written.`
    );
  }
  const sha = out.split("\n").map((l) => l.trim()).filter(Boolean)[0]?.split(/\s+/)[0];
  if (!sha) {
    throw new Error(`${label}: the remote has no ${ref}. Nothing was written.`);
  }
  return sha;
}

/**
 * The compare ref for a target whose `runs` branch is owned by somebody else. It
 * checks the REMOTE-TRACKING ref against the remote and nothing else, because the
 * local branch is not evidence and, where another session has it checked out, not
 * even movable from here. The bytes are then read from `origin/<ref>`.
 * @param {string} dir
 * @param {string} ref
 * @param {string} label
 */
export function requireRemoteCurrent(dir, ref, label) {
  let tracking;
  try {
    tracking = execFileSync("git", ["-C", dir, "rev-parse", `origin/${ref}`], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`${label}: no origin/${ref} to read. Run: git -C ${dir} fetch origin. Nothing was written.`);
  }
  const actual = remoteHead(dir, ref, label);
  if (tracking !== actual) {
    throw new Error(
      `${label}: origin/${ref} is ${tracking.slice(0, 7)} but the remote is at ${actual.slice(0, 7)}. ` +
        `This clone has not fetched, so it would be compared against something the repo no longer runs. ` +
        `Run: git -C ${dir} fetch origin. Nothing was written.`
    );
  }
}

/**
 * WRITING ONTO A ROLLOUT BRANCH THAT IS BEHIND WHAT IT WILL BE MERGED INTO IS REFUSED.
 *
 * When `runs` and `ref` differ, the copier compares against the default branch and
 * writes into the rollout branch's tree. That is only sound while the rollout branch
 * contains the default branch: otherwise the file is correct and everything around it
 * is however many commits stale, and the pull request carries that difference as well
 * as the fix. improve/capsid was 64 commits behind main when this was written, which
 * is how a committed rollout sat unlanded for two days.
 * @param {string} dir
 * @param {string} ref
 * @param {string} runs
 * @param {string} label
 */
export function requireLanded(dir, ref, runs, label) {
  const behind = execFileSync("git", ["-C", dir, "rev-list", "--count", `${ref}..origin/${runs}`], {
    encoding: "utf8",
  }).trim();
  if (behind !== "0") {
    throw new Error(
      `${label}: ${ref} is ${behind} commit(s) behind origin/${runs}, so writing here would base the fix on a stale tree. ` +
        `Run: git -C ${dir} merge origin/${runs}. Nothing was written.`
    );
  }
}

// A MISSING CLONE IS A NAMED REFUSAL, not a git stack trace. The failure this
// replaces printed "cannot change to ..." from deep inside execFileSync, which
// reads as a broken script rather than as a machine that is not provisioned.
function requireRepo(dir, label) {
  if (!existsSync(join(dir, ".git"))) {
    throw new Error(
      `${label}: no git repository at ${dir}. This machine is not provisioned for it, or the folder was renamed. ` +
        `Nothing was written.`
    );
  }
}

/**
 * The shared block is the marker line to end of file. The marker must occur
 * EXACTLY ONCE: zero means the file is not the shape this copier assumes, and two
 * means the split point is a guess. Either way it refuses rather than picking one.
 * @param {string} text
 * @param {string} label
 * @returns {{ head: string, tail: string }}
 */
export function splitBlock(text, label) {
  const lines = normalize(text).split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    if (line.includes(MARKER)) hits.push(i);
  });
  if (hits.length !== 1) {
    throw new Error(`${label}: marker found ${hits.length} times, expected exactly 1`);
  }
  return { head: lines.slice(0, hits[0]).join("\n"), tail: lines.slice(hits[0]).join("\n") };
}

/**
 * All five repos commit LF (`git ls-files --eol` reports i/lf w/lf, and
 * .gitattributes pins `* text=auto eol=lf`). Normalizing here means the hash is a
 * property of the content rather than of which host checked the file out.
 * @param {string} text
 * @returns {string}
 */
// ---- pinned actions: the SHA is shared, the version comment is not -----------
//
// A pinned step is `uses: owner/action@<40 hex> # v5`. The SHA is the security
// property and is compared STRICTLY. The trailing comment is an annotation, and
// Renovate rewrites it per repository on its own schedule: on 2026-09-14 it
// expanded `# v5` to `# v5.1.0` in dustinedwards-info and nowhere else, which made
// three of 400 lines differ and read as divergence. Measured the same week: the
// SHAs were byte-identical across all five.
//
// So the comment is normalized out of the comparison, and PRESERVED on write. If
// the copier overwrote it, Renovate would re-add it and open a pull request every
// cycle, and a diff that is noise every time is a diff a reader learns to skip.
// That is the habit this guard exists to protect.
//
// ONE PLACE UPGRADES THESE ACTIONS, and it is capsid. Renovate runs only here and
// in dustinedwards-info; the other three targets have no config, so they change
// only through this copier. When a real bump lands, the SHA changes and the strict
// comparison fires. THAT IS THE GUARD WORKING, not routine drift: a SHA that
// differs between repos means one of them is running an action version nobody
// reviewed, and it is worth stopping for.
const PIN_LINE = /^(\s*-?\s*uses:\s*[^\s@]+@[0-9a-f]{40})(\s*#.*)?\s*$/;

/**
 * Drop the trailing version comment from every pinned `uses:` line, for
 * COMPARISON only. The SHA stays, so a real pin change is still a difference.
 * @param {string} text
 * @returns {string}
 */
export function normalizePins(text) {
  return text
    .split("\n")
    .map((line) => {
      const m = PIN_LINE.exec(line);
      return m ? m[1] : line;
    })
    .join("\n");
}

/** Every pinned line in `text`, keyed by the trimmed `uses: ...@sha`, valued by its
 *  trailing comment. @param {string} text */
function pinComments(text) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const line of text.split("\n")) {
    const m = PIN_LINE.exec(line);
    if (m) map.set(m[1].trim(), (m[2] ?? "").trim());
  }
  return map;
}

/**
 * The source block, with each pinned line's trailing comment replaced by the
 * TARGET's own comment for the same action at the same SHA. A line whose SHA the
 * target does not carry keeps the source's comment, because there is nothing to
 * preserve and the pin is new to that repo.
 * @param {string} sourceBlock
 * @param {string} targetBlock
 * @returns {string}
 */
export function preservePinComments(sourceBlock, targetBlock) {
  const theirs = pinComments(targetBlock);
  return sourceBlock
    .split("\n")
    .map((line) => {
      const m = PIN_LINE.exec(line);
      if (!m) return line;
      const comment = theirs.get(m[1].trim());
      if (comment === undefined || comment.length === 0) return line;
      return `${m[1]} ${comment}`;
    })
    .join("\n");
}

export function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

/**
 * @param {string} text
 * @returns {string}
 */
export function blockHash(text) {
  return createHash("sha256").update(normalize(text), "utf8").digest("hex");
}

/**
 * Read a path from a repo's committed ref, never its working tree: a clone is not
 * the repo, and a dirty tree is not what the other repos will receive.
 * @param {string} dir
 * @param {string} ref
 * @param {string} path
 * @returns {string}
 */
function show(dir, ref, path) {
  return execFileSync("git", ["-C", dir, "show", `${ref}:${path}`], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * THE WORKING TREE BEING WRITTEN MUST BE THE BRANCH THAT WAS CHECKED, AND BOTH FILES
 * MUST BE CLEAN. The comparison reads committed refs, but the write goes into whatever
 * the clone has checked out. Without this, --apply wrote onto another branch, or
 * over uncommitted edits to either file, and nothing said so.
 * @param {string} dir
 * @param {string} ref
 * @param {string} label
 */
export function requireWritable(dir, ref, label) {
  let head;
  try {
    head = execFileSync("git", ["-C", dir, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    head = "(detached HEAD)";
  }
  if (head !== ref) {
    throw new Error(
      `${label}: ${head} is checked out, but the copier writes ${ref}. Run: git -C ${dir} checkout ${ref}. Nothing was written.`
    );
  }
  const dirty = execFileSync("git", ["-C", dir, "status", "--porcelain", "--", WORKFLOW, REPORT], {
    encoding: "utf8",
  }).trim();
  if (dirty) {
    throw new Error(
      `${label}: uncommitted changes to the files this would overwrite:\n${dirty}\n` +
        `Commit or discard them first. Nothing was written.`
    );
  }
}

/**
 * Compare every target, and with `apply`, write the ones that differ. EVERY TARGET IS
 * VALIDATED BEFORE ANY FILE IS WRITTEN, so a refusal on the third target leaves the
 * first two untouched and "Nothing was written" is true.
 * @param {{ source: { dir: string, ref: string, label: string }, targets: Array<{ dir: string, ref: string, runs?: string, label: string }>, apply: boolean, log?: (line: string) => void }} opts
 * @returns {number} how many targets differ
 */
export function sync({ source, targets, apply, log = console.log }) {
  const short = (/** @type {string} */ s) => blockHash(s).slice(0, 16);

  requireRepo(source.dir, source.label);
  requireCurrent(source.dir, source.ref, source.label);
  const srcWorkflow = splitBlock(show(source.dir, source.ref, WORKFLOW), `${source.label} ${WORKFLOW}`);
  const srcCompare = normalizePins(srcWorkflow.tail);
  const srcReport = normalize(show(source.dir, source.ref, REPORT));

  log(`source ${source.label}@${source.ref}`);
  log(`  score block  ${short(srcCompare)}  ${srcWorkflow.tail.split("\n").length} lines`);
  log(`  report       ${short(srcReport)}  ${srcReport.split("\n").length} lines\n`);

  /** @type {Array<{ label: string, path: string, text: string }>} */
  const writes = [];
  let changed = 0;
  for (const t of targets) {
    requireRepo(t.dir, t.label);
    // What the repo RUNS is what gets compared. Where that is the same ref the copier
    // writes, the local branch is read and checked three ways as before; where it is a
    // branch somebody else owns, the remote-tracking ref is read instead.
    const runs = t.runs ?? t.ref;
    const read = t.runs ? `origin/${runs}` : runs;
    if (t.runs) requireRemoteCurrent(t.dir, runs, t.label);
    else requireCurrent(t.dir, runs, t.label);
    const cur = splitBlock(show(t.dir, read, WORKFLOW), `${t.label} ${WORKFLOW}`);
    const curReport = normalize(show(t.dir, read, REPORT));
    const wfDrift = short(normalizePins(cur.tail)) !== short(srcCompare);
    const rpDrift = short(curReport) !== short(srcReport);

    // The ref that was COMPARED is printed, not the one that will be written, because
    // a line naming the wrong ref is how this went unnoticed for two days.
    log(`${t.label}@${read}${t.runs ? ` (writes ${t.ref})` : ""}`);
    log(`  score block  ${short(normalizePins(cur.tail))} -> ${short(srcCompare)}  ${wfDrift ? "CHANGES" : "identical"}`);
    log(`  report       ${short(curReport)} -> ${short(srcReport)}  ${rpDrift ? "CHANGES" : "identical"}`);
    if (!wfDrift && !rpDrift) continue;
    changed++;
    if (!apply) continue;

    // A rollout branch behind what it will be merged into is refused before any write.
    if (t.runs) requireLanded(t.dir, t.ref, runs, t.label);
    requireWritable(t.dir, t.ref, t.label);

    // The target keeps its own build job (everything above the marker) and takes
    // the source's block verbatim. Only the block below the marker is shared. The
    // head is read from the branch being WRITTEN, which differs from the compared
    // branch on a rollout target. The target keeps its own version comment on any
    // pin whose SHA is unchanged.
    const head = t.runs ? splitBlock(show(t.dir, t.ref, WORKFLOW), `${t.label}@${t.ref} ${WORKFLOW}`).head : cur.head;
    if (wfDrift) {
      writes.push({ label: t.label, path: join(t.dir, WORKFLOW), text: `${head}\n${preservePinComments(srcWorkflow.tail, cur.tail)}` });
    }
    if (rpDrift) writes.push({ label: t.label, path: join(t.dir, REPORT), text: srcReport });
  }

  /** @type {string[]} */
  const done = [];
  for (const w of writes) {
    try {
      writeFileSync(w.path, w.text, "utf8");
    } catch (err) {
      throw new Error(
        `${w.label}: could not write ${w.path} (${err instanceof Error ? err.message : String(err)}). ` +
          `Already written: ${done.length ? done.join(", ") : "nothing"}.`
      );
    }
    done.push(w.path);
    log(`written ${w.path}`);
  }

  log(
    apply
      ? `\n${changed} repo(s) written. Nothing committed or pushed.`
      : `\n${changed} repo(s) would change. Dry run: nothing written.`
  );
  return changed;
}

function main() {
  sync({ source: SOURCE, targets: TARGETS, apply: process.argv.includes("--apply") });
}

if (process.argv[1] && process.argv[1].endsWith("sync-scorer.mjs")) main();
