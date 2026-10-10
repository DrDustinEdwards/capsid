# Autonomy

What the machine may do with no human in the loop. Each policy lives in two places: a reviewable file in `docs/policy/`, and the copy the Worker actually reads, a signed document in the store. An unsigned copy, or one edited after signing, authorizes nothing.

Both ship with `enabled: false`, and **both are now on**: gates since 2026-09-13 under signature `a999f926`, auto-merge since 2026-09-16 under `dcde046a`. **The signed store document is the authority for that value, not this file.** Turning one on is a ruling that lands in the audit log, and nothing in this repo is gated against it: this paragraph read "Both policies ship disabled" until 2026-09-16, by which point it had been wrong about gates for three days.

**Auto-merge** (`docs/policy/auto-merge.md`, read from `capsid/policy/auto-merge.md`).
The five-minute tick walks every open pull request on the namespaces the policy names
and merges only those that pass all twelve checks, evaluated in order, each refusing on
its own. **A merge is a deploy on any repo that deploys on merge to its default branch**,
so passing these checks there ships to production with no human. Version 6 names
dustinedwards, carrel, capsomer and capsid. capsid was taken out on 2026-09-25 because a
capsid merge deploys the control plane, put back with no limit on 2026-10-07, and limited
by version 6 (D6 of 2026-10-03, confirmed 2026-10-09) to docs-only PRs outside
`docs/policy/` and dashboard CSS-only PRs; its tests, Portal scripts and every other path
wait for the seat. carrel and capsomer joined for auto-merge only on 2026-10-08.

| check | what it requires |
| --- | --- |
| `paths_not_refused` | the changed-file list was read whole, and no path matches the policy's refused paths: the scorer and its scripts, the holdout suite, the policy and signer sources, the protected path list, migrations, wrangler config, secrets, the files that define the checks, and the two sources that write what `pr_recorded_for_job` reads |
| `paths_not_money` | no changed path names a billing or payment surface |
| `no_migration_workflow_lockfile` | no changed path is a migration, a workflow or a lockfile |
| `paths_allowed_for_namespace` | for a namespace with allowed paths (capsid: `docs/` outside `docs/policy/`, and `dashboard/**/*.css`), every changed path, old names of renamed files included, is inside them |
| `head_in_base_repo` | the PR's head branch is on the base repo, not a fork |
| `body_names_job` | the PR body carries the id of the job the work came from |
| `pr_author_allowed` | the GitHub account that opened the PR is on the signed document's author allowlist (`DrDustinEdwards` and `capsid-repo-access[bot]` in version 6) |
| `author_is_driver` | that job was claimed by a minted, unrevoked agent of kind `driver` |
| `job_handed_on` | that job is `blocked` or `done` |
| `pr_recorded_for_job` | the job's `result_ref` or one of its `job_outcome_prs` rows names this PR |
| `base_is_default_branch` | the PR targets the repo's default branch |
| `ci_green` | every check run on the head sha completed and concluded success, skipped or neutral, at least one reported, and the CI run on that sha ran the typecheck step (all four configs), the lint step, the unit suite and the integration suite to success |

Tests, `src/`, docs, `CLAUDE.md` and `.claude/` pass the refused-path check since policy version 2 (2026-09-17); in capsid, version 6 then holds all but docs and dashboard CSS for the seat. The improve loop's `PROTECTED_PATH_PATTERNS` still decides what the loop may edit and no longer decides what auto-merges.

The document names the checks, the refused paths, the allowed paths and the required CI steps, and the code
enforces them. A document that disagrees with the code on any of the four is refused at load time. A test asserts the two agree in
both directions. The PR author allowlist is the exception: it is carried only in the
signed document, the code holds no copy, and a document that names no author does not
load. A pull request failing any check is left open, audited with the check
that refused it, and reported under `improve_status` as awaiting the seat.

**Pre-approved gates** (`docs/policy/gates.md`, read from `capsid/policy/gates.md`). A
driver that reaches a push, a migration or a pull request blocks with the exact command,
and every one of those waits on a person. This policy lets the seat send a bounded one
back itself: `jobs` action `resume` with `approved_by_policy` set to the document's
version, refused unless the blocked command matches one of three classes. A driver may
do the same for a job it blocked itself, but only when every class matched is
`push_branch` or `open_pr` (ruled 2026-09-16). A migration stays the seat's to approve,
and a driver cannot approve another agent's job. Outside the policy, a driver cannot
resume a job it blocked itself: a plain resume by the job's claimant is refused unless
the caller is the admin or holds `can_merge` (2026-09-25).
`additive_migration` is a `wrangler d1 execute` naming a `--file` under `migrations/`
whose every statement is `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` or
`CREATE INDEX`. An unrecognized statement form is a refusal, not a pass.
`push_branch` is a `git push origin <branch>` for a branch that is not `master` or
`main`, with no force flag. `open_pr` is a `gh pr create`. A never-list is checked over
the whole command before any class is tried: secrets, revocations, force pushes, pushes
to a default branch, `wrangler deploy` and `rollback`, mode changes, drops and deletes,
and merging a pull request, which the auto-merge policy governs instead. The audit row records which
class matched and what it matched on.

**Signing is admin only.** `improve_run` action `sign_policy` signs the body already
stored rather than any body the caller supplies, only in the `capsid` namespace and
only under `policy/`. A minted agent is refused outright. Turning a policy on is
two acts: editing the document, which is on the ordinary write tool's refusal list and
needs `allow_improve_paths` plus `can_touch_protected`, and signing it again afterwards.

**Only the body signed last loads.** `sign_policy` records the sha256 and version of the
body it signs in APP_KV under `policy:signed:<path>` before it stores the document, and
both loaders refuse a signed body with any other hash. An older signed version put back
with `restore` or a write is refused until it is signed again. Re-signing the same body
writes the same record. When the key is absent (the first load after this shipped, or
after the key is deleted), the load records whatever signed body is stored at that
moment. The key is not in the backup's KV pins: after a D1 restore to an older policy,
the loaders refuse it until the seat signs it again.

**The nightly driver runs on this machine, not in the cloud.** `scripts/schedule-drivers.mjs`
installs one Windows Task Scheduler task per project folder, each invoking `/improve work`
in that folder at 04:00 America/Chicago, so each task reaches Capsid as exactly one
driver agent from its own `~/.capsid/agent-<ns>-driver.key`. A Claude Code cloud routine
was measured and rejected: a routine can attach only claude.ai connectors, the registered
Capsid connector points at `/mcp`, the OAuth admin path, and there is no verified way to
hand a routine a secret, so a nightly routine would run the whole queue on the wide
credential the driver agents were minted to replace. The scheduler is off three times over:
nothing is created without `--apply`, an installed task is created disabled, and a run starts
only if the overnight switch is on, on the API key or on the subscription with Dustin's
recorded decision (docs/overnight.md). Hand-started tabs are the default and are unaffected.

## The watcher

A half-hourly step on the five-minute tick that reads the surface and, when something is wrong, posts a job. That is all it does. It holds no blast-radius flag, it is scoped to `jobs.post`, and it cannot claim what it posts or fix what it found.

- **What it reads.** `/health` against master (degraded store, a deployed sha that is not master head, a backup older than the window or that never ran, a live schema behind the newest migration); `improve_status` (a pause the loop set itself, a monthly cap over 80 percent, a namespace whose queue circuit breaker is open); CI on each roster repo's default branch, red for more than two hours; and the off-account mirror, where it reads the newest dump directory under `backups/json/` and reports a dump older than 36 hours, naming which of three things happened from the mirror workflow's latest conclusion. The mirror check keys on the dump rather than on the run, because during the 2026-09-09 outage the mirror requested a valid credential and its run started every day while nothing landed. The live checks (`docs/live-checks.md`) read what `capsid/policy/live-checks.md` names: a site's deployed sha against its default branch, and the Web Analytics beacon and CSP on its pages. With no such document they do not run.
- **A healthy surface posts nothing.** A pause a human set is not a finding.
- **Domain registrations** (`src/domain-expiry.ts`; job_5ac1139641e0, design-portal-insight.md section 5, pulled forward by Dustin on 2026-10-07). The registrable domain of each configured site's origin (hosting suffixes such as workers.dev and vercel.app left out) is read by RDAP: the IANA bootstrap (`data.iana.org/rdap/dns.json`, kept a week in KV) names the registry's server, and its `expiration` event is kept a day, so a domain costs about one RDAP call a day. A finding 30 days before expiry (`domain-expiry-30d-<domain>`) and a new one 7 days before (`domain-expiry-7d-<domain>`), so the last week posts again even if the first was dismissed. A domain that could not be read is logged (`WATCHER_DOMAIN_UNREAD`) and the check does not count as run, so an open finding is never cleared by a failed read. Tests: test/domain-expiry.test.ts.
- **Deduplication.** The finding's fingerprint goes in the job title, and `post` refuses a duplicate while one is open. A finding that stops being found has its job failed with `cleared`, keyed on `queued` so a job a driver has claimed is never closed underneath it.
- **Finding memory.** An open job alone forgot a finding the moment a person ended it: the site-map drift finding was filed again within an hour of the seat superseding it. So the watcher keeps one row per fingerprint in `watcher_findings` (`src/watcher-findings.ts`, migration 0024), across jobs, in one of three states:
  - **open**: its job is open. Each pass that sees it adds one to `seen_count`, sets `last_seen_at` and appends the evidence, keeping the newest 20 sightings. Nothing is posted.
  - **dismissed**: its job left the open set some way other than the watcher's own `cleared` (superseded, failed, done) while the condition still held. The person's ending holds: the finding is counted and not filed again until it clears.
  - **cleared**: its owning check ran and did not see it. `cleared_at` is set, and `reopen_after` is six hours later (`REOPEN_QUIET_MS`, the quiet period). A cleared finding seen again inside the quiet period is counted and not filed; seen after it, it is filed as a new job and the row is open again. A dismissed finding that stops being seen clears the same way.

  A finding with no row is filed. An open job with no row (posted before the table) is adopted rather than filed again. Every write is keyed on the fingerprint, and a state move is guarded on the state it was read in, so the tick and the Portal's Refresh cannot both move a row; a lost move is logged as `WATCHER_FINDING_MOVED`.
- **CI red is one incident per namespace.** The fingerprint is `ci-red-<namespace>`, and the head sha of each sighting is evidence. It carried the sha until 2026-09-29, and ci-red was filed 13 times between 2026-09-20 and 09-23 as each red commit became a new finding.
- **Cadence** is `watcher:cadence-minutes` in `APP_KV`, 30 by default, with a floor of 5. It rides the tick before the budget check, with the lease sweep and auto-merge. It spends no model tokens and no CI minutes. An exhausted budget is when nobody is looking.
- **It keeps each pass in `ops:snapshot`** (`APP_KV`, `src/ops-snapshot.ts`), the data the operations dashboard reads (capsid/research/design-ops-console.md). The snapshot holds:
  - every check as clear, finding or could not run;
  - `/health`;
  - the mirror's newest dump and last run;
  - each roster repo's latest CI run;
  - the Portal's site configuration compared with the registered namespaces;
  - a probe of every configured site (`ops_sites`, docs/portal.md), and none when nothing is configured;
  - Cloudflare's view of each site: its last ten deploys and 24 hourly buckets of requests and errors.

  **Probes.** Each site's health route is read, or its root where it has none, and the root as well when the health route fails. So a broken health route on a site that is up reads as degraded, not down. Capsid itself is read in-process.

  **Uptime ring.** Each site keeps a 7-day ring of half-hour slots aligned to the clock. A slot no pass reached is marked as no data, never as up.

  **Reading it over MCP.** `ops_snapshot` (admin only) returns the snapshot whole, or one site's entry with `site`, or one half-hour slot of that site's ring with `site` and `slot` (0 the newest, up to 335) or `at` (an ISO time). A slot reads `up`, `down`, `no-pass` or `outside-ring` (older than the history the ring holds yet), with the half hour it covers. No snapshot yet, or one that does not parse, is a named error.

  **Write order.** The snapshot is written before `watcher:last`, so a snapshot that cannot be written fails the pass and the next tick runs it again.

  **Site map.** A registered namespace the map neither covers nor lists as having no site, or a map entry whose namespace is not registered, is a finding.

  **Cloudflare.** `src/ops-cloudflare.ts` reads Cloudflare once per pass, never per dashboard request, with `CF_OPS_TOKEN`, a read-only token holding Workers Scripts Read and Account Analytics Read. The account is `CF_ACCOUNT_ID`, or `R2_ACCOUNT_ID` where that is unset. A site's script is named in the map only where the host proves it (a `workers.dev` host's first label); any other site is resolved from the account's Workers custom domains, and one that resolves to nothing is shown as unresolved, never guessed. Deploys come from the script's deployments list. Errors come from one GraphQL Analytics query for every script (`workersInvocationsAdaptive`). A query that fails is shown as no data with its reason, never as zeros. With no token nothing is fetched, each site says what is unset, and the `cloudflare` check shows as could not run. Cloudflare records only deployments that happened, so a failed deploy is not visible here; a failed deploy workflow is already the `ci-red` finding.

  **Site down.** A site whose previous ring slot is `0` and whose probe this pass is down too, two failed probes in a row, is a finding (`site-down-<namespace>`, owned by the probes).

  **Error rate.** A Worker that errored on more than 1 percent of at least 100 requests in the most recent complete hour is a finding (`site-errors-<namespace>`, owned by the `cloudflare` check, so it clears only on a pass where Cloudflare was read in full).
