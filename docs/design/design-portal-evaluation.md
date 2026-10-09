# Design: whole-Portal evaluation

Job job_1057e44ecffe, 2026-10-09. Design only: nothing built. Answers DECIDE 6 of `capsid/research/design-experience-review.md` (evaluate the whole Portal before merging pages). It starts from that review's sections 1 to 3 and its rulings so far:

- **Inbox:** only exceptions reach Dustin, each with a reason, evidence and an editable recommended answer. Batches are for one class. Alerts are for urgent items only.
- **Supersede button:** yes.
- **Branches:** they delete automatically after merge, and the backup button has Undo. The tick already deletes them through `deleteHeadBranchAfterPr`, `src/github/refs.ts:97-140`.

It coordinates with job_cefba61b515c (`docs/design/design-merge-pipeline.md`), which owns the approval record, PR classes and push channel; this document owns the screens.

Read at master e2762d8 (fetched 2026-10-09). The review read a worktree. This reads master, so counts differ where code moved: 37 tools now, 36 then.

## 0. What changes, in one paragraph

The Portal today has 13 views in three groups: Watch, Work and Records. It answers "is anything broken" well. It answers "what do I have to decide" badly.

The biggest gaps on a screen are PR approval, supersede, the job digest, parked jobs and questions. All of them are things Dustin decides. The proposal:

- Make **Needs you** the home page, an inbox fed by the existing `/ops/inbox` gatherer (`src/inbox.ts:76`, unused by the Portal today).
- Fold eight views into four task pages: Work, Health, Records and Settings.
- Add seven visuals, each answering one question faster than a table. One of them is minutes of Dustin per week.

## 1. Coverage

**Key:**
- **S**: has a screen.
- **R**: chat-only by a ruling.
- **A**: agent or driver step, needs no screen.
- **M**: missing.

For M rows the last column says whether Dustin needs a screen. Sources are `src/scope.ts:44-112` (TOOL_GRANTS, 37 tools), `src/controls.ts:34-51` (16 Portal actions) and `src/routes.ts:600-631`.

### Capsid tools and actions

| Tool: action | Mark | Where, or why |
|---|---|---|
| jobs: list | S | Queue (`views/Queue.tsx`), drawer |
| jobs: resume, release, fail | S | `app/Drawer.tsx:160,165,169` |
| jobs: claim, heartbeat, complete, block, start | A | drivers (`docs/work-queue.md:3`) |
| jobs: supersede | M | **Yes.** 250 calls in 14 days, ruled yes. Drawer button with a confirm, and batch for duplicates |
| jobs: question mark (`OpsJob.question`, `ops-types.ts:218`) | M | **Yes.** Typed but not rendered. Questions are the inbox's main item |
| jobs: park, unpark | M | **Yes.** `OpsJobStatus` has no `parked` (`ops-types.ts:191`), so parked jobs vanish. Show them under Queue with Unpark. Park is reversible, so Undo |
| jobs: edit | M | Rarely. Priority and title edits stay chat-only; record a ruling |
| jobs: post | M | No. Posting is a chat act with a signed body; record chat-only |
| jobs: list view digest | M | **Yes**, as the inbox's "since you last looked" strip, not a page |
| jobs: list view plan | M | Yes, as a Queue section "Tonight" (timeline) |
| jobs: list view models | M | Yes, inside Records > Agents, as the routing learning table (proposals only) |
| jobs: list stale | M | Yes, it is the Queue's Stale group. Today that group is computed client-side as over 7 days, while the Worker's rule is 3 days. Use the Worker's rules |
| manage_pr: merge | R | `docs/portal.md:200`. Replaced by `approve_pr` (merge pipeline design) |
| manage_pr: close, comment | M | Close: **yes**, in the PR card, with a confirm (reopen is possible, so Undo is an option). Comment: no |
| delete_branch, create_branch | A | automatic after merge; the backup button per the ruling |
| improve_run: mode, pause, unpause, seat_start, overnight, breaker_reset | S | `views/Namespaces.tsx:82-356` |
| improve_run: budget | M | Yes, read-only today (`views/Agents.tsx:80`). Editing caps is rare: keep it chat-only, and show the budget as a visual |
| improve_run: mint_operator_key, sign_policy | R | never mints (`docs/portal.md:200`). Signing stays chat, except the typed `sign_policy_change` in the merge design |
| improve_run: run, claim, register_skill, skill_transitions | A | loop and skills step |
| improve_status | S | Namespaces, and Agents' budget panel. `needs_dustin` and `maintenance` are served but not typed for the Portal (`ops-types.ts:480-497`) |
| agents: list, revoke | S | Agents view, drawer |
| agents: mint | R | never mints |
| agents: update_scopes | M | No. Rare and security-sensitive: record chat-only |
| claims: aggregate, job | S | Claims view |
| claims: export | M | Yes, as a download button. `aggregate.waits[]` and `usage[]` are served and never rendered: render them as visuals 5 and 6 |
| ci_status | S (partial) | CI shows the latest run per repo only, with no history |
| ci_dispatch | M | Rarely. A "Re-run" on a red default branch saves a chat. Optional |
| ops_snapshot | S | it is the feed |
| cloudflare_config | R | `docs/portal.md:155` |
| namespaces | S (partial) | Namespaces roster |
| register_namespace, update_namespace, delete_namespace | M | No. Admin setup is a few times a year: record chat-only |
| lint | M | No screen needed. Lint findings arrive as jobs. Record agent-only |
| docs read tools (list, read, brief, history, backlinks, find, search) and the MCP resource and prompts | M | No. Recommend the ruling the review proposed (knowledge store chat-only) |
| docs write tools, repo tools | A | agent memory, drivers |
| controls | S | it is the Portal's registry |

### Portal-only controls and Worker capabilities

| Capability | Mark | Note |
|---|---|---|
| site and package add, edit, remove | S | Settings. Undo instead of confirm (ruled in the review) |
| Refresh | S | top bar, `r` |
| `/ops/inbox` | M | **Yes.** Feed it into Needs you and the strip badges (`lib/apps.ts:5-8`) |
| `/ops/backup` (run a backup now) | M | Rarely. The daily cron covers it. A button on Health is cheap if a failed run is common |
| `/ops/hooks` sessions | S | Queue "Live sessions" |
| OTLP usage | M | Yes, as visual 6 (cost) |
| task ledger (`task_runs`) | S | Incidents "Scheduled tasks" |
| watcher checks (14) | S | Incidents "Last watcher pass" |
| `/csp-report`, `/improve/*`, OAuth routes | A | machine routes |

**Totals for master (by row):** S 14, R 5, A 9, **M 22**. Dustin needs 13 of the 22 on a screen. The rest are worth a recorded chat-only or agent-only ruling.

The 13: supersede, question, park and unpark, digest, plan, models, stale (Worker rules), PR close, budget visual, claims export with waits and usage, inbox, OTLP cost, and `needs_dustin` and maintenance. The review's 29 counted actions one by one; this table groups them by row.

## 2. Grouping by task frequency

**The 30-day audit query was not run.**
- `audit_log` is admin-only. No MCP tool returns audit rows (`read` and `brief` show only `last_actor`).
- The Portal's `/portal/api/activity` returns at most 50 rows with no date range (`src/portal-activity.ts:9`).
- This session's instructions allowed the Capsid connector only for job text and documents, and forbid touching live data.

So the ranking below uses the review's quoted 14-day counts, and the query is written here for the seat to run. As the admin (`wrangler d1 execute capsid --remote --command "..."`, read-only), or as a new admin Portal route:

```sql
-- Actions per family per day, last 30 days, one job transition counted once.
SELECT date(at) AS day,
       substr(action, 1, instr(action || '-', '-') - 1) AS family,
       action, COUNT(*) AS n
FROM audit_log
WHERE at >= datetime('now', '-30 days')
  AND action <> 'conventions-read'
  AND NOT (json_valid(params) AND json_extract(params, '$.sha256') IS NOT NULL
           AND json_extract(params, '$.job_id') IS NULL)
GROUP BY day, action ORDER BY day, n DESC;
```

The range form on `at` uses the `audit_log_at` index (migration 0005). Retention is 180 days, so 30 days is complete. The second filter drops the mirror-document row a job transition also writes.

**Task rank** (14-day counts quoted in the review):

| # | Task | Count | Today | Target |
|---|---|---|---|---|
| 1 | Answer a blocked job or question | block 652, resumed 612 | about 5 clicks | 1 tap from Needs you (recommended answer) |
| 2 | Approve or close a PR | manage_pr 265 | chat only | 1 tap, batch (merge design) |
| 3 | Supersede a job | 250 | chat only | 2 clicks, batch |
| 4 | Delete a merged branch | 78 | chat | none: automatic |
| 5 | Is anything broken? | not counted (reads) | Overview | Health page, glance |
| 6 | Change automation (pause, loop, overnight) | not counted | Namespaces | Settings > Automation |
| 7 | Look something up (an audit row, a claim, an agent) | not counted | Activity, Claims, Agents | Records |

### Proposed menu

| Group | Page | Task it serves | Built from |
|---|---|---|---|
| **Needs you** | Needs you (home) | 1, 2, 3 | Overview's Needs attention, plus `/ops/inbox`, CI's Awaiting the seat, questions and digest |
| **Work** | Queue | 3, and watching work move | Queue, plus parked, plan ("Tonight") and Live sessions |
| | Pull requests | 2 when not urgent; PR history | CI and merges (PR half) |
| **Health** | Health | 5 | Sites, Deploys, Incidents, Backups and the CI default-branch table folded into one page with sections |
| **Records** | Activity | 7 | Activity |
| | Agents and claims | 7, routing learning | Agents and Claims merged. Both answer "how is this agent doing"; Claims becomes a tab |
| | Packages | 7 | Packages (shown only when configured) |
| **Settings** | Settings | 6, setup | Settings plus the Namespaces automation panel and roster |

That is 8 pages, down from 13.

**Dropped as pages:**
- Overview: its tiles move to the top of Health, and its attention list becomes Needs you.
- Sites, Deploys, Incidents and Backups: these become sections of Health.
- CI: split between Health (default branches) and Pull requests.
- Namespaces: it is settings.
- Claims: a tab of Agents.

None of their content is removed (conventions 1.4); it moves.

**Keyboard.** `g` then a letter, regrouped: `g y` Needs you, `g q` Queue, `g p` Pull requests, `g h` Health, `g l` Activity, `g a` Agents, `g e` Settings. Old letters redirect for one release.

**Phone tabs.** Needs you, Queue, Health and More. More holds Pull requests, Records and Settings. Needs you carries the badge count.

**Desktop.** The left rail keeps the four groups. Badges:
- Needs you: count of items;
- Health: critical count;
- Queue: blocked count, minus what Needs you already shows. One number, one place.

## 3. Visuals

Rules:
- Each visual answers one named question.
- Each is drawn with an Enarratio primitive (`capsid/research/enarratio-coverage.md`: all needed types exist) and carries its `*Table` companion as the text equivalent (conventions 7.6).
- No decorative charts. A table stays wherever the question is a lookup.

**Two prerequisites:**
1. **How the Portal gets Enarratio** is still that research's DECIDE 1. It recommends a client-side call, after measuring size against the 105 KB initial and 40 KB per-lazy-chunk budget (`dashboard/scripts/size-budget.mjs`). Enarratio is not a dashboard dependency today, and the current charts are hand-drawn SVG in `dashboard/src/ui/charts.tsx`.
2. **The feed has no series longer than 7 days.** The longest are uptime rings, 10 deploys per site, 7 days of PRs, and 24 hours of ended jobs. Visuals 1, 2, 5, 6 and 7 need one new read-only admin route, `/portal/api/trends?weeks=8`, returning the shapes below from `audit_log`, `job_touches`, `job_outcomes`, `pr_approvals` and `deploy_outcomes`.

| # | Page | Question | Primitive | Data shape (real types) |
|---|---|---|---|---|
| 1 | Needs you, header | Am I spending less time on this than last month? | `sparkline`, 8 weeks, with "vs last week" as text in a Capsomer stat tile | `{week: "2026-W41", minutes: 47, decisions: 31}[]`. Minutes computed per the review's section 8: audit and touch rows by `access:` or the admin, sessions split at a 5-minute gap, plus 1 minute per session |
| 2 | Needs you, header | Where does waiting go? | `barChart` stacked horizontal, one bar per gate class | `ClaimsWaitRow` (`ops-types.ts:619`: `gate_class`, `ended_by`, `waits`, `waited_ms_median`) |
| 3 | Queue | Is the queue growing or draining? | `areaChart` stacked over 14 days: queued, claimed, blocked, parked | `{day, queued, claimed, blocked, parked}[]`, derived from job transitions in `audit_log` (`job-*` actions). The feed has only current state |
| 4 | Queue, "Tonight" | What will run overnight, and what was skipped? | `timeline`, lanes per repo | the `jobs` list view `plan`: per repo, ordered jobs with estimated minutes, plus skipped with reason |
| 5 | Agents | Does each agent's claim match what was verified? | `barChart` grouped: agree, disagree, unclaimed, unchecked per agent | `ClaimsGroup.evaluations` (`ops-types.ts:603`, `ClaimsAgreementCounts`) |
| 6 | Agents | What does the work cost, and is it on budget? | `lineChart` weekly cost with the monthly cap as a reference line | `ClaimsUsageRow` (`ops-types.ts:640`, telemetry beside reported) and `OpsLoop.budget{caps, spend}` (`ops-types.ts:314`) |
| 7 | Pull requests | How much merges with no human, and is that rising? | `barChart` stacked weekly: auto, approved, seat-merged, closed. Rollbacks as `lineChart` event markers | `auto-merged`, `approved-merged` and `manage_pr` merge audit rows. `deploy_outcomes` for the markers (merge design) |
| 8 | Health, top | Is every site up, and since when? | `uptimeStrip` per site (exists as `UptimeTicks`) | `SiteSnapshot.ring` (336 slots, `ops-types.ts:62`) |
| 9 | Health, Deploys | Did a deploy cause errors? | `lineChart` error rate with deploy event markers (exists as `ErrorChart`) | `SiteCloudflare.errors24: HourBucket[]`, `deploys: CfDeploy[]` (`ops-types.ts:25-46`) |
| 10 | Health, Backups | Is every retention slot filled? | `uptimeStrip` three rows: 14 daily, 8 weekly, 6 monthly | the backup run list by age. Today only `HealthSnapshot.backup.age_hours`. Needs the R2 listing in the snapshot |
| 11 | Health, CI | Which repos are red, and for how long? | `heatStrip`, repo by day, 14 days | `CiObservation` holds only the latest run, so this needs CI history in the trends route |

**Kept as tables:** Activity, Settings, the Agents roster and Claims "By check". Those are lookups or edits, where a table is the faster answer (NN/g, "Data Tables: Four Major User Tasks").

**Mock, visual 1** (fake numbers, real shape):

```
Minutes of Dustin per week        47 min   -18 vs last week
W34 ▆ W35 █ W36 ▇ W37 ▆ W38 ▅ W39 ▅ W40 ▄ W41 ▃
Table: week | minutes | decisions | median wait
```

**Mock, visual 2:**

```
Where waiting goes (median, 14 days)
question        ████████████  6.1 h
push_branch     ███           1.4 h
migration       ██            0.9 h
open_pr         ▌             0.2 h
```

## 4. Needs you, the inbox page

- **Item kinds** come from `InboxKind` (`src/inbox.ts:25`: blocked-job, question, pr, ci, site-down), extended with:
  - supersede suggestions (a duplicate title or a merged PR);
  - promotion proposals (merge design section 7);
  - `typed` PRs.
- **Each row** shows a headline, the reason in one line, evidence (CI on the head sha, files by path class, the reviewer verdict, the job), and the recommended answer pre-filled and editable.
- **Primary action on the row:** Resume with the answer, Approve, or Supersede. Reversible actions apply at once with Undo during a short send delay. One-way actions keep a confirm.
- **Batch:** select rows of one class, then one action. The Capsomer BulkBar does this. A batch that mixes classes offers no action. A `typed` row cannot be selected.
- **Empty state:** "Nothing needs you." Show the time of the last item answered and the minutes-per-week tile.
- **Since you last looked:** the digest strip (`jobs` view `digest`): merged overnight, auto-merged, rolled back.

## 5. Best practice read

Sources were seen through search results on 2026-10-09. The session's proxy refused page fetches, so no page was opened; verify before quoting.

- **Linear Inbox and Triage** (linear.app/docs/inbox, /docs/triage): act on the row with single keys (accept, decline, duplicate, snooze), and a snoozed item returns on new activity. Adopted: row actions, keys, and snooze as a later option. Linear's dashboard guidance (linear.app/now/dashboards-best-practices) warns that most dashboards go stale and says to pair a metric with a comparison. Hence the "vs last week" text on every trend.
- **Vercel** (vercel.com/docs/projects, /docs/observability, /docs/deployments/instant-rollback): the project overview leads with the current production deploy, and error rate is drilled from a graph to logs. Adopted: Health shows the live sha, deploys and errors together, and rollbacks are visible on the chart.
- **GitHub notifications inbox** (docs.github.com, "Managing notifications from your inbox"): Done, Save and bulk triage, with filters by reason. Adopted: batch and a reason filter on Needs you. GitHub's merge queue page shows queued PRs with a remove action, a model for the Pull requests page.
- **Stripe Radar review queue** (stripe.com/docs/radar/review): a queue built from rules, with related items shown together. Its tuning advice: if most reviews are approved, narrow the rules. That is the same feedback the merge design's promotion step automates. Stripe labels home charts as estimates (support.stripe.com). Adopted: the minutes metric says it is an estimate.
- **NN/g**: preattentive attributes and linear encodings over area ("Dashboards: Making Charts and Graphs Easier to Understand"). A badge alone is not enough for critical information ("Indicators, Validations, and Notifications", 2024). Alert fatigue (video, 2022). Hence a critical item is a row and a push, not only a badge.
- **Chart choice** (UK Government Analysis Function, "Choosing visualisations"; IBM Carbon, "Chart types"): decide the message first; tables for lookup, bars to compare, lines for change over time. **WCAG 2.2**: 1.4.11 non-text contrast 3:1, 1.4.1 not colour alone, 1.1.1 text alternative. Enarratio's `*Table` companions meet 1.1.1.
- **Agent approval queues**: LangChain Agent Inbox (accept, edit, respond, ignore per interrupt); GitHub Copilot's Agents tab (changelog 2026-01-26); Cursor background agents attaching screenshots and logs to the PR. The unit reviewed is the proposed action with its evidence, not the source message. Adopted as the inbox row.
- **Own knowledge**: Stephen Few's single-screen, at-a-glance rule for monitoring dashboards. Only secondary summaries were found (Dundas; UXmatters review, 2007).

## 6. What renders today

Claude in Chrome was not available in this cloud session, so https://portal.dustinedwards.info was not opened. Nothing here is verified against a render. Section 10 of the experience review holds the prompt for that check. Run it before the page merges in section 2, and again after.

## DECIDE

In the order Dustin should answer them; each has a recommendation.

1. **Needs you as the home page**, fed by `/ops/inbox`, replacing the Overview's attention list. Recommend yes.
2. **Eight pages instead of thirteen** (section 2 menu), with Health absorbing Sites, Deploys, Incidents, Backups and the CI branch table. Recommend yes, built as one change after the inbox.
3. **Missing screens to build:** supersede, question mark, parked and unpark, digest strip, Tonight plan, PR close, claims export, and the Worker's stale rules. Recommend all eight, in that order.
4. **Chat-only rulings to record:** knowledge store, job post and edit, agent scopes, namespace admin, Cloudflare config, budget edits, signing (except the typed policy change). Recommend recording all in `capsid/decisions.md`.
5. **The trends route** (`/portal/api/trends`, admin, read-only), which visuals 1, 2, 3, 5, 6, 7 and 11 need. Recommend yes. It also gives the seat the 30-day audit count without a shell.
6. **The eleven visuals in section 3.** Recommend 1, 2, 7 and 3 first: they measure the goal (minutes, waiting, unattended merges, queue drain). The others follow the Enarratio swap.
7. **Enarratio delivery** (enarratio-coverage DECIDE 1): recommend a client-side call for the existing charts, measured against the size budget first, as that document says.
8. **Keyboard letters regrouped**, with the old ones redirecting for one release. Recommend yes.
9. **Run the Claude in Chrome check** before and after the regroup. Recommend yes, from a seat session with the browser.
