# The overnight run

What a night of unattended driver work looks like: a plan and a morning digest, plus a switch that now gates nothing. Ruled by Dustin 2026-10-04 (D2 and D3 of `capsid/research/design-automation-for-speed.md`; the amendment is in `capsid/decisions.md`). Code: `src/overnight.ts`, `src/overnight-plan.ts`.

**The local Windows scheduler was removed** (job_2c92174d5bff, 2026-10-11): `scripts/schedule-drivers.mjs`, its guard `scripts/overnight-guard.mjs`, the per-job session key it claimed with, and the claim leases and heartbeats it relied on are gone. Routines now start sessions in the cloud (docs/routines.md). The switch below is still stored and shown, and the plan and digest are still served, but nothing reads the switch to start a run.

## Hand-started tabs are the default

Opening VS Code tabs yourself and asking Claude Code to chain jobs overnight is ordinary use you start. It continues unchanged. Nothing here gates it, and the plan below exists so those tabs can follow it.

## The plan

`capsid_work_jobs` action `list` with `view: "plan"` (read grant, no new tool). Per repo, the queued jobs in priority order that fit about eight hours.

- **Eligible:** queued, no required flags, no `min_record`, a title that does not begin `LATER`, and a namespace that maps to a repo. Everything else is in `skipped` with its reason. A parked job is not queued, so it is never planned and never listed as skipped.
- **Gated jobs are planned** (conventions 2.3: gates apply to risky steps, not whole jobs). A job with `gate_required` is planned like any other and marked `gated: true`. The session does its ordinary work (code, tests, docs, a pull request), lists each risky step (a migration, a deploy, a secret, an account setting, deleting data) in the pull request for the seat, blocks with the exact command, and moves on to the next job. test/overnight.test.ts guards it ("PLANT: a gated job is planned and marked gated").
- **One lane per repo.** Two namespaces that map to one repo share one lane, so there is never a second session on a repo.
- **Heavy suites run one session at a time across repos.** Repos that run heavy suites share one budget (`heavy_planned_minutes`), so their lanes add up to one night, not several. Light repos each get the whole night.
- **Estimates:** the policy document's `estimate`, else the 75th percentile of that namespace's unblocked job durations (at least 5 samples, floor 15 minutes), else 60 minutes. Each planned job says which.
- A job that does not fit is skipped and a smaller later one may still go in. A job that blocks stops only itself.
- A caller scoped to one namespace names it and gets that namespace's lane and skips. The plan is built over every namespace first, because the heavy budget is shared.

`capsid/policy/overnight.md` (optional, read each pass): `- heavy <namespace>`, `- budget-minutes <n>` (60 to 1440, default 480) and `- estimate <namespace> <minutes>`. With no document, or one that names no heavy repo, every repo counts as heavy: unknown fails toward one session at a time. A document that does not parse is ignored and the plan says why. A proposed first version for the seat:

```
- heavy capsid
- heavy foxing
- heavy germomics
- heavy foxhound
- budget-minutes 480
```

(Which repos run heavy suites locally is Dustin's to say; the list above is a guess from capsid/conventions-testing.md rule 3, which puts private repos' integration and browser suites on his machine.)

## The morning digest

`capsid_work_jobs` action `list` with `view: "digest"` and an optional `since` (ISO time; default the last 24 hours). Read-only.

- **finished:** each job recorded in the window, with its usage.
- **blocked:** each job blocked in the window, the reason and command as the driver wrote them (cut to 600 characters), and any pull request named in them.
- **pull_requests_ready:** pull requests recorded against finished jobs that are not merged (`open` is not merged, open or closed; `unchecked` was never read), plus pull requests named in a blocked job's summary.
- **usage per job** is the telemetry on the outcome row if there is one, else what the agent reported in `claim.usage` (PR 240), else null. The two are never added. `totals` keeps them apart and counts the jobs that reported nothing. Telemetry is empty until the exporter in `docs/telemetry.md` is turned on, so until then the numbers are what agents reported.
- Each read is bounded; one that hit its bound is named in `truncated`.

## The overnight switch

APP_KV `overnight:mode`: `off` (default), `api` or `subscription`, the improve loop's three values. Set in the Portal's Settings, Automation and namespaces section, Automation panel, **Overnight run**, with its own "Runs on" choice of API or Subscription, or by an admin with `capsid_admin_control_improve` action `overnight`. A reason is required in both directions and recorded in the audit rows (`overnight-set`, `portal-overnight`); an Undo is its own row.

**Choosing the subscription records Dustin's decision.** The switch stores, beside the mode, who decided (Dustin Edwards), the date (2026-10-04), the ruling, the reasoning and who set the switch, when, and why (`overnight:decision`). The Portal's confirm step shows it and the panel shows it after. Leaving the subscription deletes the record, so a later choice records its own date and reason. A subscription mode with no readable record reads as `off`.

The ruling's reasoning, in short: the use is personal, on Dustin's own repositories, and not shared. Anthropic's Agent SDK support page (updated 2026-06-16) says `claude -p` on a plan draws from subscription limits and sends shared production automation to API keys. The Consumer Terms clause on automated or non-human access (section 3) is the counterweight, the pages do not settle it, and the risk is to Dustin's own account. Sources and quotes: `capsid/research/terms-scheduled-claude-code.md`.

Since the scheduler was removed, no code reads this switch to start anything: it records a mode and, for the subscription, the decision, and that is all. Removing the switch, its Portal panel and the `overnight` action is a separate change.
