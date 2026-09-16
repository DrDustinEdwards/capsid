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
// test/repo-name.test.ts bans the old spelling in this directory, and deriving
// the path means no spelling is needed at all.
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
export const TARGETS = [
  { dir: join(DEV, "worktrees", "capsid"), ref: "improve/capsid", label: "dustinedwards-info (worktree, ruling 60)" },
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
// Checked without fetching, deliberately: a copier that reaches the network to
// decide what to copy can fail for reasons unrelated to the copy. It compares the
// ref to its own remote-tracking branch and tells the human to fetch.
function requireCurrent(dir, ref, label) {
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

function main() {
  const apply = process.argv.includes("--apply");
  const short = (/** @type {string} */ s) => blockHash(s).slice(0, 16);

  requireRepo(SOURCE.dir, SOURCE.label);
  requireCurrent(SOURCE.dir, SOURCE.ref, SOURCE.label);
  const srcWorkflow = splitBlock(show(SOURCE.dir, SOURCE.ref, WORKFLOW), `${SOURCE.label} ${WORKFLOW}`);
  const srcCompare = normalizePins(srcWorkflow.tail);
  const srcReport = normalize(show(SOURCE.dir, SOURCE.ref, REPORT));

  console.log(`source ${SOURCE.label}@${SOURCE.ref}`);
  console.log(`  score block  ${short(srcCompare)}  ${srcWorkflow.tail.split("\n").length} lines`);
  console.log(`  report       ${short(srcReport)}  ${srcReport.split("\n").length} lines\n`);

  let changed = 0;
  for (const t of TARGETS) {
    requireRepo(t.dir, t.label);
    requireCurrent(t.dir, t.ref, t.label);
    const cur = splitBlock(show(t.dir, t.ref, WORKFLOW), `${t.label} ${WORKFLOW}`);
    const curReport = normalize(show(t.dir, t.ref, REPORT));
    const wfDrift = short(normalizePins(cur.tail)) !== short(srcCompare);
    const rpDrift = short(curReport) !== short(srcReport);

    console.log(`${t.label}@${t.ref}`);
    console.log(`  score block  ${short(normalizePins(cur.tail))} -> ${short(srcCompare)}  ${wfDrift ? "CHANGES" : "identical"}`);
    console.log(`  report       ${short(curReport)} -> ${short(srcReport)}  ${rpDrift ? "CHANGES" : "identical"}`);
    if (wfDrift || rpDrift) changed++;
    if (!apply) continue;

    // The target keeps its own build job (everything above the marker) and takes
    // the source's block verbatim. Only the block below the marker is shared.
    // The target keeps its own version comment on any pin whose SHA is unchanged.
    if (wfDrift) writeFileSync(join(t.dir, WORKFLOW), `${cur.head}\n${preservePinComments(srcWorkflow.tail, cur.tail)}`, "utf8");
    if (rpDrift) writeFileSync(join(t.dir, REPORT), srcReport, "utf8");
    if (wfDrift || rpDrift) console.log("  written to the working tree");
  }

  console.log(
    apply
      ? `\n${changed} repo(s) written. Nothing committed or pushed.`
      : `\n${changed} repo(s) would change. Dry run: nothing written.`
  );
}

if (process.argv[1] && process.argv[1].endsWith("sync-scorer.mjs")) main();
