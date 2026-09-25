// REFUSES A COMMIT WHOSE MESSAGE CARRIES AN AI ATTRIBUTION TRAILER.
//
// CLAUDE.md, no AI trailer rule. A session harness has instructed these trailers in
// before, in the tool that does the work, and a session followed it. The global
// attribution setting covers two of the three forms and nothing covered the third,
// so this is the repo's own check.
//
// Only the commits a push or pull request adds are checked. Older commits on master
// that carry a trailer stay as they are (ruled 2026-09-25: no history rewrite).
//
// Usage:
//   node scripts/check-commit-trailers.mjs <base> <head>   checks base..head
//   node scripts/check-commit-trailers.mjs                 reads the range from the
//     GitHub event: EVENT, PR_BASE, PR_HEAD, PUSH_BEFORE, PUSH_AFTER (set in ci.yml)
//
// Exit 0: no commit in the range carries a trailer, or the event adds no commits.
// Exit 1: at least one does; each is printed. Exit 2: the check could not run, which
// is a failure, not a pass.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// The three named forms, matched at the start of any line of the message.
const NAMED = [
  { re: /^\s*co-authored-by:.*\b(claude|anthropic)\b/i, what: "Co-Authored-By naming Claude" },
  { re: /^\W*generated with \[?claude\b/i, what: "Generated with Claude Code" },
  { re: /^\s*claude-session:/i, what: "Claude-Session link" },
];

// Any other trailer naming Claude: a line in the message's final paragraph, when
// every line of that paragraph is trailer-shaped (git's own trailer block), whose
// key or value names Claude or Anthropic. "CLAUDE.md" is a file in this repo and
// does not count.
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:\s/;
const NAMES_AGENT = /\b(claude(?!\.md)|anthropic)\b/i;

/**
 * @param {string} message a full commit message
 * @returns {string[]} one entry per trailer found; empty when the message is clean
 */
export function trailerViolations(message) {
  const text = String(message ?? "").replace(/\r\n/g, "\n").trim();
  /** @type {string[]} */
  const found = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const line of text.split("\n")) {
    const named = NAMED.find(({ re }) => re.test(line));
    if (named) {
      found.push(`${named.what}: ${line.trim()}`);
      seen.add(line);
    }
  }
  const paragraphs = text.split(/\n\s*\n/);
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1].split("\n") : [];
  if (last.length > 0 && last.every((line) => TRAILER_LINE.test(line))) {
    for (const line of last) {
      if (NAMES_AGENT.test(line) && !seen.has(line)) found.push(`trailer naming Claude: ${line.trim()}`);
    }
  }
  return found;
}

const ZERO = /^0+$/;

/**
 * Which commits to check for a GitHub event. `null` means the event adds no commits.
 * @param {Record<string, string | undefined>} env
 * @returns {{ base: string | null, head: string } | null}
 */
export function rangeFromEvent(env) {
  const event = env.EVENT ?? "";
  if (event === "pull_request") {
    if (!env.PR_BASE || !env.PR_HEAD) throw new Error("pull_request event without PR_BASE and PR_HEAD");
    return { base: env.PR_BASE, head: env.PR_HEAD };
  }
  if (event === "push") {
    if (!env.PUSH_AFTER) throw new Error("push event without PUSH_AFTER");
    // A new branch has no before sha: check the head commit alone.
    const before = env.PUSH_BEFORE && !ZERO.test(env.PUSH_BEFORE) ? env.PUSH_BEFORE : null;
    return { base: before, head: env.PUSH_AFTER };
  }
  return null;
}

/**
 * @param {string | null} base
 * @param {string} head
 * @param {string} [cwd]
 * @returns {Array<{ sha: string, found: string[] }>}
 */
export function checkRange(base, head, cwd) {
  const git = (/** @type {string[]} */ args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  // Fails closed: an unknown sha (a shallow clone, a force-pushed-over base) throws.
  for (const sha of base ? [base, head] : [head]) git(["cat-file", "-e", `${sha}^{commit}`]);
  const range = base ? [`${base}..${head}`] : ["-1", head];
  const out = git(["log", "--format=%H%x00%B%x1e", ...range]);
  /** @type {Array<{ sha: string, found: string[] }>} */
  const bad = [];
  for (const record of out.split("\x1e")) {
    const at = record.indexOf("\x00");
    if (at < 0) continue;
    const sha = record.slice(0, at).trim();
    const found = trailerViolations(record.slice(at + 1));
    if (found.length) bad.push({ sha, found });
  }
  return bad;
}

function main() {
  let range;
  try {
    const [base, head] = process.argv.slice(2);
    range = head ? { base, head } : rangeFromEvent(process.env);
  } catch (err) {
    console.error(`check-commit-trailers: could not work out the range: ${/** @type {Error} */ (err).message}`);
    process.exit(2);
  }
  if (!range) {
    console.log(`check-commit-trailers: event '${process.env.EVENT ?? ""}' adds no commits; nothing to check`);
    return;
  }
  let bad;
  try {
    bad = checkRange(range.base, range.head);
  } catch (err) {
    console.error(`check-commit-trailers: could not read commits ${range.base ?? "(none)"}..${range.head}: ${/** @type {Error} */ (err).message}`);
    process.exit(2);
  }
  if (bad.length === 0) {
    console.log(`check-commit-trailers: no AI trailer in ${range.base ? `${range.base}..${range.head}` : range.head}`);
    return;
  }
  for (const { sha, found } of bad) {
    for (const f of found) console.error(`::error::commit ${sha} carries an AI trailer (${f})`);
  }
  console.error("Rewrite those commit messages without the trailer (CLAUDE.md, no AI trailer rule).");
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
