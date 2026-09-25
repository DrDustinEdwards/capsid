# Auto-merge policy

What this Worker may merge with no human in the loop. This file is the reviewable
source. The copy the Worker actually reads is the signed document at
`capsid/policy/auto-merge.md` in the store, written from this file and signed with the
same key and envelope as an improve loop task document. An unsigned copy, or one
edited after signing, merges nothing.

- version: 5
- enabled: true
- namespaces: capsid, dustinedwards

This file ships the value that is signed, so `enabled` reads `true` here because the
policy is on. Turning it on or off is a ruling, and the document is on the ordinary
write tool's refusal list, so changing it needs `allow_improve_paths: true` and the
`can_touch_protected` flag, and lands in the audit log.

Version 5 adds three checks: `head_in_base_repo`, `job_handed_on` and
`pr_recorded_for_job` (audit 2026-09-25, finding F2-1). Up to version 4 the Worker
judged the job a pull request's body named and never the pull request itself. It read
who claimed that job, in any status, and did not check where the head branch lived or
whether the job's driver had ever named this pull request. Job ids are public, in
commit subjects and pull request bodies, so a fork pull request, or one opened by any
credential holding `open_pr`, that named a finished driver job merged on green CI.

Version 5 does not check the GitHub account that opened the pull request. Measured
2026-09-25: every merged capsid pull request from #47 to #86 was opened by the
`DrDustinEdwards` user account, because drivers run `gh pr create` locally, so a rule
that required the GitHub App's bot account would refuse every real driver pull request.

Version 4 adds dustinedwards and makes the required CI steps per namespace. The step
list was one array of capsid's own step names, so naming a second namespace in it
would have checked capsid's steps against another repo's workflow and refused every
pull request there: fail-closed, and also useless, because nothing would ever merge.
Ruled 2026-09-19 on `job_1c756c10f584`, which measured that dustinedwards-info's CI
shares neither the job name nor a single step name with capsid's.

The refused paths stay one list, extended with dustinedwards-info's judge files. Every
pattern here is a refusal, so a namespace inheriting another's pattern can only refuse
more, and capsid has no file matching any of the six added (measured 2026-09-19). A
refused-path list split per namespace would trade that for a second place to forget a
pattern.

Version 3 adds five refused paths. Version 2 refused the sources that run the checks
but not the sources those checks read their answers from, and each of those was a
two-step route: a green driver pull request weakens the source and merges on its own,
and the next pull request then passes the check it weakened.

Version 2 was ruled by Dustin on 2026-09-17: on capsid, a driver pull request with
green CI merges on its own unless it touches a path that changes what judges a change,
or the money. Tests, `src/`, docs, `CLAUDE.md` and `.claude/` merge on green. Version 1
refused every path on `PROTECTED_PATH_PATTERNS`, the improve loop's list, which left
every driver PR that added a test for the seat. That list is unchanged and still
governs what the loop may edit; it no longer governs this policy.

## Checks

Every one of these must pass before a pull request is merged without a human. They are
evaluated in this order, each refuses on its own, and the audit row names every check
that passed before the one that refused. The three path checks come first because they
are the never-list.

- `paths_not_refused` No changed path matches a pattern under Refused paths below. A
  changed-file list that could not be read whole is refused here, before any path is
  judged.
- `paths_not_money` No changed path names a billing or payment surface.
- `no_migration_workflow_lockfile` No changed path is a migration, a workflow, or a
  lockfile. The refused list also covers migrations and the scorer workflow. Stating
  them again means removing a pattern from one list does not open the other.
- `head_in_base_repo` The PR's head branch is on the same repo as its base. A PR from
  a fork, or one whose fork GitHub no longer reports, is left for the seat.
- `body_names_job` The PR body carries the id of the job the work came from, so a
  merged change traces back to a request somebody made.
- `author_is_driver` That job was claimed by a minted agent whose kind is `driver` and
  which has not been revoked. A job claimed by a seat, a cron agent, an operator key or
  a person is left for the seat.
- `job_handed_on` That job is `blocked` or `done`. A queued, claimed, failed or
  superseded job has not handed a PR on.
- `pr_recorded_for_job` The job's holder recorded this PR against the job: the job's
  `result_ref`, or one of its `job_outcome_prs` rows, names this PR's URL in this repo.
  Both are written by the transition keyed on the job's holder. Naming a job id in a
  PR body does not make the PR that job's work.
- `base_is_default_branch` The PR targets the repo's default branch. A PR onto a
  release or staging branch is somebody's sequencing decision, not this policy's.
- `ci_green` Every check run on the head sha has completed and concluded success,
  skipped or neutral, and at least one has reported. The newest run of each workflow
  under Required CI on the head sha also ran every step listed there to success. A
  skipped or missing step is a refusal, and so is a step list that could not be read.

## Refused paths

Each pattern is a regular expression matched case-insensitively against the
repo-relative path. The Worker holds the same list and refuses to load a document whose
list differs from it in either direction.

- path `^\.github\/workflows\/improve-score\.yml$` the scorer workflow.
- path `^scripts\/improve-report\.mjs$` the score report script.
- path `^scripts\/sync-scorer\.mjs$` the script that copies the scorer to the roster.
- path `(^|\/)improve\/holdout\/` the holdout suite manifest.
- path `^src\/improve-scorer\.ts$` the only source that reads the holdout suite.
- path `^test\/[^/]*holdout[^/]*$` a test that keeps the holdout suite away from attempt code.
- path `^src\/gate-policy\.ts$` the gate policy source.
- path `^src\/auto-merge\.ts$` the auto-merge source, which holds this list.
- path `^src\/policy-sign\.ts$` the policy signer.
- path `^src\/improve-schema\.ts$` the protected path list.
- path `^src\/scope\.ts$` isMoneyPath, which is the whole of the paths_not_money check.
- path `^src\/improve-task\.ts$` verifySignedBody, which is how loadMergePolicy decides the stored policy is signed.
- path `^src\/auth\.ts$` the HMAC and the constant-time comparison that verifier delegates to.
- path `^src\/encoding\.ts$` the hex encoding of the signature that verifier compares.
- path `^src\/github\/client\.ts$` the reader that supplies the changed paths and the CI facts every check judges.
- path `^scripts\/path-guard\.mjs$` the driver's enforcement of the protected path list.
- path `^\.github\/workflows\/` any workflow, which is what CI runs.
- path `^scripts\/check-[^/]*\.mjs$` a check script, which is what the Gates step runs.
- path `^scripts\/lib\/` the library those check scripts read their rules from.
- path `(^|\/)\.aislop\/` the slop checker's word lists and allowances.
- path `(^|\/)workers\/` a worker that ships beside the site.
- path `(^|\/)package-lock\.json$` the lockfile CI installs from.
- path `(^|\/)migrations\/` a migration, which runs against the live database.
- path `(^|\/)wrangler\.(jsonc?|toml)(\.example)?$` deployment configuration.
- path `(^|\/)\.dev\.vars` a secrets file.
- path `(^|\/)\.env($|\.)` a secrets file.
- path `^package\.json$` the npm scripts CI runs as the checks.
- path `(^|\/)tsconfig[^/]*\.json$` what the typechecks check.
- path `(^|\/)vitest\.config\.[cm]?[jt]s$` the integration suite's configuration.
- path `^scripts\/test-budget\.mjs$` the runner behind npm test.
- path `^scripts\/verify-live\.mjs$` the live gate, whose rollback is the backstop for an unattended merge.

## Required CI

Each entry is `<workflow path> / <job name> / <step name>`, under the namespace whose
repo it belongs to. A repo runs its suites as steps of one job, so a check-run name
cannot show that any of them ran; the step list can. A step written under no namespace
heading does not parse, and a namespace this Worker holds no steps for merges nothing,
because a green run nobody has written a step list for proves nothing.

## Required CI, capsid

- step `.github/workflows/ci.yml / checks / Typecheck`
- step `.github/workflows/ci.yml / checks / Typecheck tests`
- step `.github/workflows/ci.yml / checks / Typecheck integration tests`
- step `.github/workflows/ci.yml / checks / Typecheck the copied scorer script`
- step `.github/workflows/ci.yml / checks / Tests`
- step `.github/workflows/ci.yml / checks / Integration tests`

## Required CI, dustinedwards

Every step of that repo's one job, ruled 2026-09-19. Install and the build step are
named alongside the three that judge, so a reordered workflow that drops one refuses
rather than merging on a run that skipped it. These five names were read off
dustinedwards-info's `ci.yml` on 2026-09-19; no test in this repo can catch a rename
there, because this repo does not hold that workflow.

- step `.github/workflows/ci.yml / Gates, clean checkout / Install`
- step `.github/workflows/ci.yml / Gates, clean checkout / Migrations, stack and content build, publication twins, enhancement bundles, local sync`
- step `.github/workflows/ci.yml / Gates, clean checkout / Lint`
- step `.github/workflows/ci.yml / Gates, clean checkout / Slop`
- step `.github/workflows/ci.yml / Gates, clean checkout / Gates`

## What a merge means

A merge under this policy is also a deploy wherever the repo deploys on merge to its
default branch. capsid does. Ruled 2026-09-16 by Dustin after the first real merge (PR
#52) shipped to production with no human: the checks above are the whole condition, and
the live gate's rollback is the backstop. Extending this policy to another namespace
authorises unattended production deploys there too, and is decided one namespace at a
time.

**dustinedwards-info does not.** Its `deploy.yml` is `workflow_dispatch` only, and that
is a ruling of 2026-08-25 rather than an omission: push-to-deploy was considered in the
same ruling and refused, because it would make every merge a release. So an auto-merge
there lands on `main` and ships nothing, and releasing stays `npm run ship` or the
dispatch button. Measured from that workflow on 2026-09-19. If it ever gains an
`on: push` deploy, this paragraph is wrong and the namespace needs deciding again.

Anything else waits for the seat. A pull request that fails any check is left open,
audited with the check that refused it, and reported under `improve_status` as
awaiting the seat.

## What this policy cannot do

It cannot widen the set of repos the Worker reaches: a namespace it names that is not
on the improve roster is refused when the policy is parsed. It cannot describe less or
more than the code enforces: a check, refused path or required step on which the two
disagree is refused at load time. That is also what closes the window on every version
bump: a version 2 document lists five fewer refused paths than this code enforces, so
it loads nothing here, and between this code deploying and version 3 being signed
nothing is auto-merged. The same was true of version 1 against the version 2 code, and
of version 4 against the version 5 code, whose document does not name the three checks
version 5 added.
