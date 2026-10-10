import type { Env } from "./env";
import { ghFetch, resolveRepo } from "./github/client";
import type { MaintenanceItem } from "./maintenance";
import type { OpsSnapshot } from "./ops-types";
import { readSnapshot } from "./ops-snapshot";

// The daily maintenance pass's undeployed-merge rule (job_549550d73d4e, piece 5). Carrel sat
// four days behind its default branch before anyone noticed. A site's live Worker is
// behind when its newest Cloudflare deployment is older than the last commit on its repo's
// default branch, and that commit is more than GRACE_HOURS old, so a deploy still running
// after a merge is not listed. A site whose health route reports the default branch's head
// sha is deployed, whatever the dates say.
//
// The deployments come from the watcher's last snapshot (src/ops-cloudflare.ts), so the pass
// costs no Cloudflare read of its own; the default branch costs two GitHub reads per site
// (the repository, for its default branch's name, then that branch's head).
// A site the snapshot could not read on Cloudflare is listed as not checked; no snapshot at
// all is listed under capsid, whose watcher writes it. A site not on
// Cloudflare (a Vercel site) has no Worker and is left out.

const GRACE_HOURS = 2;
const MAX_ITEMS = 50;

export interface DefaultHead {
  repo: string;
  branch: string;
  sha: string;
  committed_at: string;
}

export interface DeployReaders {
  /** The watcher's last snapshot, or null when there is none. */
  snapshot(): Promise<OpsSnapshot | null>;
  /** The head commit of the namespace's repo's default branch. Throws when not read. */
  defaultHead(namespace: string): Promise<DefaultHead>;
}

const days = (ms: number): string => `${(ms / 86_400_000).toFixed(1)} days`;

/** Whether two shas name the same commit, when either may be abbreviated. */
function sameSha(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** The line for a site whose newest deployment predates its default branch's head, or null. */
export function behind(
  site: { namespace: string; script: string; deployed_on: string; live_sha: string | null },
  head: DefaultHead,
  now: Date
): MaintenanceItem | null {
  if (site.live_sha && sameSha(site.live_sha, head.sha)) return null;
  const merged = Date.parse(head.committed_at);
  const deployed = Date.parse(site.deployed_on);
  if (!(deployed < merged) || now.getTime() - merged < GRACE_HOURS * 3_600_000) return null;
  return {
    rule: "undeployed-merge",
    namespace: site.namespace,
    job: null,
    line: `${site.script} was last deployed ${site.deployed_on.slice(0, 16).replace("T", " ")} UTC, ${days(merged - deployed)} before ${head.repo}'s last commit on ${head.branch} (${head.sha.slice(0, 7)}): deploy it, or say why it waits.`,
  };
}

export async function gatherDeployItems(readers: DeployReaders, now: Date): Promise<{ items: MaintenanceItem[]; read: Record<string, number> }> {
  const items: MaintenanceItem[] = [];
  const read: Record<string, number> = {};
  let snapshot: OpsSnapshot | null;
  try {
    snapshot = await readers.snapshot();
  } catch (err) {
    return { items: [notChecked("capsid", `the watcher snapshot: ${err instanceof Error ? err.message : String(err)}`)], read };
  }
  if (!snapshot) return { items: [notChecked("capsid", "the watcher has written no snapshot yet")], read };
  for (const site of snapshot.sites) {
    const cf = site.cloudflare;
    if (!cf || cf.state === "not-cloudflare") continue;
    if (cf.state !== "ok") {
      items.push(notChecked(site.namespace, `Cloudflare was not read for it (${cf.reason})`));
      continue;
    }
    const newest = cf.deploys[0];
    if (!newest) {
      items.push(notChecked(site.namespace, `${cf.script} lists no deployment`));
      continue;
    }
    let head: DefaultHead;
    try {
      head = await readers.defaultHead(site.namespace);
    } catch (err) {
      items.push(notChecked(site.namespace, `its default branch: ${err instanceof Error ? err.message : String(err)}`));
      continue;
    }
    read[site.namespace] = 1;
    const item = behind({ namespace: site.namespace, script: cf.script, deployed_on: newest.created_on, live_sha: site.sha }, head, now);
    if (item && items.filter((i) => i.rule === "undeployed-merge").length < MAX_ITEMS) items.push(item);
  }
  return { items, read };
}

function notChecked(namespace: string, problem: string): MaintenanceItem {
  return { rule: "deploys-not-checked", namespace, job: null, line: `Deploys in ${namespace} were not checked (${problem}): what is missing is not a clean result.` };
}

/** The readers: the watcher's snapshot from APP_KV, and the default branch's head commit
 *  through the App. */
export function githubDeployReaders(env: Env): DeployReaders {
  return {
    snapshot: () => readSnapshot(env),
    async defaultHead(namespace) {
      const { owner, repo, full } = await resolveRepo(env, namespace);
      const meta = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}`);
      if (!meta.ok) {
        await meta.body?.cancel();
        throw new Error(`the repository read returned ${meta.status}`);
      }
      const branch = ((await meta.json()) as { default_branch?: string }).default_branch;
      if (!branch) throw new Error("the repository names no default branch");
      const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`);
      if (!resp.ok) {
        await resp.body?.cancel();
        throw new Error(`the ${branch} read returned ${resp.status}`);
      }
      const commit = (await resp.json()) as { sha?: string; commit?: { committer?: { date?: string } } };
      const date = commit.commit?.committer?.date;
      if (!commit.sha || !date) throw new Error(`the ${branch} head carries no sha or committer date`);
      return { repo: full, branch, sha: commit.sha, committed_at: date };
    },
  };
}
