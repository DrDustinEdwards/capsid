# Autonomy

What the machine may do with no human in the loop. Each policy lives in two places: a reviewable file in `docs/policy/`, and the copy the Worker actually reads, a signed document in the store. An unsigned copy, or one edited after signing, authorizes nothing.

Both ship with `enabled: false`, and **both are now on**: gates since 2026-09-13 under signature `a999f926`, auto-merge since 2026-09-16 under `dcde046a`. **The signed store document is the authority for that value, not this file.** Turning one on is a ruling that lands in the audit log, and nothing in this repo is gated against it: this paragraph read "Both policies ship disabled" until 2026-09-16, by which point it had been wrong about gates for three days.

**Auto-merge** (`docs/policy/auto-merge.md`, read from `capsid/policy/auto-merge.md`).
The five-minute tick walks every open pull request on the namespaces the policy names
and merges only those that pass all eleven checks, evaluated in order, each refusing on
its own. **A merge is a deploy on any repo that deploys on merge to its default branch**,
so passing these checks there ships to production with no human. That is why version 5
names dustinedwards only: a capsid merge deploys the control plane, so capsid pull
requests are merged by the seat (ruled 2026-09-25).

| check | what it requires |
| --- | --- |
| `paths_not_refused` | the changed-file list was read whole, and no path matches the policy's refused paths: the scorer and its scripts, the holdout suite, the policy and signer sources, the protected path list, migrations, wrangler config, secrets, the files that define the checks, and the two sources that write what `pr_recorded_for_job` reads |
| `paths_not_money` | no changed path names a billing or payment surface |
| `no_migration_workflow_lockfile` | no changed path is a migration, a workflow or a lockfile |
| `head_in_base_repo` | the PR's head branch is on the base repo, not a fork |
| `body_names_job` | the PR body carries the id of the job the work came from |
| `pr_author_allowed` | the GitHub account that opened the PR is on the signed document's author allowlist (`DrDustinEdwards` and `capsid-repo-access[bot]` in version 5) |
| `author_is_driver` | that job was claimed by a minted, unrevoked agent of kind `driver` |
| `job_handed_on` | that job is `blocked` or `done` |
| `pr_recorded_for_job` | the job's `result_ref` or one of its `job_outcome_prs` rows names this PR |
| `base_is_default_branch` | the PR targets the repo's default branch |
| `ci_green` | every check run on the head sha completed and concluded success, skipped or neutral, at least one reported, and the CI run on that sha ran the typecheck step (all four configs), the lint step, the unit suite and the integration suite to success |

Tests, `src/`, docs, `CLAUDE.md` and `.claude/` merge on green since policy version 2 (2026-09-17). The improve loop's `PROTECTED_PATH_PATTERNS` still decides what the loop may edit and no longer decides what auto-merges.

The document names the checks, the refused paths and the required CI steps, and the code
enforces them. A document that disagrees with the code on any of the three is refused at load time. A test asserts the two agree in
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
credential the driver agents were minted to replace. The scheduler is off twice over:
nothing is created without `--apply`, and an installed task is created disabled.

## The watcher

A half-hourly step on the five-minute tick that reads the surface and, when something is wrong, posts a job. That is all it does. It holds no blast-radius flag, it is scoped to `jobs.post`, and it cannot claim what it posts or fix what it found.

- **What it reads.** `/health` against master (degraded store, a deployed sha that is not master head, a backup older than the window or that never ran, a live schema behind the newest migration); `improve_status` (a pause the loop set itself, a monthly cap over 80 percent); blocked jobs older than a day; CI on each roster repo's default branch, red for more than two hours; and the off-account mirror, where it reads the newest dump directory under `backups/json/` and reports a dump older than 36 hours, naming which of three things happened from the mirror workflow's latest conclusion. The mirror check keys on the dump rather than on the run, because during the 2026-09-09 outage the mirror requested a valid credential and its run started every day while nothing landed.
- **A healthy surface posts nothing.** A pause a human set is not a finding.
- **Deduplication is the queue's own rule.** The finding's fingerprint goes in the job title, and `post` already refuses a duplicate while one is open, so a finding posts once and stays posted until it clears. A finding that stops being found has its job failed with `cleared`, keyed on `queued` so a job a driver has claimed is never closed underneath it.
- **Cadence** is `watcher:cadence-minutes` in `APP_KV`, 30 by default, with a floor of 5. It rides the tick before the budget check, with the lease sweep and auto-merge. It spends no model tokens and no CI minutes. An exhausted budget is when nobody is looking.
