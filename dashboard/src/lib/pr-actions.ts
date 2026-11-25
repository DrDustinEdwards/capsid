import type { BatchItem, ConfirmRequest } from "../app/ctx";
import type { OpsAwaitingSeat, OpsFeed } from "../types";

export function prName(a: Pick<OpsAwaitingSeat, "repo" | "number">): string {
  return `${a.repo} #${a.number}`;
}

export function prAnchor(a: Pick<OpsAwaitingSeat, "repo" | "number">): string {
  return `pr-${a.repo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${a.number}`;
}

// A money PR (class typed) is approved by typing its number in chat, never here.
export function canApprove(a: OpsAwaitingSeat): a is OpsAwaitingSeat & { head_sha: string } {
  return (
    (a.class === "approve" || a.class === "auto") &&
    typeof a.head_sha === "string" &&
    a.head_sha.length > 0
  );
}

function approveItem(a: OpsAwaitingSeat & { head_sha: string }): BatchItem {
  return {
    action: "approve_pr",
    params: { namespace: a.namespace, repo: a.repo, prs: String(a.number), shas: a.head_sha },
    label: prName(a),
  };
}

export function approveRequest(a: OpsAwaitingSeat & { head_sha: string }): ConfirmRequest {
  const item = approveItem(a);
  return { action: item.action, params: item.params, title: `Approve pull request ${prName(a)}` };
}

export function closeRequest(a: OpsAwaitingSeat): ConfirmRequest {
  return {
    action: "pr_close",
    params: { namespace: a.namespace, repo: a.repo, number: String(a.number) },
    title: `Close pull request ${prName(a)}`,
  };
}

export function approveAllRequest(
  list: ReadonlyArray<OpsAwaitingSeat & { head_sha: string }>,
): ConfirmRequest {
  const batch = list.map(approveItem);
  const first = batch[0]!;
  return {
    action: first.action,
    params: first.params,
    title: `Approve ${list.length} pull ${list.length === 1 ? "request" : "requests"}`,
    batch,
  };
}

export function seatFor(feed: OpsFeed, link: string | null): OpsAwaitingSeat | undefined {
  const m = link ? /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(link) : null;
  if (!m) return undefined;
  return feed.live.awaiting_seat.find((a) => a.repo === m[1] && a.number === Number(m[2]));
}
