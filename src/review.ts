// A job posted with review_required does not reach the seat until a reviewer has
// given a verdict on its pull request.
//
// The verdict is a comment, not a GitHub review, because the reviewer agent holds only
// can_comment_pr; accepting a GitHub review would need a wider scope. The envelope is
// strict, `REVIEW:` at the start and one of three words at the end, so no verdict is
// guessed out of free prose.

import type { Env } from "./env";
import { ghFetch, parsePrUrl, resolveRepo, type PrUrl } from "./github/client";
import { parseScopes } from "./agents-schema";

const REVIEW_PREFIX = "REVIEW:";

export const VERDICTS = ["APPROVE", "CHANGES", "BLOCK"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ReviewComment {
  // GitHub's issue-comment id. The gate counts a verdict only when Capsid posted this
  // id for an actor holding can_comment_pr (see reviewerCommentIds). A comment with no
  // id is never eligible.
  id?: number;
  // The author login, recorded for the audit row. Not the check: every comment Capsid
  // posts has the same App author.
  user: string;
  body: string;
  created_at: string;
}

export interface Review {
  verdict: Verdict;
  by: string;
  at: string;
  // The comment with its envelope stripped.
  said: string;
}

/** The verdict a single comment carries, or null when it is not a review. Both the
 *  prefix and the closing verdict word are required. */
export function verdictOf(comment: ReviewComment): Review | null {
  const body = comment.body?.trim() ?? "";
  if (!body.toUpperCase().startsWith(REVIEW_PREFIX)) return null;
  const rest = body.slice(REVIEW_PREFIX.length).trim();
  // The last word, allowing trailing punctuation and formatting ("CHANGES.", "**BLOCK**").
  const tail = rest.replace(/[\s*_`.!]+$/u, "");
  const match = /([A-Za-z]+)$/u.exec(tail);
  if (!match) return null;
  const word = match[1].toUpperCase();
  if (!(VERDICTS as readonly string[]).includes(word)) return null;
  return {
    verdict: word as Verdict,
    by: comment.user,
    at: comment.created_at,
    said: tail.slice(0, tail.length - match[1].length).replace(/[\s*_`,:-]+$/u, "").trim(),
  };
}

/** The review that decides: the newest verdict, by created_at rather than array
 *  position, because GitHub's ordering is not promised. */
export function decidingReview(comments: readonly ReviewComment[]): Review | null {
  let best: Review | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const comment of comments) {
    const review = verdictOf(comment);
    if (!review) continue;
    const at = Date.parse(review.at);
    // An unparseable timestamp counts only when nothing else does.
    const rank = Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
    if (best === null || rank >= bestAt) {
      best = review;
      bestAt = rank;
    }
  }
  return best;
}

export type ReviewOutcome =
  // No review yet. The job stays where it is.
  | { kind: "waiting"; reason: string }
  // The seat may have it.
  | { kind: "proceed"; review: Review }
  // Back to the driver, and it costs a correction.
  | { kind: "rework"; review: Review }
  // Stopped for the seat, with the reviewer's objection as the reason.
  | { kind: "halt"; review: Review };

/** What a job with review_required does when its driver tries to hand it on. Pure,
 *  so every branch is tested without GitHub. */
export function outcomeOf(review: Review | null): ReviewOutcome {
  if (!review) {
    return {
      kind: "waiting",
      reason:
        `no review yet. This job was posted with review_required, so it waits for a comment on its pull request ` +
        `starting with '${REVIEW_PREFIX}' and ending with ${VERDICTS.join(", ")}. An APPROVE must also quote the pull request's head sha.`,
    };
  }
  switch (review.verdict) {
    case "APPROVE":
      return { kind: "proceed", review };
    case "CHANGES":
      return { kind: "rework", review };
    case "BLOCK":
      return { kind: "halt", review };
  }
}

/** Every comment on a pull request. Issue comments, not review comments, because
 *  manage_pr action `comment` posts there. */
export async function readReviewComments(
  env: Env,
  pr: PrUrl
): Promise<ReviewComment[]> {
  const resp = await ghFetch(env, pr.owner, pr.repo, `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments?per_page=100`);
  if (!resp.ok) throw new Error(`reading review comments failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  const rows = (await resp.json()) as Array<{ id?: number; user?: { login?: string }; body?: string; created_at?: string }>;
  return rows.map((r) => ({
    id: typeof r.id === "number" ? r.id : undefined,
    user: r.user?.login ?? "(unknown)",
    body: r.body ?? "",
    created_at: r.created_at ?? "",
  }));
}

/** The pull request's current head sha, read so an APPROVE counts only for the code it
 *  names. Throws on a GitHub failure, which the caller treats as an unread review
 *  rather than an approval. */
async function readHeadSha(env: Env, pr: PrUrl): Promise<string> {
  const resp = await ghFetch(env, pr.owner, pr.repo, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`);
  if (!resp.ok) throw new Error(`reading the pull request failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  const sha = ((await resp.json()) as { head?: { sha?: string } }).head?.sha ?? "";
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`the pull request reported no head commit`);
  return sha;
}

// The shortest sha prefix a review may quote, as `git log --oneline` prints.
const MIN_QUOTED_SHA = 7;

/** Whether a review's text quotes `head`: some standalone run of 7 to 40 hex
 *  characters in it is a prefix of the head sha (case-insensitive). */
function quotesSha(text: string, head: string): boolean {
  const want = head.toLowerCase();
  for (const token of text.match(new RegExp(`\\b[0-9a-f]{${MIN_QUOTED_SHA},40}\\b`, "gi")) ?? []) {
    if (want.startsWith(token.toLowerCase())) return true;
  }
  return false;
}

// Owner and repo compare case-insensitively because GitHub resolves them that way.
function samePr(a: PrUrl, b: PrUrl): boolean {
  return a.number === b.number && `${a.owner}/${a.repo}`.toLowerCase() === `${b.owner}/${b.repo}`.toLowerCase();
}

// How far back the eligibility scan reads, in audit rows for one namespace.
const REVIEWER_AUDIT_SCAN = 500;

/** The issue-comment ids Capsid posted for an actor allowed to review, in a namespace.
 *
 *  The identity half of the gate, read from audit_log rather than off the comment:
 *  `manage_pr` action `comment` posts through the App installation, so every comment
 *  Capsid writes has the same author login and the login cannot separate a reviewer's
 *  verdict from a driver's. What does separate them is who asked Capsid to post it,
 *  which the audit row records beside the comment_id.
 *
 *  A verdict counts when Capsid posted it and the actor that asked held
 *  can_comment_pr. A driver with local `gh` can still write `REVIEW: ... APPROVE` on
 *  the pull request, but it is not a review, because nothing in this set names it; with
 *  newest-wins it would otherwise also overwrite a real CHANGES.
 *
 *  A non-agent actor (the admin session or the legacy operator key) has unrestricted
 *  scopes and counts: a human reviewing by hand is a case this gate exists to allow. */
async function reviewerCommentIds(db: D1Database, namespace: string): Promise<Set<number>> {
  const rows = await db
    .prepare(
      `SELECT a.actor AS actor, a.params AS params, g.scopes AS scopes
         FROM audit_log a
         LEFT JOIN agents g ON g.name = substr(a.actor, 7)
        WHERE a.action = 'manage_pr' AND a.namespace = ?1 AND a.params LIKE '%"comment_id":%'
        ORDER BY a.id DESC
        LIMIT ?2`
    )
    .bind(namespace, REVIEWER_AUDIT_SCAN)
    .all<{ actor: string; params: string; scopes: string | null }>();
  const ids = new Set<number>();
  for (const row of rows.results ?? []) {
    if (row.actor?.startsWith("agent:")) {
      // An agent that no longer resolves fails closed.
      if (!row.scopes || !parseScopes(row.scopes).flags.can_comment_pr) continue;
    }
    let commentId: unknown;
    try {
      commentId = (JSON.parse(row.params) as { comment_id?: unknown }).comment_id;
    } catch {
      continue;
    }
    if (typeof commentId === "number") ids.add(commentId);
  }
  return ids;
}

/** The gate, end to end: what the review says about this job's pull request. A job
 *  with no pull request proceeds unless requirePullRequest is set. */
export type GateOutcome = ReviewOutcome & {
  // The pull request the gate read, so the caller can bind the job to it.
  pr?: string;
};

export async function reviewGate(
  env: Env,
  // The stored result_ref. On a claimed job only the gate writes it, so a pull request
  // URL there is the job's own, bound the first time the gate read one.
  job: { namespace: string; review_required: number; result_ref: string | null },
  opts: {
    // Set on `complete` only; see reviewRefusal in src/jobs.ts for why.
    requirePullRequest?: boolean;
    // The references this call names: its result_ref, then a complete's evidence.prs.
    candidateRefs?: readonly (string | null | undefined)[];
  } = {}
): Promise<GateOutcome | null> {
  if (!job.review_required) return null;
  let named: PrUrl | null = null;
  for (const ref of opts.candidateRefs ?? []) {
    named = parsePrUrl(ref);
    if (named) break;
  }
  // Bound to the job's own pull request: once the gate has read one, a call naming a
  // different one is refused, so a CHANGES cannot be escaped with an older approval.
  const bound = parsePrUrl(job.result_ref);
  if (bound && named && !samePr(bound, named)) {
    return {
      kind: "waiting",
      reason:
        `bound to ${job.result_ref}, the pull request its review gate first read, and this call names ` +
        `https://github.com/${named.owner}/${named.repo}/pull/${named.number}. A review of a different pull request does not review this job's work.`,
    };
  }
  const pr = bound ?? named;
  if (!pr) {
    if (!opts.requirePullRequest) return null;
    return {
      kind: "waiting",
      reason:
        `posted with review_required and names no pull request. Pass the pull request URL as result_ref, or in evidence.prs, ` +
        `so that a reviewer has something to read. A job that must be reviewed cannot be handed on with a document key, ` +
        `because that would let the driver decide whether the review applied.`,
    };
  }
  // Resolved through the namespace mapping, the authorization boundary, as prFacts does.
  let target: PrUrl;
  let url: string;
  try {
    const resolved = await resolveRepo(env, job.namespace, `${pr.owner}/${pr.repo}`);
    target = { owner: resolved.owner, repo: resolved.repo, number: pr.number };
    url = `https://github.com/${resolved.full}/pull/${pr.number}`;
  } catch (err) {
    return {
      kind: "waiting",
      reason:
        `naming a pull request the review gate may not read: ${err instanceof Error ? err.message : String(err)} ` +
        `Name a pull request in a repo that namespace ${job.namespace} maps.`,
    };
  }
  const comments = await readReviewComments(env, target);
  const eligible = await reviewerCommentIds(env.DB, job.namespace);
  const review = decidingReview(comments.filter((c) => c.id !== undefined && eligible.has(c.id)));
  // An APPROVE counts only when it quotes the current head sha, so a push after the
  // review needs a fresh one. A sha, not a committer date, which the committer sets.
  // CHANGES and BLOCK need no sha.
  if (review?.verdict === "APPROVE") {
    const head = await readHeadSha(env, target);
    if (!quotesSha(review.said, head)) {
      return {
        kind: "waiting",
        reason:
          `approved without quoting the current head of ${url}, which is ${head}. An APPROVE counts only when its ` +
          `${REVIEW_PREFIX} comment quotes the head sha it reviewed (at least ${MIN_QUOTED_SHA} hex characters), so this needs a fresh review.`,
        pr: url,
      };
    }
  }
  return { ...outcomeOf(review), pr: url };
}
