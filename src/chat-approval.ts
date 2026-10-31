import type { Env } from "./env";
import { auditStatement } from "./store-guards";
import { readPrFiles } from "./github/pr-files";
import { pathClassOfAll } from "./merge-class";
import { logEvent } from "@dustinedwards/site-runtime/log";

// A chat approval in the approval record (src/pr-approvals.ts, table pr_approvals).
// Dustin approves most pull requests with a "yes" in a Claude chat, and the session
// merges. Until 2026-10-31 nothing recorded that yes: pr_approvals had no rows, and the
// merge units (src/merge-units.ts) had no evidence to propose a unit from (Dustin,
// 2026-10-31, thread "Measure how much Claude uses Capsid": make the ledger record chat
// approvals). capsid_close_pr action merge with `approved_in` (a link to his message)
// and `sha` merges that exact head and writes one row: surface chat, status merged,
// the path class the units count in.
//
// The admin identity alone may name an approval: a driver key's session is not Dustin,
// so a row it wrote would claim a yes nobody gave. The row is written after the merge
// and never fails it: the merge already happened.

const LINK = /^https:\/\/claude\.ai\/\S+$/;
export const MAX_APPROVAL_LINK = 512;

/** Why `approved_in` cannot be used on this call, or null. Checked before anything merges. */
export function chatApprovalRefusal(link: string, sha: string | undefined, admin: boolean): string | null {
  if (!admin) return "approved_in records Dustin's own approval, so only the admin identity may send it; a scoped agent merges without it.";
  if (!LINK.test(link)) return "approved_in must be the https://claude.ai/ link to the message where Dustin approved the merge.";
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return "approved_in needs sha: the full 40-character head sha Dustin approved, so the record names exactly what he saw.";
  return null;
}

/** Writes the merged approval row and its audit row. Returns the path class it recorded, or a note on failure. */
export async function recordChatApproval(
  env: Env,
  actor: string,
  p: { namespace: string; repo: string; number: number; headSha: string; mergeSha: string | null; link: string },
  now: Date
): Promise<{ recorded: true; path_class: string | null } | { recorded: false; note: string }> {
  try {
    const [owner, name] = p.repo.split("/");
    // The files are read after the merge: a merged pull request still lists them.
    const files = await readPrFiles(env, owner, name, p.number);
    const pathClass = files.problem ? null : pathClassOfAll(files.paths);
    const at = now.toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO pr_approvals (repo, pr, head_sha, class, status, approved_by, surface, reason, approved_at, closed_at, close_reason, merge_sha, namespace, path_class)
         VALUES (?1, ?2, ?3, 'chat', 'merged', ?4, 'chat', ?5, ?6, ?6, 'merged', ?7, ?8, ?9)`
      ).bind(p.repo, p.number, p.headSha, actor, p.link, at, p.mergeSha, p.namespace, pathClass),
      auditStatement(env.DB, actor, "pr-approved", p.namespace, null, { repo: p.repo, pr: p.number, head_sha: p.headSha, surface: "chat", approved_in: p.link, merged: true, path_class: pathClass }),
    ]);
    return { recorded: true, path_class: pathClass };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent("CHAT_APPROVAL_NOT_RECORDED", { message: `CHAT_APPROVAL_NOT_RECORDED ${p.repo}#${p.number}: ${message}` }, { level: "error" });
    return { recorded: false, note: `merged, but the approval was not recorded: ${message}` };
  }
}
