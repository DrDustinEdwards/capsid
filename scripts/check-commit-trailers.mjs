// REFUSES A COMMIT WHOSE MESSAGE CARRIES AN AI ATTRIBUTION TRAILER, AND, ON A PULL
// REQUEST, A COMMIT AUTHORED OR COMMITTED AS CLAUDE.
//
// CLAUDE.md, no AI trailer rule. The global attribution setting covers two of the three
// forms, so this is the repo's own check.
//
// The second check exists because a squash merge builds its message from the branch
// commits' AUTHORS: a clean message authored as `Claude <noreply@anthropic.com>` comes
// out of the squash with `Co-authored-by: Claude <noreply@anthropic.com>`, and the push
// run on master then fails after the merge (2026-10-04, PRs 233 to 236; deploy skipped
// for about ten hours). Catching the author on the pull request catches it before the
// merge. A push is checked on messages alone, as before.
//
// Only the commits a push or pull request adds are checked; history is not rewritten.
//
// Usage:
//   node scripts/check-commit-trailers.mjs <base> <head>   checks base..head (messages)
//   node scripts/check-commit-trailers.mjs <base> <head> --authors   also author/committer
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

// An identity that is an AI agent rather than a person: Anthropic's address or domain,
// the `claude[bot]` GitHub app, or a name that is Claude or Claude plus a product or model
// word ("Claude", "Claude Code", "Claude Opus 4"). A person whose name merely begins with
// Claude ("Claude Dupont") or whose address contains it is not flagged; a person named
// exactly "Claude" is, and can re-author.
const AGENT_NAME = /^claude(?:\[bot\]|\s+(?:code|opus|sonnet|haiku|fable)\b.*)?$/i;
const AGENT_EMAIL = /(?:@(?:[\w-]+\.)*anthropic\.com|\+claude\[bot\]@users\.noreply\.github\.com)$/i;

/**
 * @param {string} name
 * @param {string} email
 * @returns {boolean}
 */
export function isAgentIdentity(name, email) {
  const n = String(name ?? "").trim();
  const e = String(email ?? "").trim();
  return AGENT_NAME.test(n) || /\banthropic\b/i.test(n) || AGENT_EMAIL.test(e);
}

const ZERO = /^0+$/;

/**
 * Which commits to check for a GitHub event. `null` means the event adds no commits.
 * @param {Record<string, string | undefined>} env
 * @returns {{ base: string | null, head: string, authors: boolean } | null}
 */
export function rangeFromEvent(env) {
  const event = env.EVENT ?? "";
  if (event === "pull_request") {
    if (!env.PR_BASE || !env.PR_HEAD) throw new Error("pull_request event without PR_BASE and PR_HEAD");
    return { base: env.PR_BASE, head: env.PR_HEAD, authors: true };
  }
  if (event === "push") {
    if (!env.PUSH_AFTER) throw new Error("push event without PUSH_AFTER");
    // A new branch has no before sha: check the head commit alone.
    const before = env.PUSH_BEFORE && !ZERO.test(env.PUSH_BEFORE) ? env.PUSH_BEFORE : null;
    return { base: before, head: env.PUSH_AFTER, authors: false };
  }
  return null;
}

/**
 * @param {string | null} base
 * @param {string} head
 * @param {string} [cwd]
 * @param {boolean} [authors] also refuse a commit authored or committed as Claude
 * @returns {Array<{ sha: string, found: string[], identities: string[] }>}
 */
export function checkRange(base, head, cwd, authors = false) {
  const git = (/** @type {string[]} */ args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  // Fails closed: an unknown sha (a shallow clone, a force-pushed-over base) throws.
  for (const sha of base ? [base, head] : [head]) git(["cat-file", "-e", `${sha}^{commit}`]);
  const range = base ? [`${base}..${head}`] : ["-1", head];
  const out = git(["log", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e", ...range]);
  /** @type {Array<{ sha: string, found: string[], identities: string[] }>} */
  const bad = [];
  for (const record of out.split("\x1e")) {
    const [sha, an, ae, cn, ce, ...rest] = record.split("\x00");
    if (rest.length === 0) continue;
    const found = trailerViolations(rest.join("\x00"));
    /** @type {string[]} */
    const identities = [];
    if (authors) {
      if (isAgentIdentity(an, ae)) identities.push(`author ${an} <${ae}>`);
      if (isAgentIdentity(cn, ce)) identities.push(`committer ${cn} <${ce}>`);
    }
    if (found.length || identities.length) bad.push({ sha: sha.trim(), found, identities });
  }
  return bad;
}

function main() {
  let range;
  try {
    const args = process.argv.slice(2);
    const authors = args.includes("--authors");
    const [base, head] = args.filter((a) => a !== "--authors");
    range = head ? { base, head, authors } : rangeFromEvent(process.env);
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
    bad = checkRange(range.base, range.head, undefined, range.authors);
  } catch (err) {
    console.error(`check-commit-trailers: could not read commits ${range.base ?? "(none)"}..${range.head}: ${/** @type {Error} */ (err).message}`);
    process.exit(2);
  }
  if (bad.length === 0) {
    console.log(
      `check-commit-trailers: no AI trailer${range.authors ? " and no AI author" : ""} in ${range.base ? `${range.base}..${range.head}` : range.head}`
    );
    return;
  }
  for (const { sha, found, identities } of bad) {
    for (const f of found) console.error(`::error::commit ${sha} carries an AI trailer (${f})`);
    for (const id of identities) {
      console.error(
        `::error::commit ${sha} has an AI identity (${id}). A squash merge turns a Claude author into "Co-authored-by: Claude", which the push check then refuses after the merge.`
      );
    }
  }
  if (bad.some((b) => b.found.length)) console.error("Rewrite those commit messages without the trailer (CLAUDE.md, no AI trailer rule).");
  if (bad.some((b) => b.identities.length)) {
    console.error(
      "Re-author those commits as yourself: `git config user.name` and `user.email`, then `git rebase -r <base> --exec 'git commit --amend --no-edit --reset-author'`, or `git commit --amend --reset-author` for the last one, and force-push the branch."
    );
  }
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
