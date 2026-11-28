# Autonomy

What the machine may do with no human in the loop. The one policy is the pre-approved gates: a reviewable file in `docs/policy/`, and the copy the Worker actually reads, a signed document in the store. An unsigned copy, or one edited after signing, authorizes nothing.

It ships with `enabled: false` and has been on since 2026-09-13 under signature `a999f926`. **The signed store document is the authority for that value, not this file.**

**Merges.** Capsid runs no merge loop (Dustin, 2026-11-28). A pull request merges on green, by the project thread that opened it or by GitHub's native auto-merge. The signed auto-merge policy and every merge hold built on it were retired: the merge classes' holds, the approval record and its executor, the merge units, and the safety meter and shutoff. `src/merge-class.ts` keeps only the path class (`pathClassOf`), which the D5 reviewer reads to decide whether a pull request is worth a review.

**Pre-approved gates** (`docs/policy/gates.md`, read from `capsid/policy/gates.md`). A
driver that reaches a push, a migration or a pull request blocks with the exact command,
and every one of those waits on a person. This policy lets the seat send a bounded one
back itself: `capsid_work_jobs` action `resume` with `approved_by_policy` set to the document's
version, refused unless the blocked command matches one of three classes. A driver may
do the same for a job it blocked itself, but only when every class matched is
`push_branch` or `open_pr` (ruled 2026-09-16). A migration stays the seat's to approve,
and a driver cannot approve another agent's job. Outside the policy, a driver cannot
resume a blocked job at all: a plain resume is refused unless the caller is the admin or
holds `can_merge`, for the job's claimant (2026-09-25) and for any other driver in the
namespace (Grok audit 2026-10, S1).
`additive_migration` is a `wrangler d1 execute` naming a `--file` under `migrations/`
whose every statement is `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` or
`CREATE INDEX`. An unrecognized statement form is a refusal, not a pass.
`push_branch` is a `git push origin <branch>` for a branch that is not `master` or
`main`, with no force flag. `open_pr` is a `gh pr create`. A never-list is checked over
the whole command before any class is tried: secrets, revocations, force pushes, pushes
to a default branch, `wrangler deploy` and `rollback`, mode changes, drops and deletes,
and merging a pull request. The audit row records which
class matched and what it matched on.

**Signing is admin only.** `capsid_admin_manage_switches` action `sign_policy` signs the body already
stored rather than any body the caller supplies, only in the `capsid` namespace and
only under `policy/`, and only when the caller names the sha256 of the body it read. A
minted agent is refused outright. Turning a policy on is
two acts: editing the document, which is on the ordinary write tool's refusal list and
needs `allow_improve_paths` plus `can_touch_protected`, and signing it again afterwards.

**Only the body signed last loads.** `sign_policy` records the sha256 and version of the
body it signs in APP_KV under `policy:signed:<path>` before it stores the document, and
the loader refuses a signed body with any other hash. An older signed version put back
with `capsid_write_doc` action `restore` or a write is refused until it is signed again. Re-signing the same body
writes the same record. When the key is absent (the first load after this shipped, or
after the key is deleted), the load records whatever signed body is stored at that
moment. The key is not in the backup's KV pins: after a D1 restore to an older policy,
the loader refuses it until the seat signs it again.

**Sessions start by hand**: routine firing was removed on 2026-10-31 (Dustin; project threads do the work). A session that takes a job marks it started with `begin` and completes it by naming its pull request. The overnight switch and the plan and digest views are in docs/overnight.md.

## The watcher

A half-hourly step on the five-minute tick that reads the surface and, when something needs a person, posts a job. That is all it does. It holds no blast-radius flag, it is scoped to `capsid_work_jobs.post`, and it cannot claim what it posts or fix what it found.

- **What it reads.** `/health` against master (degraded store, a deployed sha that is not master head, a backup older than the window or that never ran, a live schema behind the newest migration); `capsid_read_status` action `status` (a namespace whose queue circuit breaker is open); CI on each roster repo's default branch, red for more than two hours; and the Amazon backup copy, where it reads the report capsid-backups last sent (docs/backups.md) and reports any site whose newest complete copy is older than 36 hours, a site with no copy, and a report older than 13 hours, with the copy workflow's latest conclusion as evidence. The check keys on the copy's own dump time rather than on the run, because during the 2026-09-09 outage the old git mirror requested a valid credential and its run started every day while nothing landed. The live checks (`docs/live-checks.md`) read what `capsid/policy/live-checks.md` names: a site's deployed sha against its default branch, and the Web Analytics beacon and CSP on its pages. With no such document they do not run.
- **Only actionable findings post jobs** (job_2c92174d5bff item 5; every alert actionable, the rest to a digest). Each fingerprint pattern has a class beside `OWNERS` in `src/watcher.ts` (`findingClass`), and `test/watcher-classes.test.ts` fails when the two tables disagree. **job**: site down, error rate, deploy rolled back or rollback failed, stale or never-run backup and the Amazon copy findings, domain expiry, CI red over two hours, schema behind, degraded health, deploy drift, site map drift, unmapped repos, an invalid or unknown-site live-checks config, an unhealthy site after self-repair. **digest**: CSP, security headers, analytics setting and beacon (`live-*` other than the config findings, including `live-sha-*` and the unread-page findings), `site-weekly-*` and stale canon (`stale-canon-*`). **attention**: agent anomalies (`anomaly-*`) and open queue breakers (`breaker-open-`). A digest or attention finding is still recorded in `watcher_findings`, open with no job, so the Portal can show it and a clear works; it posts nothing. An open queued job for a finding that has become digest or attention class is failed as `cleared: moved to the weekly digest` (or `the Portal's attention list`) on the next pass, through the same keyed clear and audit (`job-cleared`) as a gone finding; a claimed or blocked job is left to its holder. The weekly digest per site is the open digest-class rows grouped by namespace: the Portal's Needs you page shows it as the Weekly digest panel, and the daily email (docs/portal.md, "Daily digest") adds the same list on Mondays UTC.
- **A healthy surface posts nothing.** A pause a human set is not a finding.
- **Agents out of pattern** (`src/anomaly.ts`, OWASP item 6; Dustin, D4 of 2026-10-03). Each pass reads audit_log for minted agents (`agent:*`, the watcher itself excepted), counted per actor, action and hour, and compares the last 24 hours with the 14 days before them. A finding when an agent writes an action it never wrote in its baseline (`anomaly-new-action-<agent>-<action>`); when its busiest hour is over three times its busiest baseline hour and at least 30 rows (`anomaly-rate-<agent>`); or when an agent with no baseline is first used between 00:00 and 06:00 Chicago time (`anomaly-first-use-<agent>`). A hit is a finding and a warning row in the Portal's Needs attention, nothing more: nothing is suspended or revoked until two weeks of false positives are measured (a person who fails the finding's job as expected adds to that count). A hit clears itself once it falls out of the 24-hour window. What writes no audit row (most reads) is not seen. Tests: test/anomaly.test.ts, test-integration/anomaly.test.ts.
- **Domain registrations** (`src/domain-expiry.ts`; job_5ac1139641e0, design-portal-insight.md section 5, pulled forward by Dustin on 2026-10-07). The registrable domain of each configured site's origin (hosting suffixes such as workers.dev and vercel.app left out) is read by RDAP: the IANA bootstrap (`data.iana.org/rdap/dns.json`, kept a week in KV) names the registry's server, and its `expiration` event is kept a day, so a domain costs about one RDAP call a day. A finding 30 days before expiry (`domain-expiry-30d-<domain>`) and a new one 7 days before (`domain-expiry-7d-<domain>`), so the last week posts again even if the first was dismissed. A domain that could not be read is logged (`WATCHER_DOMAIN_UNREAD`) and the check does not count as run, so an open finding is never cleared by a failed read. Tests: test/domain-expiry.test.ts.
- **Stale canon after a merge** (`src/stale-canon.ts`; improvement item 23). Each pass lists every mapped namespace's newest closed pull requests (primary repo, 20 per list, at most 20 namespaces) and reads the files of up to 5 new merges into the default branch, kept in `APP_KV` under `stale-canon:merges` for 30 days. A canon document (a canon path in `src/canon.ts`, or type core, spec, protocol, procedural or reference; never `archive/`, `research/`, `reports/`, `audits/`, `jobs/`, superseded or closed) is flagged when it cites a file a merge deleted or renamed, by path in its body or by a typed edge to `<namespace>/<path>`, or has an edge to a file a merge modified. One digest finding per document and pull request (`stale-canon-<namespace>-<pr>-<tag>`), naming the document, the pull request and each cited path. Nothing is rewritten. A document written after the merge is not flagged, so writing it, dropping the citation or the merge leaving the window clears the finding. A document that describes the old behavior in words without a path is not caught. Tests: test/stale-canon.test.ts.
- **Deploys** (`src/deploy-outcomes.ts`, table `deploy_outcomes`, migrations/0039). For each deploy roster repo (the five app repos plus carrel, julieedwards, txasm, bsw, capsomer, enarratio and prelum), the newest three completed push runs on its default branch: a run whose job named "live gate" (or "<caller job> / live gate" when the gate runs in a called workflow such as devkit's worker-deploy.yml, as carrel's does) ran is recorded once as `verified`, `rolled_back` (with where production went, from the rollback step's annotation), `rollback_failed` (the rollback did not take effect), `rollback_skipped` (the guard declined to roll back) or `unverified` (the gate failed with no rollback), with the pull request GitHub links to the commit, and for a rollback its time to restore (`restore_seconds`, migrations/0056: from the end of the gate's own deploy job to the end of the rollback step). GitHub serves no step summary through its API, so the outcome comes from the job's conclusion, its rollback step's conclusion and its check-run annotations. A known run is read from D1, not GitHub. The newest recorded deploy raises a finding when it was rolled back (`deploy-rolled-back-<namespace>`) or its rollback did not take effect (`deploy-rollback-failed-<namespace>`); a later verified deploy clears it. The check counts as run only when every repo was read. No CI secret is added: the App already reads CI. Tests: test/deploy-outcomes.test.ts and test-integration/deploy-outcomes.test.ts.
- **Deduplication.** The finding's fingerprint goes in the job title, and `post` refuses a duplicate while one is open. A finding that stops being found has its job failed with `cleared`, keyed on `queued` so a job a driver has claimed is never closed underneath it.
- **Finding memory.** An open job alone forgot a finding the moment a person ended it: the site-map drift finding was filed again within an hour of the seat superseding it. So the watcher keeps one row per fingerprint in `watcher_findings` (`src/watcher-findings.ts`, migration 0024), across jobs, in one of three states:
  - **open**: its job is open (a digest or attention finding is open with no job). Each pass that sees it adds one to `seen_count`, sets `last_seen_at` and appends the evidence, keeping the newest 20 sightings. Nothing is posted.
  - **dismissed**: its job left the open set some way other than the watcher's own `cleared` (superseded, failed, done) while the condition still held. The person's ending holds: the finding is counted and not filed again until it clears.
  - **cleared**: its owning check ran and did not see it. `cleared_at` is set, and `reopen_after` is six hours later (`REOPEN_QUIET_MS`, the quiet period). A cleared finding seen again inside the quiet period is counted and not filed; seen after it, it is filed as a new job and the row is open again. A dismissed finding that stops being seen clears the same way.

  A finding with no row is filed. An open job with no row (posted before the table) is adopted rather than filed again. Every write is keyed on the fingerprint, and a state move is guarded on the state it was read in, so the tick and the Portal's Refresh cannot both move a row; a lost move is logged as `WATCHER_FINDING_MOVED`.

- **CI red is one incident per namespace.** The fingerprint is `ci-red-<namespace>`, and the head sha of each sighting is evidence. It carried the sha until 2026-09-29, and ci-red was filed 13 times between 2026-09-20 and 09-23 as each red commit became a new finding.
- **Cadence** is `watcher:cadence-minutes` in `APP_KV`, 30 by default, with a floor of 5. It rides the five-minute tick. It spends no model tokens and no CI minutes.
- **It keeps each pass in `ops:snapshot`** (`APP_KV`, `src/ops-snapshot.ts`), the data the operations dashboard reads (capsid/research/design-ops-console.md). The snapshot holds:
  - every check as clear, finding or could not run;
  - `/health`;
  - the Amazon copy's report: each site's newest complete copy and the copy workflow's last run;
  - each roster repo's latest CI run;
  - the Portal's site configuration compared with the registered namespaces;
  - a probe of every configured site (`ops_sites`, docs/portal.md), and none when nothing is configured;
  - Cloudflare's view of each site: its last ten deploys and 24 hourly buckets of requests and errors.

  **Probes.** Each site's health route is read, or its root where it has none, and the root as well when the health route fails. So a broken health route on a site that is up reads as degraded, not down. Capsid itself is read in-process.

  **Uptime ring.** Each site keeps a 7-day ring of half-hour slots aligned to the clock. A slot no pass reached is marked as no data, never as up.

  **Reading it over MCP.** `capsid_admin_read_ops` action `snapshot` (admin only) returns the snapshot whole, or one site's entry with `site`, or one half-hour slot of that site's ring with `site` and `slot` (0 the newest, up to 335) or `at` (an ISO time). A slot reads `up`, `down`, `no-pass` or `outside-ring` (older than the history the ring holds yet), with the half hour it covers. No snapshot yet, or one that does not parse, is a named error.

  **Write order.** The snapshot is written before `watcher:last`, so a snapshot that cannot be written fails the pass and the next tick runs it again.

  **Site map.** A registered namespace the map neither covers nor lists as having no site, or a map entry whose namespace is not registered, is a finding.

  **Cloudflare.** `src/ops-cloudflare.ts` reads Cloudflare once per pass, never per feed request (only a site page's traffic and deploys tabs read it, when opened; docs/portal.md, "Routes"), with `CF_OPS_TOKEN`, a read-only token holding Workers Scripts Read and Account Analytics Read (and Workers CI Read for `capsid_admin_read_ops` actions `builds` and `build_logs`, docs/portal.md, "The Cloudflare token"). The account is `CF_ACCOUNT_ID`, or `R2_ACCOUNT_ID` where that is unset. A site's script is named in the map only where the host proves it (a `workers.dev` host's first label); any other site is resolved from the account's Workers custom domains, and one that resolves to nothing is shown as unresolved, never guessed. Deploys come from the script's deployments list. Errors come from one GraphQL Analytics query for every script (`workersInvocationsAdaptive`). A query that fails is shown as no data with its reason, never as zeros. With no token nothing is fetched, each site says what is unset, and the `cloudflare` check shows as could not run. Cloudflare records only deployments that happened, so a failed deploy is not visible here; a failed deploy workflow is already the `ci-red` finding.

  **Site down.** A site whose previous ring slot is `0` and whose probe this pass is down too, two failed probes in a row, is a finding (`site-down-<namespace>`, owned by the probes).

  **Error rate.** A Worker that errored on more than 1 percent of at least 100 requests in the most recent complete hour is a finding (`site-errors-<namespace>`, owned by the `cloudflare` check, so it clears only on a pass where Cloudflare was read in full).
