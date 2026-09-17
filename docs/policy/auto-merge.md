# Auto-merge policy

What this Worker may merge with no human in the loop. This file is the reviewable
source. The copy the Worker actually reads is the signed document at
`capsid/policy/auto-merge.md` in the store, written from this file and signed with the
same key and envelope as an improve loop task document. An unsigned copy, or one
edited after signing, merges nothing.

- version: 2
- enabled: true
- namespaces: capsid

`enabled` ships as `false`. Turning it on is a ruling, and the document is on the
ordinary write tool's refusal list, so changing it needs `allow_improve_paths: true`
and the `can_touch_protected` flag, and lands in the audit log.

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
- `body_names_job` The PR body carries the id of the job the work came from, so a
  merged change traces back to a request somebody made.
- `author_is_driver` That job was claimed by a minted agent whose kind is `driver` and
  which has not been revoked. A PR from a seat, a cron agent, an operator key or a
  person is left for the seat.
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
- path `^scripts\/path-guard\.mjs$` the driver's enforcement of the protected path list.
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

Each entry is `<workflow path> / <job name> / <step name>`. The CI workflow runs the
four typechecks and both suites as steps of one job, so a check-run name cannot show
that any of them ran; the step list can.

- step `.github/workflows/ci.yml / checks / Typecheck`
- step `.github/workflows/ci.yml / checks / Typecheck tests`
- step `.github/workflows/ci.yml / checks / Typecheck integration tests`
- step `.github/workflows/ci.yml / checks / Typecheck the copied scorer script`
- step `.github/workflows/ci.yml / checks / Tests`
- step `.github/workflows/ci.yml / checks / Integration tests`

## What a merge means

A merge under this policy is also a deploy wherever the repo deploys on merge to its
default branch. capsid does. Ruled 2026-09-16 by Dustin after the first real merge (PR
#52) shipped to production with no human: the checks above are the whole condition, and
the live gate's rollback is the backstop. Extending this policy to another namespace
authorises unattended production deploys there too, and is decided one namespace at a
time.

Anything else waits for the seat. A pull request that fails any check is left open,
audited with the check that refused it, and reported under `improve_status` as
awaiting the seat.

## What this policy cannot do

It cannot widen the set of repos the Worker reaches: a namespace it names that is not
on the improve roster is refused when the policy is parsed. It cannot describe less or
more than the code enforces: a check, refused path or required step on which the two
disagree is refused at load time. A version 1 document, which has no refused paths,
loads nothing under this code, so between this code deploying and version 2 being
signed nothing is auto-merged.
