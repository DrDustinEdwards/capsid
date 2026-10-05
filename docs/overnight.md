# The overnight run

What a night of unattended driver work looks like, and the three parts that make it safe to turn on: a plan, a morning digest, and a scheduler behind a switch. Ruled by Dustin 2026-10-04 (D2 and D3 of `capsid/research/design-automation-for-speed.md`; the amendment is in `capsid/decisions.md`). Code: `src/overnight.ts`, `src/overnight-plan.ts`, `scripts/overnight-guard.mjs`, `scripts/schedule-drivers.mjs`.

## Hand-started tabs are the default

Opening VS Code tabs yourself and asking Claude Code to chain jobs overnight is ordinary use you start. It continues unchanged. Nothing here gates it, and the plan below exists so those tabs can follow it. The scheduler is a second way to run a night, off until you turn it on.

## The plan

`jobs` action `list` with `view: "plan"` (read grant, no new tool). Per repo, the gate-free queued jobs in priority order that fit about eight hours.

- **Eligible:** queued, `gate_required` 0, no required flags, no `min_record`, a title that does not begin `LATER`, and a namespace that maps to a repo. Everything else is in `skipped` with its reason.
- **One lane per repo.** Two namespaces that map to one repo share one lane, so there is never a second session on a repo.
- **Heavy suites run one session at a time across repos.** Repos that run heavy suites share one budget (`heavy_planned_minutes`), so their lanes add up to one night, not several. Light repos each get the whole night.
- **Estimates:** the policy document's `estimate`, else the 75th percentile of that namespace's unblocked job durations (at least 5 samples, floor 15 minutes), else 60 minutes. Each planned job says which.
- A job that does not fit is skipped and a smaller later one may still go in. A job that blocks stops only itself; its lane's next job is claimed by the session that was running it.
- A caller scoped to one namespace names it and gets that namespace's lane and skips. The plan is built over every namespace first, because the heavy budget is shared.

`capsid/policy/overnight.md` (optional, read each pass): `- heavy <namespace>`, `- budget-minutes <n>` (60 to 1440, default 480) and `- estimate <namespace> <minutes>`. With no document, or one that names no heavy repo, every repo counts as heavy: unknown fails toward one session at a time. A document that does not parse is ignored and the plan says why. A proposed first version for the seat:

```
- heavy capsid
- heavy foxing
- heavy germomics
- heavy foxhound
- budget-minutes 480
```

(Which repos run heavy suites locally is Dustin's to say; the list above is a guess from conventions 5.5, which puts private repos' integration and browser suites on his machine.)

## The morning digest

`jobs` action `list` with `view: "digest"` and an optional `since` (ISO time; default the last 24 hours). Read-only.

- **finished:** each job recorded in the window, with its usage.
- **blocked:** each job blocked in the window, the reason and command as the driver wrote them (cut to 600 characters), and any pull request named in them.
- **pull_requests_ready:** pull requests recorded against finished jobs that are not merged (`open` is not merged, open or closed; `unchecked` was never read), plus pull requests named in a blocked job's summary.
- **usage per job** is the telemetry on the outcome row if there is one, else what the agent reported in `claim.usage` (PR 240), else null. The two are never added. `totals` keeps them apart and counts the jobs that reported nothing. Telemetry is empty until the exporter in `docs/telemetry.md` is turned on, so until then the numbers are what agents reported.
- Each read is bounded; one that hit its bound is named in `truncated`.

## The scheduler switch

APP_KV `overnight:mode`: `off` (default), `api` or `subscription`, the improve loop's three values. Set in the Portal's Namespaces view, Automation panel, **Overnight run**, with its own "Runs on" choice of API or Subscription, or by an admin with `improve_run` action `overnight`. A reason is required in both directions and recorded in the audit rows (`overnight-set`, `portal-overnight`); an Undo is its own row.

**Choosing the subscription records Dustin's decision.** The switch stores, beside the mode, who decided (Dustin Edwards), the date (2026-10-04), the ruling, the reasoning and who set the switch, when, and why (`overnight:decision`). The Portal's confirm step shows it and the panel shows it after. Leaving the subscription deletes the record, so a later choice records its own date and reason. A subscription mode with no readable record reads as `off`.

The ruling's reasoning, in short: the use is personal, on Dustin's own repositories, and not shared. Anthropic's Agent SDK support page (updated 2026-06-16) says `claude -p` on a plan draws from subscription limits and sends shared production automation to API keys. The Consumer Terms clause on automated or non-human access (section 3) is the counterweight, the pages do not settle it, and the risk is to Dustin's own account. Sources and quotes: `capsid/research/terms-scheduled-claude-code.md`.

### What the scheduler does before it starts a session

`node scripts/schedule-drivers.mjs --run --namespace <ns>` (what the installed Task Scheduler task runs, still created disabled):

1. Reads the switch with the namespace's driver key. No key, an unreadable switch or an unknown mode: no run.
2. **off:** no run. **api:** runs only if `ANTHROPIC_API_KEY` is set and holds a Console key (not a subscription token, `sk-ant-oat...`), and neither `ANTHROPIC_AUTH_TOKEN` nor a cloud-provider variable is set, because those outrank the key. The subscription token is removed from the session's environment. **subscription:** runs only if the recorded decision is present. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the provider variables are removed from the session's environment, so a run set to the subscription cannot bill the API.
3. A refusal says why, is posted as that night's run log, and exits 3.
4. Reads the namespace's lane from the plan. Nothing planned is a skip, not a failure.
5. A heavy lane takes `~/.capsid/overnight-heavy.lock` first, waiting up to the plan's budget, so heavy sessions run one at a time. A lock older than nine hours is taken over.
6. Starts `claude -p` with a prompt that lists the planned job ids in order and says to move past a block. Job titles are not in the prompt: a title can carry text from outside, and the session acts on the prompt.

Credential order is from code.claude.com/docs/en/authentication ("Authentication precedence"): cloud-provider variables, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` (in `-p` mode always used when present), `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, a `/login` subscription. A setting that adds an `apiKeyHelper` outranks the subscription login and cannot be seen from the script; `/status` in the run is how to confirm which credential a night used.

## Turning it on, and what is not verified

It ships off and each installed task is disabled. Turning it on is Dustin's decision, after a supervised night, once telemetry shows what a night costs.

- Not verified: how the `/improve work` command treats the plan text after its first line. The prompt is the plain command plus the plan; that command lives outside this repository.
- Not verified: whether a scheduled run on the subscription is within Anthropic's terms. The ruling says it is allowed by Dustin's choice and that Dustin may still ask Anthropic support; nothing waits on the answer.
- Not verified: the lock and the environment change on Windows. They are tested here with the platform's own file calls and a process environment, not on Task Scheduler.
