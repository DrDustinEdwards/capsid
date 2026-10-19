import type { BatchItem, ConfirmRequest } from "../app/ctx";
import type { OpsAwaitingSeat, OpsFeed } from "../types";

// A pull request waiting for you (live.awaiting_seat), and the two existing controls that
// decide it: approve_pr and pr_close. Pull requests and Needs you build the same requests
// here, so a row approves the same way wherever it is.

export function prName(a: Pick<OpsAwaitingSeat, "repo" | "number">): string {
  return `${a.repo} #${a.number}`;
}

export function prUrl(a: Pick<OpsAwaitingSeat, "repo" | "number">): string {
  return `https://github.com/${a.repo}/pull/${a.number}`;
}

// The id a pull request's row or card carries, so an alert or a link can name it.
export function prAnchor(a: Pick<OpsAwaitingSeat, "repo" | "number">): string {
  return `pr-${a.repo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${a.number}`;
}

// Approving (src/pr-approvals.ts) records the head the tick judged, and the next tick merges
// it once CI is green on that sha. A money PR (class typed) is approved by typing its number
// in chat, never here; seat and wait cannot be approved.
export function canApprove(a: OpsAwaitingSeat): a is OpsAwaitingSeat & { head_sha: string } {
  return (a.class === "approve" || a.class === "auto") && typeof a.head_sha === "string" && a.head_sha.length > 0;
}

export function approveItem(a: OpsAwaitingSeat & { head_sha: string }): BatchItem {
  return { action: "approve_pr", params: { namespace: a.namespace, repo: a.repo, prs: String(a.number), shas: a.head_sha }, label: prName(a) };
}

export function approveRequest(a: OpsAwaitingSeat & { head_sha: string }): ConfirmRequest {
  const item = approveItem(a);
  return { action: item.action, params: item.params, title: `Approve pull request ${prName(a)}` };
}

// Closing without a merge: a confirm with a reason; GitHub can reopen it, the Portal does not.
export function closeRequest(a: OpsAwaitingSeat): ConfirmRequest {
  return { action: "pr_close", params: { namespace: a.namespace, repo: a.repo, number: String(a.number) }, title: `Close pull request ${prName(a)}` };
}

// Several approvals as one confirm: each its own approve_pr, previewed and performed in turn.
export function approveAllRequest(list: ReadonlyArray<OpsAwaitingSeat & { head_sha: string }>): ConfirmRequest {
  const batch = list.map(approveItem);
  const first = batch[0]!;
  return { action: first.action, params: first.params, title: `Approve ${list.length} pull ${list.length === 1 ? "request" : "requests"}`, batch };
}

// The pull request an inbox item's GitHub address names, when it is one waiting for you.
export function seatFor(feed: OpsFeed, link: string | null): OpsAwaitingSeat | undefined {
  const m = link ? /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(link) : null;
  if (!m) return undefined;
  return feed.live.awaiting_seat.find((a) => a.repo === m[1] && a.number === Number(m[2]));
}
