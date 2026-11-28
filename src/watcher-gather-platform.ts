import { mapLimit } from "./map-limit";
import { DEPLOY_ROSTER, readDeployOutcomes, deployFindings } from "./deploy-outcomes";
import { defaultBranchSha, ciStatus, listRepoTree } from "./github";
import { healthReport } from "./health";
import { logEvent } from "@dustinedwards/site-runtime/log";
import { OFFACCOUNT_REPORT_KEY, OFFACCOUNT_SITES, OFFACCOUNT_SOURCES } from "./offaccount";
import { readResources } from "./system-facts-store";
import { APP_ROSTER } from "./roster";
import { readStaleCanon } from "./stale-canon";
import {
  type DeployVerdict,
  deployVerdict,
  healthFindings,
  type CiRun,
  ciFindings,
} from "./watcher-detect";
import {
  BACKUPS_REPO_LABEL,
  type OffaccountReport,
  type WorkflowRun,
  offaccountFindings,
  offaccountDrillFindings,
  offaccountCoverageFindings,
  parseDumpStamp,
} from "./watcher-offaccount";
import { attempt, READ_CONCURRENCY, type Pass } from "./watcher-gather-base";

// The first phase of the watcher's reads (src/watcher-gather.ts): Capsid's own health and status, the
// off-account copy, the roster's CI and deploys, and stale canon. Returns the health report the site probes use.

// A run id as an ISO time, or null for none or a name that is not a run id.
const dumpTime = (run: string | null): string | null =>
  run ? (parseDumpStamp(run)?.toISOString() ?? null) : null;

const basename = (path: string): string => path.split("/").filter(Boolean).pop() ?? "";

// The newest migration filename on master, compared against the live schema_version. Sorted by
// name: the files are zero-padded.
export function newestMigration(names: string[]): string | null {
  const sql = names.filter((n) => n.endsWith(".sql")).sort();
  return sql.length ? sql[sql.length - 1] : null;
}

export async function gatherPlatform({ env, now, out, ran, observed }: Pass) {
  // No casts on a repo reader's result, so a renamed field fails `npm run check`.
  // attempt() swallows a throw, so a cast would hide a check that never runs.
  // test/watcher-gather.test.ts drives both reads end to end.
  const health = await attempt("health", () => healthReport(env));
  observed.health = health;
  if (health) {
    ran.add("health");
    const head = await attempt("master head", () => defaultBranchSha(env, "capsid"));
    // Master head's own CI run, read only when the deployed sha differs. A deploy
    // still in flight leaves the check un-judged this pass: nothing is posted and an
    // open drift finding is not cleared on it.
    let deploy: DeployVerdict | undefined;
    if (head !== null && health.sha && health.sha !== "unknown" && health.sha !== head) {
      const runs = await attempt(
        "head ci run",
        async () => (await ciStatus(env, "capsid", undefined, { ref: head, limit: 10 })).runs,
      );
      deploy = deployVerdict(runs, now);
    }
    if (head !== null && !deploy?.wait) ran.add("master head");
    // Wrapped in an object so a tree with no migrations (null) is told apart from a
    // read that failed (also null from attempt).
    const migrations = await attempt("migrations", async () => {
      const tree = await listRepoTree(env, "capsid", "migrations");
      return { newest: newestMigration(tree.entries.map((e) => basename(e.path))) };
    });
    if (migrations !== null) ran.add("migrations");
    out.push(...healthFindings(health, head ?? null, migrations?.newest ?? null, "capsid", deploy));
  }

  // The Amazon copy, as capsid-backups' watch.yml last reported it (src/offaccount.ts). An
  // unreadable report skips the check: "cannot see the copy" is not "the copy is dead".
  const report = await attempt("offaccount report", async () => ({
    value: await env.APP_KV.get<OffaccountReport>(OFFACCOUNT_REPORT_KEY, "json"),
  }));
  const copyRuns: WorkflowRun[] | null = await attempt(
    "offaccount runs",
    async () =>
      (await ciStatus(env, "capsid", BACKUPS_REPO_LABEL, { workflow: "offaccount.yml", limit: 5 }))
        .runs,
  );
  const lastCopy = copyRuns?.find((r) => r.status === "completed") ?? null;
  if (report) {
    ran.add("offaccount");
    out.push(...offaccountFindings("capsid", OFFACCOUNT_SITES, report.value, lastCopy, now));
  }
  // The restore drill's own runs, so a monthly drill is not pushed out by the nightly ones.
  const drillRuns: WorkflowRun[] | null = await attempt(
    "offaccount drill",
    async () =>
      (await ciStatus(env, "capsid", BACKUPS_REPO_LABEL, { workflow: "drill.yml", limit: 10 }))
        .runs,
  );
  if (drillRuns) {
    ran.add("offaccount drill");
    out.push(...offaccountDrillFindings("capsid", drillRuns, now));
  }
  // Every D1 database a Worker binds against the ones copied, from the nightly resources
  // model. Before the first build there is nothing to compare, so the check does not run.
  const resources = await attempt("offaccount coverage", () => readResources(env));
  if (resources) {
    ran.add("offaccount coverage");
    out.push(
      ...offaccountCoverageFindings(
        "capsid",
        OFFACCOUNT_SITES.map((s) => OFFACCOUNT_SOURCES[s].database),
        resources.databases,
      ),
    );
  }
  const run = (r: WorkflowRun | null | undefined) =>
    r ? { at: r.created_at ?? null, conclusion: r.conclusion ?? null, url: r.url ?? null } : null;
  if (report) {
    observed.offaccount = {
      reported_at: report.value?.received_at ?? null,
      sites: OFFACCOUNT_SITES.map((site) => ({
        site,
        newest: dumpTime(report.value?.sites[site]?.newest ?? null),
      })),
      last_run: run(lastCopy),
      last_drill: run(
        drillRuns?.find((r) => r.status === "completed" && r.conclusion === "success"),
      ),
    };
  }

  // The ci check counts as run only when every roster repo was read. A ci-red
  // fingerprint names its namespace, but ownership is per check, not per repo, so a
  // repo that could not be read must not let the others' pass clear its incident.
  let ciRead = 0;
  const ciRuns = await mapLimit(APP_ROSTER, READ_CONCURRENCY, (namespace) =>
    attempt(
      `ci ${namespace}`,
      async (): Promise<CiRun[]> => (await ciStatus(env, namespace, undefined, { limit: 5 })).runs,
    ),
  );
  APP_ROSTER.forEach((namespace, i) => {
    const runs = ciRuns[i] ?? null;
    if (runs) {
      ciRead++;
      out.push(...ciFindings(namespace, runs, now));
    }
    const latest = runs?.find((r) => r.status === "completed") ?? runs?.[0] ?? null;
    observed.ci.push({
      namespace,
      latest: latest
        ? {
            head_sha: latest.head_sha,
            status: latest.status,
            conclusion: latest.conclusion,
            created_at: latest.created_at,
            url: latest.url ?? null,
          }
        : null,
    });
  });
  if (ciRead === APP_ROSTER.length) ran.add("ci");

  let deploysRead = 0;
  const deployReads = await mapLimit(
    DEPLOY_ROSTER,
    READ_CONCURRENCY,
    // Wrapped, since a repo with no deploy yet reads as null and a failed read does too.
    ({ key, namespace, selector, workflow }) =>
      attempt(`deploys ${key}`, async () => ({
        newest: await readDeployOutcomes(env, namespace, selector, workflow),
      })),
  );
  DEPLOY_ROSTER.forEach(({ key, namespace }, i) => {
    const read = deployReads[i];
    if (!read) return;
    deploysRead++;
    if (read.newest) out.push(...deployFindings(namespace, read.newest, key));
  });
  if (deploysRead === DEPLOY_ROSTER.length) ran.add("deploys");

  // Canon documents a merged pull request left citing a removed, renamed or changed file
  // (src/stale-canon.ts, improvement item 23). A digest finding: it
  // clears when the document is next written or stops citing the path.
  const staleCanon = await attempt("stale canon", () => readStaleCanon(env, now));
  if (staleCanon) {
    if (staleCanon.complete) ran.add("stale canon");
    out.push(...staleCanon.findings);
    logEvent("WATCHER_STALE_CANON", { message: `WATCHER_STALE_CANON ${staleCanon.note}` });
  }
  return health;
}
