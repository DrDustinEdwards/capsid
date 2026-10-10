# Mutation baseline

Job job_bbf8db13c57b, step 1 of the mutation plan Dustin ruled on 2026-10-03. This is the measurement only. Nothing has been removed, changed or merged on the strength of it.

## Result

| | |
|---|---|
| Mutation score (killed or timed out, of all valid mutants) | **56.5%** |
| Score on covered code only (leaves out mutants no test reaches) | 72.6% |
| Mutants generated | 30,790 in 146 source files |
| Killed | 16,454 |
| Timed out (counted as detected) | 901 |
| Survived | 6,543 |
| No test covers the mutant | 6,828 |
| Runtime error (left out of the score) | 64 |

Run: mutation-baseline run 38015797140, dispatched from the #313 branch (merged as acce138). StrykerJS 10.0.0 with the tap runner on the node:test unit suite, per-test coverage analysis, no bail, 16 shards, Node 24.21.0. All 16 shards wrote `reports/mutation.json` (artifacts verified against GitHub's SHA-256 digests). Wall time was about three hours; the longest shard was 10. The score formula is the one Stryker uses: detected = killed + timeout, valid = detected + survived + no coverage.

## What this does and does not measure

- **The unit between tests is the test file.** Stryker's tap runner runs each `test/*.test.ts` file as one unit and records which files killed a mutant. It does not separate the cases inside a file, so the kill matrix below is per file. A file that is a candidate may still hold cases that matter; a file that is needed may hold cases that do not.
- **Timeouts have no killer.** 901 mutants ended as timeouts. Stryker records them as detected but names no test, so they are in the score and not in the matrix.
- **Ten test files are outside the run.** They read source text, which Stryker's instrumentation rewrites. They still run in CI on every PR. They are listed below as always kept. Any mutant that only they would kill shows here as survived or uncovered, so the score is a floor for the suite and the matrix understates those files' share.
- **Four source files have no mutants.** `src/access-jwt.ts` is left out because Stryker 10's Babel parser rejects it (line 68, a typed async arrow as a computed object key). `src/env.ts`, `src/github.ts` and `src/ops-types.ts` hold only type declarations and re-exports, so there is nothing to mutate. The score says nothing about `access-jwt.ts`, which is security code.
- **Integration and browser suites are not measured.** The integration suite runs in workerd, which Stryker's runners cannot drive. Those tests are kept under the ruling.
- **No type checker ran.** Mutants that do not type-check were not filtered out ahead of time, so some survivors may be mutants no valid program could contain.

## Score by source file

| Source file | Mutants | Killed | Timeout | Survived | No coverage | Error | Score |
|---|---:|---:|---:|---:|---:|---:|---:|
| src/access-login.ts | 138 | 90 | 0 | 41 | 7 | 0 | 65.2% |
| src/admin-client-audit.ts | 88 | 0 | 0 | 0 | 88 | 0 | 0.0% |
| src/agent-record.ts | 146 | 131 | 0 | 12 | 3 | 0 | 89.7% |
| src/agents-admin.ts | 193 | 134 | 0 | 44 | 15 | 0 | 69.4% |
| src/agents-schema.ts | 147 | 125 | 0 | 21 | 1 | 0 | 85.0% |
| src/agents.ts | 137 | 115 | 0 | 17 | 5 | 0 | 83.9% |
| src/approval.ts | 8 | 5 | 0 | 3 | 0 | 0 | 62.5% |
| src/audit-detail.ts | 212 | 153 | 0 | 39 | 20 | 0 | 72.2% |
| src/auth.ts | 109 | 94 | 1 | 14 | 0 | 0 | 87.2% |
| src/auto-merge-policy.ts | 719 | 459 | 139 | 76 | 8 | 37 | 87.7% |
| src/auto-merge-tick.ts | 243 | 151 | 0 | 48 | 44 | 0 | 62.1% |
| src/backup.ts | 199 | 135 | 14 | 46 | 4 | 0 | 74.9% |
| src/cache-hints.ts | 21 | 17 | 1 | 1 | 2 | 0 | 85.7% |
| src/canon.ts | 314 | 125 | 15 | 47 | 127 | 0 | 44.6% |
| src/controls.ts | 1569 | 829 | 0 | 337 | 403 | 0 | 52.8% |
| src/conventions-read.ts | 19 | 0 | 0 | 19 | 0 | 0 | 0.0% |
| src/counts.ts | 235 | 128 | 0 | 103 | 3 | 1 | 54.7% |
| src/dashboard-csp.ts | 1 | 0 | 0 | 1 | 0 | 0 | 0.0% |
| src/doc-meta.ts | 34 | 17 | 0 | 17 | 0 | 0 | 50.0% |
| src/encoding.ts | 17 | 16 | 0 | 1 | 0 | 0 | 94.1% |
| src/gate-policy.ts | 462 | 334 | 4 | 91 | 17 | 16 | 75.8% |
| src/github/actions.ts | 570 | 388 | 10 | 135 | 37 | 0 | 69.8% |
| src/github/client.ts | 408 | 279 | 19 | 88 | 22 | 0 | 73.0% |
| src/github/contents.ts | 615 | 346 | 46 | 182 | 41 | 0 | 63.7% |
| src/github/pr-files.ts | 41 | 34 | 1 | 2 | 4 | 0 | 85.4% |
| src/github/prune.ts | 212 | 156 | 0 | 38 | 18 | 0 | 73.6% |
| src/github/refs.ts | 392 | 279 | 0 | 84 | 29 | 0 | 71.2% |
| src/headers.ts | 64 | 44 | 17 | 1 | 0 | 2 | 98.4% |
| src/health-format.ts | 32 | 28 | 0 | 4 | 0 | 0 | 87.5% |
| src/health.ts | 106 | 76 | 1 | 27 | 2 | 0 | 72.6% |
| src/html.ts | 6 | 0 | 0 | 0 | 6 | 0 | 0.0% |
| src/improve-anthropic.ts | 113 | 47 | 9 | 45 | 12 | 0 | 49.6% |
| src/improve-attempt.ts | 96 | 36 | 0 | 50 | 10 | 0 | 37.5% |
| src/improve-gates.ts | 133 | 70 | 0 | 45 | 18 | 0 | 52.6% |
| src/improve-meta.ts | 174 | 52 | 0 | 61 | 61 | 0 | 29.9% |
| src/improve-run.ts | 364 | 217 | 0 | 89 | 58 | 0 | 59.6% |
| src/improve-schema.ts | 288 | 55 | 217 | 9 | 7 | 0 | 94.4% |
| src/improve-scorer.ts | 463 | 326 | 9 | 90 | 38 | 0 | 72.4% |
| src/improve-scores.ts | 447 | 300 | 17 | 111 | 12 | 7 | 72.0% |
| src/improve-select.ts | 94 | 74 | 1 | 18 | 1 | 0 | 79.8% |
| src/improve-skills.ts | 97 | 9 | 0 | 53 | 35 | 0 | 9.3% |
| src/improve-state.ts | 128 | 97 | 0 | 31 | 0 | 0 | 75.8% |
| src/improve-task.ts | 149 | 114 | 12 | 15 | 8 | 0 | 84.6% |
| src/improve/finalize.ts | 283 | 65 | 0 | 166 | 52 | 0 | 23.0% |
| src/improve/ingest.ts | 362 | 212 | 0 | 87 | 63 | 0 | 58.6% |
| src/improve/open.ts | 238 | 149 | 0 | 86 | 3 | 0 | 62.6% |
| src/improve/tick.ts | 504 | 205 | 0 | 173 | 126 | 0 | 40.7% |
| src/inbox.ts | 115 | 37 | 0 | 17 | 61 | 0 | 32.2% |
| src/index.ts | 207 | 0 | 0 | 0 | 207 | 0 | 0.0% |
| src/job-breaker.ts | 104 | 15 | 0 | 53 | 36 | 0 | 14.4% |
| src/job-claims-read.ts | 309 | 263 | 0 | 40 | 6 | 0 | 85.1% |
| src/job-claims.ts | 262 | 201 | 3 | 51 | 7 | 0 | 77.9% |
| src/job-outcomes.ts | 410 | 304 | 17 | 65 | 24 | 0 | 78.3% |
| src/job-overlaps.ts | 114 | 45 | 0 | 14 | 55 | 0 | 39.5% |
| src/job-signing.ts | 21 | 0 | 0 | 0 | 21 | 0 | 0.0% |
| src/job-skill-offers.ts | 102 | 6 | 1 | 27 | 68 | 0 | 6.9% |
| src/job-touches.ts | 46 | 42 | 0 | 3 | 1 | 0 | 91.3% |
| src/jobs-claim.ts | 332 | 116 | 0 | 121 | 95 | 0 | 34.9% |
| src/jobs-edit.ts | 141 | 0 | 1 | 5 | 135 | 0 | 0.7% |
| src/jobs-holder.ts | 581 | 56 | 0 | 151 | 374 | 0 | 9.6% |
| src/jobs-mirror.ts | 176 | 9 | 0 | 54 | 113 | 0 | 5.1% |
| src/jobs-park.ts | 126 | 0 | 0 | 0 | 126 | 0 | 0.0% |
| src/jobs-schema.ts | 196 | 156 | 14 | 23 | 3 | 0 | 86.7% |
| src/jobs-seat.ts | 723 | 45 | 0 | 82 | 596 | 0 | 6.2% |
| src/jobs-transition.ts | 147 | 49 | 0 | 60 | 38 | 0 | 33.3% |
| src/jobs.ts | 70 | 11 | 0 | 36 | 23 | 0 | 15.7% |
| src/limits.ts | 135 | 116 | 1 | 14 | 3 | 1 | 87.3% |
| src/links.ts | 62 | 56 | 0 | 6 | 0 | 0 | 90.3% |
| src/live-checks.ts | 739 | 552 | 1 | 166 | 20 | 0 | 74.8% |
| src/log.ts | 7 | 7 | 0 | 0 | 0 | 0 | 100.0% |
| src/maintenance-branches.ts | 145 | 97 | 2 | 29 | 17 | 0 | 68.3% |
| src/maintenance-deploys.ts | 133 | 72 | 1 | 23 | 37 | 0 | 54.9% |
| src/maintenance-disk.ts | 132 | 88 | 0 | 37 | 7 | 0 | 66.7% |
| src/maintenance-prs.ts | 156 | 64 | 0 | 19 | 73 | 0 | 41.0% |
| src/maintenance.ts | 160 | 43 | 2 | 32 | 83 | 0 | 28.1% |
| src/mcp-host.ts | 47 | 44 | 0 | 3 | 0 | 0 | 93.6% |
| src/merge-resume.ts | 102 | 1 | 0 | 1 | 100 | 0 | 1.0% |
| src/model-learning.ts | 31 | 13 | 0 | 14 | 4 | 0 | 41.9% |
| src/model-routing-pr.ts | 28 | 1 | 0 | 4 | 23 | 0 | 3.6% |
| src/model-routing.ts | 462 | 286 | 64 | 106 | 6 | 0 | 75.8% |
| src/namespace-delete.ts | 460 | 175 | 0 | 49 | 236 | 0 | 38.0% |
| src/normalize.ts | 41 | 30 | 0 | 7 | 4 | 0 | 73.2% |
| src/ops-cloudflare-config.ts | 167 | 131 | 0 | 33 | 3 | 0 | 78.4% |
| src/ops-cloudflare.ts | 418 | 296 | 2 | 102 | 18 | 0 | 71.3% |
| src/ops-feed.ts | 384 | 216 | 0 | 64 | 104 | 0 | 56.3% |
| src/ops-hooks.ts | 176 | 139 | 0 | 32 | 5 | 0 | 79.0% |
| src/ops-otlp.ts | 591 | 347 | 0 | 133 | 111 | 0 | 58.7% |
| src/ops-packages.ts | 531 | 241 | 11 | 69 | 210 | 0 | 47.5% |
| src/ops-session-auth.ts | 61 | 29 | 0 | 18 | 14 | 0 | 47.5% |
| src/ops-sites.ts | 330 | 213 | 0 | 43 | 74 | 0 | 64.5% |
| src/ops-snapshot.ts | 249 | 199 | 1 | 47 | 2 | 0 | 80.3% |
| src/outcome-prs.ts | 263 | 123 | 1 | 70 | 69 | 0 | 47.1% |
| src/overnight-plan.ts | 459 | 362 | 0 | 85 | 12 | 0 | 78.9% |
| src/overnight.ts | 118 | 77 | 0 | 41 | 0 | 0 | 65.3% |
| src/policy-sign.ts | 61 | 54 | 0 | 5 | 2 | 0 | 88.5% |
| src/portal-actions.ts | 154 | 107 | 0 | 24 | 23 | 0 | 69.5% |
| src/portal-activity.ts | 62 | 51 | 0 | 8 | 3 | 0 | 82.3% |
| src/portal-app.ts | 88 | 70 | 0 | 11 | 7 | 0 | 79.5% |
| src/portal-auth.ts | 146 | 117 | 0 | 25 | 4 | 0 | 80.1% |
| src/portal-claims.ts | 41 | 3 | 0 | 2 | 36 | 0 | 7.3% |
| src/portal-host.ts | 53 | 50 | 0 | 3 | 0 | 0 | 94.3% |
| src/portal-maintenance.ts | 17 | 3 | 0 | 3 | 11 | 0 | 17.6% |
| src/portal-packages.ts | 32 | 0 | 0 | 0 | 32 | 0 | 0.0% |
| src/portal-stale.ts | 11 | 3 | 0 | 2 | 6 | 0 | 27.3% |
| src/portfolio-docs.ts | 66 | 43 | 15 | 8 | 0 | 0 | 87.9% |
| src/prompts.ts | 98 | 55 | 2 | 28 | 13 | 0 | 58.2% |
| src/provenance.ts | 78 | 60 | 0 | 17 | 1 | 0 | 76.9% |
| src/rate-limit.ts | 96 | 86 | 0 | 10 | 0 | 0 | 89.6% |
| src/redact.ts | 109 | 22 | 74 | 13 | 0 | 0 | 88.1% |
| src/resources.ts | 96 | 64 | 1 | 23 | 8 | 0 | 67.7% |
| src/review.ts | 223 | 77 | 1 | 16 | 129 | 0 | 35.0% |
| src/routes.ts | 725 | 0 | 0 | 0 | 725 | 0 | 0.0% |
| src/runner-key.ts | 262 | 16 | 0 | 8 | 238 | 0 | 6.1% |
| src/scope.ts | 440 | 254 | 123 | 46 | 17 | 0 | 85.7% |
| src/scorer-identity.ts | 41 | 30 | 0 | 11 | 0 | 0 | 73.2% |
| src/seat-start.ts | 229 | 27 | 2 | 51 | 149 | 0 | 12.7% |
| src/server.ts | 53 | 45 | 1 | 7 | 0 | 0 | 86.8% |
| src/skills-evaluate.ts | 241 | 108 | 0 | 53 | 80 | 0 | 44.8% |
| src/skills-lifecycle.ts | 293 | 226 | 18 | 49 | 0 | 0 | 83.3% |
| src/skills-records.ts | 112 | 92 | 0 | 15 | 5 | 0 | 82.1% |
| src/skills-refresh.ts | 192 | 0 | 0 | 0 | 192 | 0 | 0.0% |
| src/skills-register.ts | 82 | 68 | 0 | 14 | 0 | 0 | 82.9% |
| src/stale-jobs.ts | 217 | 153 | 0 | 30 | 34 | 0 | 70.5% |
| src/store-guards.ts | 80 | 68 | 1 | 8 | 3 | 0 | 86.3% |
| src/store-probe.ts | 15 | 7 | 3 | 2 | 3 | 0 | 66.7% |
| src/task-runs.ts | 125 | 82 | 0 | 34 | 9 | 0 | 65.6% |
| src/tool-annotations.ts | 140 | 14 | 0 | 118 | 8 | 0 | 10.0% |
| src/tools/agents.ts | 54 | 31 | 0 | 18 | 5 | 0 | 57.4% |
| src/tools/claims.ts | 57 | 5 | 0 | 14 | 38 | 0 | 8.8% |
| src/tools/cloudflare.ts | 36 | 25 | 0 | 11 | 0 | 0 | 69.4% |
| src/tools/controls.ts | 57 | 41 | 0 | 13 | 3 | 0 | 71.9% |
| src/tools/docs-read.ts | 249 | 182 | 0 | 56 | 11 | 0 | 73.1% |
| src/tools/docs-write.ts | 455 | 264 | 0 | 128 | 63 | 0 | 58.0% |
| src/tools/docs.ts | 89 | 72 | 0 | 15 | 2 | 0 | 80.9% |
| src/tools/improve.ts | 134 | 52 | 0 | 58 | 24 | 0 | 38.8% |
| src/tools/jobs.ts | 288 | 75 | 0 | 149 | 64 | 0 | 26.0% |
| src/tools/lint.ts | 223 | 161 | 0 | 51 | 11 | 0 | 72.2% |
| src/tools/namespaces.ts | 123 | 56 | 0 | 29 | 38 | 0 | 45.5% |
| src/tools/ops.ts | 82 | 69 | 0 | 10 | 3 | 0 | 84.1% |
| src/tools/repo-guards.ts | 33 | 22 | 0 | 10 | 1 | 0 | 66.7% |
| src/tools/repo.ts | 294 | 114 | 0 | 122 | 58 | 0 | 38.8% |
| src/truth-report.ts | 323 | 215 | 0 | 98 | 10 | 0 | 66.6% |
| src/unmapped-repos.ts | 96 | 74 | 0 | 18 | 4 | 0 | 77.1% |
| src/watcher-findings.ts | 151 | 84 | 5 | 32 | 30 | 0 | 58.9% |
| src/watcher.ts | 1066 | 641 | 0 | 340 | 85 | 0 | 60.1% |
| src/write-modes.ts | 143 | 127 | 0 | 10 | 6 | 0 | 88.8% |

## Per-test kill matrix

The full matrix, one row per test file and source file with at least one kill, is in `docs/research/mutation-kill-matrix.csv` (1283 rows). The table below is its row summary. **Killed** counts distinct mutants the file killed. **Only** counts mutants for which it is the only killing file. **Covers** counts mutants whose code the file runs. **Keep rule** is the job's rule that protects it, if any (see the next section).

| Test file | Killed | Only | Covers | Source files hit | Keep rule |
|---|---:|---:|---:|---:|---|
| test/access-jwt.test.ts | 30 | 13 | 39 | 1 | security/permission/scope |
| test/access-redirect.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/admin-exposure-check.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/adversarial.test.ts | 325 | 2 | 3363 | 21 | security/permission/scope |
| test/agent-record.test.ts | 131 | 125 | 145 | 2 | fixed-bug signal |
| test/agents-auth.test.ts | 143 | 21 | 636 | 4 | security/permission/scope |
| test/agents-schema.test.ts | 95 | 27 | 110 | 2 |  |
| test/agents-status.test.ts | 100 | 8 | 2278 | 13 |  |
| test/agents-tool.test.ts | 289 | 140 | 3150 | 15 |  |
| test/audit-2026-09-06-round2.test.ts | 448 | 37 | 4921 | 37 | fixed-bug signal |
| test/audit-2026-09-16.test.ts | 328 | 18 | 3392 | 21 | fixed-bug signal |
| test/audit-detail.test.ts | 153 | 153 | 192 | 1 | fixed-bug signal |
| test/auth.test.ts | 55 | 13 | 63 | 2 | security/permission/scope |
| test/auto-merge.test.ts | 815 | 517 | 1677 | 12 |  |
| test/backup-credential.test.ts | 115 | 22 | 568 | 3 | security/permission/scope |
| test/backup.test.ts | 154 | 139 | 623 | 5 | fixed-bug signal |
| test/bound-key.test.ts | 207 | 71 | 3635 | 14 | security/permission/scope |
| test/bounded-reads.test.ts | 246 | 47 | 3079 | 14 |  |
| test/brief.test.ts | 154 | 51 | 2973 | 13 |  |
| test/cache-hints.test.ts | 178 | 14 | 2888 | 22 |  |
| test/canary.test.ts | 0 | 0 | 0 | 0 |  |
| test/canon.test.ts | 117 | 104 | 598 | 3 | security/permission/scope |
| test/capsid-rpc.test.ts | 0 | 0 | 0 | 0 |  |
| test/ci-status-jobs.test.ts | 344 | 122 | 3228 | 14 |  |
| test/cimd-probe.test.ts | 0 | 0 | 0 | 0 |  |
| test/cloudflare-platform.test.ts | 0 | 0 | 0 | 0 | fixed-bug signal |
| test/code-cleanup.test.ts | 0 | 0 | 0 | 0 |  |
| test/commit-trailers.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/controls.test.ts | 369 | 35 | 3250 | 18 |  |
| test/counts.test.ts | 131 | 118 | 614 | 2 | fixed-bug signal |
| test/csp-rate-limit.test.ts | 87 | 82 | 515 | 2 | security/permission/scope |
| test/dead-exports.test.ts | 0 | 0 | 0 | 0 |  |
| test/doc-meta.test.ts | 135 | 14 | 3134 | 16 | fixed-bug signal |
| test/dry-run-config.test.ts | 0 | 0 | 0 | 0 |  |
| test/dump-invariants.test.ts | 0 | 0 | 0 | 0 |  |
| test/encoding.test.ts | 16 | 1 | 17 | 1 |  |
| test/env-types.test.ts | 0 | 0 | 0 | 0 |  |
| test/export-claims.test.ts | 0 | 0 | 0 | 0 |  |
| test/fake-fidelity.test.ts | 4 | 2 | 426 | 1 |  |
| test/freshness.test.ts | 0 | 0 | 4 | 0 |  |
| test/gate-policy-version-served.test.ts | 269 | 9 | 2421 | 15 | security/permission/scope |
| test/gate-policy.test.ts | 450 | 221 | 1715 | 5 | security/permission/scope |
| test/glob-canary.test.ts | 0 | 0 | 0 | 0 | fixed-bug signal |
| test/headers.test.ts | 33 | 22 | 53 | 1 | security/permission/scope |
| test/health-format.test.ts | 35 | 14 | 519 | 2 |  |
| test/health.test.ts | 74 | 56 | 526 | 2 |  |
| test/holdout-imports.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/improve-budget.test.ts | 288 | 38 | 2777 | 24 |  |
| test/improve-caching.test.ts | 49 | 26 | 712 | 3 |  |
| test/improve-caps.test.ts | 32 | 24 | 1780 | 2 | fixed-bug signal |
| test/improve-condition.test.ts | 388 | 31 | 4880 | 35 | fixed-bug signal |
| test/improve-control.test.ts | 170 | 54 | 2337 | 11 |  |
| test/improve-derive-key.test.ts | 15 | 0 | 241 | 3 | security/permission/scope |
| test/improve-driver-lock.test.ts | 100 | 18 | 2238 | 12 |  |
| test/improve-environment-signal.test.ts | 0 | 0 | 0 | 0 |  |
| test/improve-gates.test.ts | 130 | 28 | 775 | 4 | security/permission/scope |
| test/improve-holdout.test.ts | 71 | 30 | 512 | 2 | security/permission/scope |
| test/improve-loop-records.test.ts | 644 | 113 | 4508 | 36 |  |
| test/improve-meta.test.ts | 38 | 35 | 507 | 2 |  |
| test/improve-protected-paths.test.ts | 387 | 40 | 3598 | 21 | security/permission/scope |
| test/improve-report.test.ts | 0 | 0 | 0 | 0 | fixed-bug signal |
| test/improve-run-mint.test.ts | 85 | 20 | 2800 | 14 | security/permission/scope |
| test/improve-run.test.ts | 837 | 172 | 4512 | 33 |  |
| test/improve-scorer.test.ts | 235 | 137 | 719 | 3 |  |
| test/improve-scores.test.ts | 270 | 70 | 825 | 4 | fixed-bug signal |
| test/improve-select.test.ts | 74 | 53 | 93 | 1 |  |
| test/improve-state.test.ts | 63 | 23 | 512 | 2 |  |
| test/improve-task-integrity.test.ts | 102 | 3 | 426 | 5 | security/permission/scope |
| test/improve-tools.test.ts | 357 | 6 | 3507 | 26 |  |
| test/improve-unjudged.test.ts | 415 | 52 | 4004 | 20 |  |
| test/inbox.test.ts | 39 | 30 | 908 | 2 |  |
| test/ingest-hardening.test.ts | 257 | 70 | 2489 | 12 | security/permission/scope |
| test/integration-layer.test.ts | 0 | 0 | 0 | 0 |  |
| test/job-claims-read.test.ts | 412 | 263 | 3185 | 12 |  |
| test/job-claims.test.ts | 390 | 213 | 1924 | 7 |  |
| test/job-outcomes.test.ts | 502 | 304 | 1349 | 6 |  |
| test/job-overlaps.test.ts | 45 | 45 | 72 | 1 |  |
| test/job-touches-migration.test.ts | 0 | 0 | 7 | 0 |  |
| test/job-touches.test.ts | 42 | 17 | 463 | 1 |  |
| test/jobs-agents.test.ts | 129 | 39 | 555 | 4 | security/permission/scope |
| test/jobs-list.test.ts | 137 | 20 | 2947 | 13 |  |
| test/jobs.test.ts | 398 | 132 | 3818 | 31 |  |
| test/lease-keepalive.test.ts | 0 | 0 | 0 | 0 |  |
| test/limits.test.ts | 83 | 44 | 465 | 2 |  |
| test/links.test.ts | 85 | 56 | 107 | 2 |  |
| test/lint-description.test.ts | 41 | 1 | 2785 | 10 |  |
| test/lint-scope.test.ts | 221 | 31 | 3264 | 17 | security/permission/scope |
| test/live-checks.test.ts | 672 | 567 | 3084 | 8 |  |
| test/log-events.test.ts | 0 | 0 | 0 | 0 |  |
| test/log.test.ts | 7 | 2 | 7 | 1 |  |
| test/maintenance.test.ts | 537 | 365 | 1478 | 9 |  |
| test/manage-pr-sha.test.ts | 169 | 14 | 3095 | 14 |  |
| test/mcp-host.test.ts | 44 | 44 | 47 | 1 | security/permission/scope |
| test/mint-agents.test.ts | 0 | 0 | 217 | 0 | security/permission/scope |
| test/model-routing.test.ts | 528 | 315 | 2703 | 23 |  |
| test/namespace-delete.test.ts | 218 | 188 | 2400 | 5 |  |
| test/namespace-remap.test.ts | 148 | 12 | 2930 | 14 | fixed-bug signal |
| test/no-bloat-report.test.ts | 0 | 0 | 0 | 0 |  |
| test/normalize.test.ts | 30 | 17 | 37 | 1 |  |
| test/null-metrics.test.ts | 90 | 1 | 413 | 1 |  |
| test/oauth-flow.test.ts | 15 | 9 | 23 | 4 | security/permission/scope |
| test/ops-cloudflare-config.test.ts | 335 | 159 | 3115 | 14 |  |
| test/ops-cloudflare.test.ts | 516 | 280 | 2850 | 7 |  |
| test/ops-feed.test.ts | 413 | 217 | 2533 | 14 |  |
| test/ops-hooks.test.ts | 297 | 167 | 2325 | 9 |  |
| test/ops-otlp.test.ts | 416 | 347 | 980 | 6 |  |
| test/ops-packages.test.ts | 249 | 203 | 770 | 2 |  |
| test/ops-sites.test.ts | 235 | 138 | 2016 | 3 |  |
| test/ops-snapshot-tool.test.ts | 226 | 123 | 2981 | 13 |  |
| test/ops-snapshot.test.ts | 202 | 80 | 2063 | 5 |  |
| test/outcome-prs.test.ts | 283 | 98 | 3221 | 18 | fixed-bug signal |
| test/overnight-guard.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/overnight.test.ts | 463 | 409 | 1042 | 5 |  |
| test/path-guard.test.ts | 3 | 0 | 220 | 1 | security/permission/scope |
| test/path-mutation.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/policy-sign.test.ts | 299 | 45 | 1067 | 10 | security/permission/scope |
| test/portal-actions.test.ts | 1434 | 828 | 4277 | 28 | fixed-bug signal |
| test/portal-activity.test.ts | 51 | 51 | 496 | 1 |  |
| test/portal-app.test.ts | 183 | 71 | 732 | 7 |  |
| test/portal-attention.test.ts | 0 | 0 | 0 | 0 |  |
| test/portal-host.test.ts | 50 | 33 | 53 | 1 | security/permission/scope |
| test/portal-login.test.ts | 226 | 99 | 2156 | 6 | security/permission/scope |
| test/portal-messages.test.ts | 0 | 0 | 0 | 0 |  |
| test/portal-source.test.ts | 12 | 4 | 27 | 1 |  |
| test/portal-stops.test.ts | 0 | 0 | 0 | 0 |  |
| test/portal-store.test.ts | 12 | 12 | 1843 | 1 |  |
| test/portal-time.test.ts | 0 | 0 | 0 | 0 |  |
| test/portfolio-docs.test.ts | 294 | 102 | 3143 | 13 |  |
| test/prose.test.ts | 0 | 0 | 0 | 0 |  |
| test/protected-lockfiles.test.ts | 8 | 0 | 225 | 1 | security/permission/scope |
| test/provenance.test.ts | 85 | 49 | 116 | 2 |  |
| test/prune-branches.test.ts | 199 | 52 | 844 | 3 |  |
| test/public-docs.test.ts | 0 | 0 | 0 | 0 |  |
| test/redact.test.ts | 22 | 13 | 109 | 1 | security/permission/scope |
| test/register-namespace-mint.test.ts | 110 | 24 | 2865 | 14 | security/permission/scope |
| test/repo-fallthrough.test.ts | 493 | 224 | 1344 | 8 | security/permission/scope |
| test/repo-path-traversal.test.ts | 103 | 41 | 715 | 4 | security/permission/scope |
| test/repo-tools.test.ts | 661 | 221 | 3725 | 19 |  |
| test/retry-cap.test.ts | 16 | 16 | 386 | 1 |  |
| test/review.test.ts | 105 | 78 | 730 | 3 | fixed-bug signal |
| test/roles.test.ts | 199 | 6 | 3060 | 12 | security/permission/scope |
| test/rollback-guard.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/schedule-drivers.test.ts | 0 | 0 | 355 | 0 |  |
| test/scope-surfaces.test.ts | 450 | 31 | 3775 | 29 | security/permission/scope |
| test/scope.test.ts | 415 | 32 | 3893 | 31 | security/permission/scope |
| test/scorer-identity.test.ts | 100 | 57 | 1892 | 4 | security/permission/scope |
| test/scorer-isolation.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/search-code.test.ts | 164 | 124 | 833 | 3 |  |
| test/seat-session-canary.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/seat-session-workflow.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/secondary-recompute.test.ts | 0 | 0 | 0 | 0 |  |
| test/self-repo-attempt.test.ts | 141 | 7 | 874 | 6 |  |
| test/signed-policy-reader.test.ts | 98 | 1 | 552 | 3 | security/permission/scope |
| test/skills-credit.test.ts | 223 | 0 | 3662 | 21 |  |
| test/skills-evaluate.test.ts | 261 | 88 | 3538 | 11 |  |
| test/skills-lifecycle.test.ts | 224 | 72 | 293 | 1 |  |
| test/skills-probe.test.ts | 141 | 2 | 3485 | 17 |  |
| test/skills-records.test.ts | 136 | 41 | 633 | 3 |  |
| test/skills-register.test.ts | 225 | 82 | 3015 | 19 |  |
| test/snapshotted.test.ts | 223 | 12 | 3211 | 18 | security/permission/scope |
| test/sql-statements.test.ts | 0 | 0 | 0 | 0 | fixed-bug signal |
| test/stale-jobs.test.ts | 154 | 154 | 1055 | 2 |  |
| test/store-write-edges.test.ts | 294 | 11 | 3327 | 21 |  |
| test/sync-scorer-apply.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/sync-scorer-runs-ref.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/sync-scorer-stale.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/sync-scorer.test.ts | 0 | 0 | 0 | 0 | security/permission/scope |
| test/task-runs.test.ts | 87 | 77 | 539 | 2 |  |
| test/tool-grant-descriptions.test.ts | 179 | 27 | 2767 | 20 | security/permission/scope |
| test/tools-axis.test.ts | 452 | 18 | 3591 | 25 | security/permission/scope |
| test/truth-report.test.ts | 343 | 152 | 3395 | 15 | fixed-bug signal |
| test/unmapped-repos.test.ts | 217 | 144 | 2407 | 5 |  |
| test/verify-live-no-answer.test.ts | 0 | 0 | 0 | 0 |  |
| test/watcher-gather.test.ts | 210 | 46 | 2454 | 8 |  |
| test/watcher-mirror.test.ts | 103 | 72 | 1883 | 2 |  |
| test/watcher.test.ts | 487 | 271 | 2558 | 8 | fixed-bug signal |
| test/workflow-policy.test.ts | 0 | 0 | 217 | 0 | security/permission/scope |
| test/write-invariants.test.ts | 821 | 262 | 4063 | 27 | security/permission/scope |
| test/write-modes.test.ts | 127 | 42 | 137 | 1 | fixed-bug signal |

## Always kept (outside the run)

These ten files read source text, were left out of the mutation run, and are kept under the job's keep rules. None is a removal candidate.

- test/admin-client-audit.test.ts
- test/blast-radius.test.ts
- test/deploy-pipeline.test.ts
- test/improve-cron.test.ts
- test/invariants.test.ts
- test/mutation-guard-coverage.test.ts
- test/route-gates.test.ts
- test/skills-refresh.test.ts
- test/source-conventions.test.ts
- test/tool-annotations.test.ts

## Removal candidates

Rule from the plan: a file is a candidate when every mutant it kills is also killed by a file that stays, or when it kills no mutant. Redundancy is computed jointly, so removing all candidates together still leaves every killed mutant killed. Method: the files protected by a keep rule form the starting set; the rest are added greedily, most new kills first, until every killed mutant has a killer; files never added are the candidates.

Keep rules applied, as a first pass for the seat to correct:

- **Security, permission and scope:** matched by file name against this pattern, which the seat can amend: `^(access-|admin-exposure|adversarial|agents-auth|auth$|backup-credential|bound-key|canon$|commit-trailers|csp-|gate-policy|headers|holdout|improve-(derive-key|gates|holdout|protected-paths|run-mint|task-integrity)|ingest-hardening|jobs-agents|lint-scope|mcp-host|mint-agents|oauth|overnight-guard|path-|policy-sign|portal-(host|login)|protected-|redact|register-namespace-mint|repo-(fallthrough|path-traversal)|roles|rollback-guard|scope|scorer-|seat-session|signed-policy|site-operator|snapshotted|sync-scorer|tool-grant|tools-axis|workflow-policy|write-invariants)`. 56 files match.
- **Written for a fixed bug:** no field records this, so a file is kept when its name starts with `audit-`, when its text says regression or bug, or when a commit that touched it says fix, fixed, regression or bug in its subject. 21 further files match. This errs toward keeping.
- **Real-runtime integration tests and route-gates:111:** outside this run (route-gates is one of the ten above).

Files with a keep rule: 77 of 179. Added by the cover step because they are the only or best killers of otherwise uncovered mutants: 76. Candidates: 26.

### A. Kill no mutant and run no mutated code (22)

These guard scripts, workflows, docs or config rather than `src/`, so a src mutation run cannot judge them. The plan's rule lists them as candidates; the seat should read them as not measured by this run.

- test/canary.test.ts
- test/capsid-rpc.test.ts
- test/cimd-probe.test.ts
- test/code-cleanup.test.ts
- test/dead-exports.test.ts
- test/dry-run-config.test.ts
- test/dump-invariants.test.ts
- test/env-types.test.ts
- test/export-claims.test.ts
- test/improve-environment-signal.test.ts
- test/integration-layer.test.ts
- test/lease-keepalive.test.ts
- test/log-events.test.ts
- test/no-bloat-report.test.ts
- test/portal-attention.test.ts
- test/portal-messages.test.ts
- test/portal-stops.test.ts
- test/portal-time.test.ts
- test/prose.test.ts
- test/public-docs.test.ts
- test/secondary-recompute.test.ts
- test/verify-live-no-answer.test.ts

### B. Kill no mutant but run mutated code (3)

Their assertions did not catch any mutation in the code they run. These are the clearest weak-oracle candidates.

- test/freshness.test.ts (covers 4 mutants)
- test/job-touches-migration.test.ts (covers 7 mutants)
- test/schedule-drivers.test.ts (covers 355 mutants)

### C. Kill mutants, all of which a kept file also kills (1)

| Test file | Killed | Covers | Source files hit |
|---|---:|---:|---:|
| test/skills-credit.test.ts | 223 | 3662 | 21 |

### Kept by the cover step (76)

Not protected by a keep rule, but the only or best killer of mutants no other kept file kills, so not candidates: live-checks (+630), auto-merge (+555), maintenance (+466), model-routing (+413), overnight (+411), ops-cloudflare (+405), job-outcomes (+389), ops-otlp (+364), improve-run (+363), job-claims-read (+264), repo-tools (+263), skills-evaluate (+240), ops-feed (+236), job-claims (+225), ops-packages (+203), namespace-delete (+189), ops-hooks (+170), ops-cloudflare-config (+159), agents-tool (+157), stale-jobs (+154), unmapped-repos (+144), improve-scorer (+141), ops-sites (+138), improve-loop-records (+133), jobs (+133), ops-snapshot-tool (+126), search-code (+124), ci-status-jobs (+122), portfolio-docs (+115), skills-lifecycle (+100), skills-register (+98), ops-snapshot (+94), task-runs (+77), provenance (+74), watcher-mirror (+73), portal-app (+71), links (+67), health (+65), improve-control (+54), improve-select (+53), improve-unjudged (+52), prune-branches (+52), brief (+51), portal-activity (+51), watcher-gather (+48), bounded-reads (+47), job-overlaps (+45), limits (+44), skills-records (+43), improve-budget (+38), controls (+35), improve-meta (+35), agents-schema (+32), inbox (+30), improve-caching (+26), normalize (+24), improve-state (+23), jobs-list (+20), improve-driver-lock (+18), job-touches (+17), retry-cap (+16), cache-hints (+14), health-format (+14), manage-pr-sha (+14), portal-store (+12), store-write-edges (+11), agents-status (+8), self-repo-attempt (+7), improve-tools (+6), portal-source (+4), fake-fidelity (+2), log (+2), skills-probe (+2), encoding (+1), lint-description (+1), null-metrics (+1).

## Reading this for step 2

- Only 4 of the 26 candidates are measured candidates (groups B and C). The other 22 are group A, which this run cannot judge. At file level, most files are the only killer of at least one mutant, which is why so few are redundant.
- Candidates are a list for the seat. No file is removed by this report, and step 2 starts only on the seat's say.
- Because the unit is the file, a pruning plan that wants to drop single cases needs a runner that reports per case. The tap runner does not.
- Any pruning PR should show this score before and after, as the plan says. The score above is the baseline to beat, 56.5%.
- The ten excluded files and `access-jwt.ts` are a blind spot of this baseline, not evidence about them.
