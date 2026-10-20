import type { Env } from "./env";
import { ghFetch } from "./github/client";
import { deletePruneCandidates, readPrunePlan, type PruneCandidate, type PruneKept, type PrunePlan } from "./github/prune";
import type { MaintenanceItem } from "./maintenance";
import { auditStatement } from "./store-guards";

// The daily maintenance pass's branch rules (job_549550d73d4e, piece 3). A merged branch is
// one capsid_close_pr action delete_branch with merged:true would prune (job_8779278b8e91, src/github/prune.ts): its
// latest pull request merged and its tip is the commit that pull request merged from. The
// same plan is read here, so the default branch, a branch with an open pull request and a
// branch with commits after its merge are refused exactly as the tool refuses them.
//
// Deleting is destructive, so the auto-prune ships off (conventions 2.3). Off, the merged
// branches are listed with a count and nothing is deleted. On, at most PRUNE_CAP per repo
// per run are deleted, each one re-read just before its delete and audit-logged with the
// sha it pointed at, so it can be put back. Every other branch with no open pull request
// whose last commit is older than STALE_DAYS is listed with its age. A keep list, kept in
// APP_KV with an empty default, names branches that are never pruned and never listed.
//
// With the switch on, a branch with no open pull request and no commit for ORPHAN_DAYS is
// deleted too, in the same cap and with the same audit row (job_9dbaf2ecfd2c; Dustin,
// 2026-10-14: every repo's branches down to the default and those with an open pull request
// or active work). Only when every list was read in full, and never the default, a
// protected or keep-listed branch, or a screenshot branch an open pull request
// still shows (src/github/prune.ts, shotsInUse).

/** The switch the seat sets to "on" to let the pass delete merged branches. Anything else,
 *  or no key, is off. A KV key rather than a control: a control would add to a served
 *  tool's surface (CLAUDE.md, tool surface rule). */
export const PRUNE_SWITCH_KEY = "maintenance:prune-merged";
/** The keep list: a JSON object of namespace to branch names, e.g.
 *  {"sample": ["review/one"]}. No key is an empty list. */
export const BRANCH_KEEP_KEY = "maintenance:branch-keep";

export const PRUNE_CAP = 25;
const STALE_DAYS = 30;
const ORPHAN_DAYS = 2;
// Commit dates read per repo per run; more stale candidates are listed as not checked.
const AGE_READS_PER_REPO = 30;
const MAX_ITEMS_PER_RULE = 50;
const SYSTEM_ACTOR = "system:maintenance";
export const PRUNE_AUDIT_ACTION = "maintenance-prune-branch";

interface BranchSettings {
  prune: boolean;
  keep: Record<string, string[]>;
}

export interface BranchReaders {
  /** The prune rule's plan for the namespace's repo, with the keep list applied. Throws
   *  when a list could not be read. */
  plan(namespace: string, keep: string[]): Promise<PrunePlan>;
  /** When the commit was made. Throws when it could not be read. */
  committedAt(plan: PrunePlan, sha: string): Promise<string>;
  /** Delete up to `cap` of the plan's candidates, each tip re-read first, calling
   *  `onDeleted` after each delete and before the next. */
  prune(plan: PrunePlan, cap: number, onDeleted: (c: PruneCandidate) => Promise<void>): Promise<{ deleted: PruneCandidate[]; skipped: PruneKept[]; remaining: number }>;
}

/** The switch and the keep list. A keep list that is not a JSON object of string arrays
 *  throws, so the pass says the branches were not checked rather than prune without it. */
async function readBranchSettings(kv: KVNamespace): Promise<BranchSettings> {
  const [switchRaw, keepRaw] = await Promise.all([kv.get(PRUNE_SWITCH_KEY), kv.get(BRANCH_KEEP_KEY)]);
  const keep: Record<string, string[]> = {};
  if (keepRaw) {
    const parsed: unknown = JSON.parse(keepRaw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${BRANCH_KEEP_KEY} is not a JSON object`);
    for (const [ns, names] of Object.entries(parsed)) {
      if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) throw new Error(`${BRANCH_KEEP_KEY}.${ns} is not a list of branch names`);
      keep[ns] = names as string[];
    }
  }
  return { prune: switchRaw === "on", keep };
}

const days = (ms: number): number => Math.floor(ms / 86_400_000);

/** The branch rules over every namespace in `namespaces`, and how many branches each read,
 *  so "nothing listed" can be told from "nothing read". */
export async function gatherBranchItems(
  env: Env,
  namespaces: readonly string[],
  readers: BranchReaders,
  now: Date
): Promise<{ items: MaintenanceItem[]; read: Record<string, number>; pruned: number }> {
  const items: MaintenanceItem[] = [];
  const read: Record<string, number> = {};
  let pruned = 0;

  let settings: BranchSettings;
  try {
    settings = await readBranchSettings(env.APP_KV);
  } catch (err) {
    const why = `the prune switch or keep list could not be read: ${err instanceof Error ? err.message : String(err)}`;
    return { items: namespaces.map((ns) => notChecked(ns, why)), read, pruned };
  }

  for (const namespace of namespaces) {
    let plan: PrunePlan;
    try {
      plan = await readers.plan(namespace, settings.keep[namespace] ?? []);
    } catch (err) {
      items.push(notChecked(namespace, err instanceof Error ? err.message : String(err)));
      continue;
    }
    read[namespace] = plan.branchesRead;
    let prunedHere = 0;

    if (settings.prune) {
      // One audit row per deleted branch, written before the next delete, with the sha it
      // pointed at: the deletion is put back by pushing that sha to the branch name
      // (snapshot invariant, test/write-invariants.test.ts). A failed audit write stops the deletes and the pass.
      const done = await readers.prune(plan, PRUNE_CAP, async (c) => {
        await auditStatement(env.DB, SYSTEM_ACTOR, PRUNE_AUDIT_ACTION, namespace, null, { repo: plan.repo, branch: c.branch, sha: c.sha, pr: c.pr }).run();
      });
      pruned += done.deleted.length;
      prunedHere = done.deleted.length;
      for (const c of done.deleted.slice(0, MAX_ITEMS_PER_RULE)) {
        items.push({
          rule: "branch-pruned",
          namespace,
          job: null,
          line: `${plan.repo} branch ${c.branch} was deleted: pull request #${c.pr} merged from its tip ${c.sha}. Put it back with git push origin ${c.sha}:refs/heads/${c.branch} if it was wanted.`,
        });
      }
      for (const s of done.skipped) {
        items.push({ rule: "branch-merged", namespace, job: null, line: `${plan.repo} branch ${s.branch} is merged and was not pruned: ${s.reason}.` });
      }
      if (done.remaining > 0) {
        items.push({ rule: "branch-merged", namespace, job: null, line: `${done.remaining} more merged branch(es) in ${plan.repo} wait for the next run (${PRUNE_CAP} are deleted per repo per run).` });
      }
    } else if (plan.prune.length > 0) {
      for (const c of plan.prune.slice(0, MAX_ITEMS_PER_RULE)) {
        items.push({ rule: "branch-merged", namespace, job: null, line: `${plan.repo} branch ${c.branch} is merged (pull request #${c.pr}, tip ${c.sha}): delete it, or keep-list it.` });
      }
      items.push({
        rule: "branch-merged",
        namespace,
        job: null,
        line: `${plan.prune.length} merged branch(es) in ${plan.repo} would be pruned; the auto-prune is off, so none was deleted.`,
      });
    }

    // Anything else old. A branch with an open pull request is not an orphan, and that is
    // known only when the open list was read in full.
    if (!plan.openComplete) {
      items.push(notChecked(namespace, `the open pull request list of ${plan.repo} was not read in full, so no branch is listed as stale`));
      continue;
    }
    const orphans = plan.kept.filter((k) => k.orphan);
    const reading = orphans.slice(0, AGE_READS_PER_REPO);
    if (orphans.length > reading.length) {
      items.push(notChecked(namespace, `${orphans.length - reading.length} branch(es) in ${plan.repo} with no open pull request had their age not read`));
    }
    const stale: Array<{ branch: string; reason: string; age: number; sha: string; ms: number }> = [];
    for (const k of reading) {
      let at: string;
      try {
        at = await readers.committedAt(plan, k.sha);
      } catch (err) {
        items.push(notChecked(namespace, `the last commit of ${plan.repo} branch ${k.branch}: ${err instanceof Error ? err.message : String(err)}`));
        continue;
      }
      const ms = now.getTime() - Date.parse(at);
      stale.push({ branch: k.branch, reason: k.reason, age: days(ms), sha: k.sha, ms });
    }
    stale.sort((a, b) => b.ms - a.ms);

    if (settings.prune && plan.listsComplete) {
      const old = stale.filter((s) => s.ms >= ORPHAN_DAYS * 86_400_000);
      const budget = Math.max(0, PRUNE_CAP - prunedHere);
      const done = old.length === 0 ? { deleted: [], skipped: [], remaining: 0 } : await readers.prune({ ...plan, prune: old.map((s) => ({ branch: s.branch, sha: s.sha, pr: null })) }, budget, async (c) => {
        await auditStatement(env.DB, SYSTEM_ACTOR, PRUNE_AUDIT_ACTION, namespace, null, { repo: plan.repo, branch: c.branch, sha: c.sha, pr: null }).run();
      });
      pruned += done.deleted.length;
      const why = new Map(old.map((s) => [s.branch, s]));
      for (const c of done.deleted.slice(0, MAX_ITEMS_PER_RULE)) {
        const s = why.get(c.branch)!;
        items.push({
          rule: "branch-pruned",
          namespace,
          job: null,
          line: `${plan.repo} branch ${c.branch} was deleted: no open pull request and no commit for ${s.age} days (${s.reason}). Put it back with git push origin ${c.sha}:refs/heads/${c.branch} if it was wanted.`,
        });
      }
      for (const k of done.skipped) items.push({ rule: "branch-stale", namespace, job: null, line: `${plan.repo} branch ${k.branch} is old and was not pruned: ${k.reason}.` });
      if (done.remaining > 0) {
        items.push({ rule: "branch-stale", namespace, job: null, line: `${done.remaining} more old branch(es) in ${plan.repo} wait for the next run (${PRUNE_CAP} are deleted per repo per run).` });
      }
      continue;
    }
    for (const s of stale.filter((x) => x.age > STALE_DAYS).slice(0, MAX_ITEMS_PER_RULE)) {
      items.push({ rule: "branch-stale", namespace, job: null, line: `${plan.repo} branch ${s.branch} has had no commit for ${s.age} days (${s.reason}): delete it, open its pull request, or keep-list it.` });
    }
  }
  return { items, read, pruned };
}

function notChecked(namespace: string, problem: string): MaintenanceItem {
  return {
    rule: "branches-not-checked",
    namespace,
    job: null,
    line: `Branches in ${namespace} were not fully checked (${problem}): what is missing is not a clean result.`,
  };
}

/** The readers on GitHub, through the App: delete_branch merged's own plan and delete step
 *  (src/github/prune.ts), and one commit read per orphan branch for its date. */
export function githubBranchReaders(env: Env): BranchReaders {
  return {
    plan: (namespace, keep) => readPrunePlan(env, namespace, keep),
    async committedAt(plan, sha) {
      const resp = await ghFetch(env, plan.owner, plan.name, `/repos/${plan.owner}/${plan.name}/commits/${sha}`);
      if (!resp.ok) {
        await resp.body?.cancel();
        throw new Error(`the commit read returned ${resp.status}`);
      }
      const commit = (await resp.json()) as { commit?: { committer?: { date?: string } } };
      const date = commit.commit?.committer?.date;
      if (!date) throw new Error("the commit carries no committer date");
      return date;
    },
    prune: (plan, cap, onDeleted) => deletePruneCandidates(env, plan, cap, onDeleted),
  };
}
