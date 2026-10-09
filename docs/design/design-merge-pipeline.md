# Design: the merge pipeline end to end

Job job_cefba61b515c, 2026-10-09. Design only: nothing here is built. It answers DECIDE 2 of `capsid/research/design-experience-review.md`. It works alongside job_1057e44ecffe (`docs/design/design-portal-evaluation.md`), which owns the inbox's screens. This document owns the approval record, the executor, the classes and the safety after merge.

The goal, from Dustin: as much automation as possible. Dustin decides only the exceptions, from wherever he is. The number to watch is minutes of Dustin per week.

Rulings already made on 2026-10-09 and taken as given:
- an inbox that shows only exceptions, each with its reason, evidence, an editable recommended answer, and batch approval;
- Undo instead of a confirm for reversible actions;
- the minutes metric;
- auto-merge policy v6 (job_26fc4d8f8ade);
- the narrower risk test, `worthReviewer` (job_48dec4c93b47, option b);
- own packages update at once (job_3b09752450c1).

Read at master e2762d8. "Measured" means read in code or in the store on 2026-10-09. "Own knowledge" marks a claim from the researcher's own knowledge rather than a source.

## 0. Summary

Most of the machine already exists:
- the five-minute auto-merge tick, with a head-sha pinned merge;
- branch deletion after a merge;
- a live gate after every capsid deploy, with an automatic rollback;
- a pull-only inbox endpoint;
- the outcomes tables.

Four things are missing:
1. **A record of a human approval of a pull request.** Today the only way past the policy is the seat merging by hand with `manage_pr`.
2. **A classifier** that says which class a pull request is in, and why.
3. **Any outbound notification.** Nothing in the Worker sends anything.
4. **Any memory of a rollback.** Rollbacks reach only the GitHub step summary.

The design adds one table, one Portal control that chat reaches through the existing `controls` tool (so no new tool), one executor branch inside the existing tick, one watcher reader for deploy outcomes, and one push channel. Promotion and demotion come last, because they need the records the earlier steps start writing.

**Current blocker.** The store copy of `capsid/policy/auto-merge.md` is still version 5, and the code on master enforces version 6. Code and document must agree, so nothing auto-merges anywhere until Dustin signs v6 (job_26fc4d8f8ade summary; store read 2026-10-09). That signature is step zero.

## 1. What exists today

| Piece | State on master | Where |
|---|---|---|
| Auto-merge tick | Runs every 5 minutes (`*/5`). Lists up to 100 open PRs per covered namespace and runs 12 checks in order. Merges with method `merge`, pinned to the head sha: a 409 becomes `HeadMovedError`, audited as `failed: head_moved` | `src/improve/tick.ts:99`, `src/auto-merge-tick.ts:259,375,412-427`, `src/auto-merge-policy.ts:38-51` |
| Covered namespaces | v6 code: dustinedwards, carrel, capsomer, and capsid limited to `docs/` outside `docs/policy/` plus `dashboard/**/*.css`. The signed store copy is v5 | `src/auto-merge-policy.ts:124-129`, `docs/policy/auto-merge.md` |
| Audit | `auto-merged`, `auto-merge-declined` (written only when the pair head sha and failed check changes) and `auto-merge-failed`, all with actor `improve-loop`. The awaiting-seat set is rewritten to KV each tick | `src/auto-merge-tick.ts:148-222,347-361` |
| Branch delete after merge | Yes, through `manage_pr` merge (`deleteHeadBranchAfterPr`). Fork heads, the default branch and `improve/` are skipped. The `auto-merged` row does not say whether the branch was deleted | `src/github/refs.ts:97-140,200` |
| Risk tests | `riskOf` routes models only and marks 70 of the last 100 capsid PRs high. `worthReviewer` judges code files only, and nothing calls it | `src/model-routing.ts:104-120,160-181` |
| Second-vendor reviewer | None wired. The Grok driver key exists (job_436a6d8bdb9c is done). D5 advisory waits on the seat | job_48dec4c93b47 |
| Human approval of a PR | None. The REVIEW comment gate checks job transitions, not merges. `approved_by_policy` covers gates, not merges | `src/review.ts`, `src/jobs-seat.ts:721-790` |
| Manual merge | `manage_pr` merge needs `can_merge`, held by the admin, `seat` and `site-seat`. Default method squash, optional sha pin | `src/tools/repo.ts:253-300`, `src/scope.ts:526` |
| Portal and merging | The Portal never merges and never mints. A test plants a merge and asserts it is refused | `docs/portal.md:200`, `test/portal-actions.test.ts:229,264` |
| Deploy, capsid | CI deploys on every push to master, then `verify:live` runs 9 gates against `EXPECT_SHA`. On a refusal: `rollback-guard.mjs`, then `wrangler rollback`, then `/health` is polled until the sha moves | `.github/workflows/ci.yml:194-362`, `test/deploy-pipeline.test.ts:45` |
| Deploy, other repos | dustinedwards deploys by `workflow_dispatch` only. carrel deploys on a push to main. capsomer changes no site until a tag is pinned. Whether carrel has a live gate or rollback was not read here (other repo) | `docs/policy/auto-merge.md`, "What a merge means" |
| Live checks | The watcher reads CSP, headers, analytics and sha drift (a sha rule fires after 45 minutes). Read-only, never rolls back | `src/live-checks.ts`, `docs/live-checks.md` |
| Rollback memory | None in D1. `docs/rollback.md` describes only the manual command and omits the CI rollback | `docs/rollback.md` |
| Notifications | None. Every surface is pull: `improve_status`, `GET /ops/inbox`, the digest view, and the Portal polling every 60 s | `src/inbox.ts:76`, `docs/overnight.md:32` |
| Outcomes | `job_outcomes` (`ci_green`, `prs_merged`, cost, `model_*`), `job_outcome_prs`, `job_touches` (`kind` and `actor_kind`), and the `models` learning view, which proposes and never applies | `migrations/0011`, `0015`, `0031`, `src/model-learning.ts:39-80` |
| Money | `isMoneyPath` covers billing, payments, checkout, invoices, pricing, subscriptions, stripe, payouts and refunds. foxhound is not covered by auto-merge | `src/scope.ts:505-511` |

## 2. The classes

Every open PR on a covered repo gets exactly one class. The class is computed each tick by a pure function, `mergeClass(pr, policy, facts)`, and stored with its reasons:

| Class | Meaning | Who acts |
|---|---|---|
| `auto` | Passes every check of the signed policy, and the namespace's class rule allows its path class | The tick merges it. Dustin never sees it |
| `approve` | Fails only on rules a person may waive (path class not promoted, `worthReviewer` = worth, a refused path that is not money, migration or workflow) | One tap in the inbox, batchable |
| `typed` | Any money path, or any foxhound path that touches billing | A typed confirmation (the PR number), never batched, never automatic |
| `seat` | Needs a human step outside a merge: an unapplied migration, a workflow change the App cannot merge, a fork head, a base that is not the default branch | Stays with the seat as today, shown in the inbox with the command |
| `wait` | CI is not finished, or the PR is a draft | Nobody. Hidden from the inbox |

**Path classes.** The code holds a fixed set, derived from the changed files:
- `docs`
- `dashboard-css`
- `dashboard-code`
- `tests`
- `deps-own` (DrDustinEdwards packages, per job_3b09752450c1)
- `deps-other`
- `src-routine` (code that `worthReviewer` skips)
- `src-worth`
- `migration`
- `workflow`
- `money`

A PR's path class is the riskiest one any of its files falls in.

**The second reader.** Once D5 is built, the advisory reviewer's verdict sits on the card as evidence. It can only move a PR down a class (`auto` to `approve` on CHANGES or BLOCK), never up. That keeps the tick's decision independent of a model's opinion. Until D5 ships, the class rests on paths and CI alone.

**capsid.** v6 allows only docs and dashboard CSS, so a capsid `src-routine` PR is class `approve`: one tap, no longer a chat merge. Section 6 is how it can earn `auto`.

## 3. The approval record

**Table.** A new table `pr_approvals`, written by an additive migration (a gate, so for the seat):

```
id INTEGER PRIMARY KEY, repo TEXT, pr INTEGER, head_sha TEXT, class TEXT,
status TEXT CHECK (status IN ('approved','voided','merged','expired','refused')),
approved_by TEXT, surface TEXT CHECK (surface IN ('portal','chat','push','typed')),
batch_id TEXT, reason TEXT, approved_at TEXT, closed_at TEXT, close_reason TEXT,
merge_sha TEXT
```

- One open (`approved`) row per (repo, pr), held by a partial unique index.
- Every state move is `UPDATE ... WHERE id = ? AND status = 'approved' RETURNING id` (CLAUDE.md, path mutation rule).
- Each move writes an audit row: `pr-approved`, `pr-approval-voided`, `pr-approval-expired` and `approved-merged`. Each row carries who, surface, head sha, class and batch.

**Why not reuse `job_touches`?** A touch belongs to a job and is append-only. An approval needs a mutable lifecycle keyed by PR and head sha, and some PRs (Renovate bumps) have no job. The touch is still written beside the row when the PR names a job, so the minutes metric and the methods paper see it.

**One write path, three surfaces.** A new control, `approve_pr`, joins `PORTAL_ACTIONS` (`src/controls.ts:34-51`):
- **Portal.** Preview and perform go through `/portal/api/actions/*` and write `portal-approve_pr`.
- **Chat.** The seat says "approve 312, 315". The session calls the existing `controls` tool, `perform approve_pr {repo, prs: [312, 315]}`, which writes `control-approve_pr`. No new tool, so no `TOOL_GRANTS` change and no ruling under CLAUDE.md rule 1. The `controls` tool is admin-only today, which matches "only Dustin approves".
- **Push.** The phone's Approve button calls a single-use signed URL (section 5). It performs the same control with `surface: push`.

`approve_pr` reads the PR's current head sha from GitHub at perform time, and refuses if:
- the class is `typed` and no `confirm` equal to the PR number is sent;
- a batch holds any `typed` PR (the whole batch is refused, so nothing is half-approved);
- the class is `seat` or `wait`;
- the caller is not the admin.

Undo is a void with reason "undone", allowed until the executor merges. The control never merges. "The Portal never merges" stays true, and its PLANT test stays green.

## 4. One executor

The auto-merge tick gains one branch after its policy pass. For each PR with an `approved` row:

1. Head sha differs from the approval's: void it with "new push". The inbox re-asks, showing what changed since the approval (a compare link). GitHub's own setting works the same way: "Dismiss stale pull request approvals when new commits are pushed" (GitHub Docs, "About protected branches").
2. Approval older than 7 days: expire it.
3. `ci_green` on that exact sha, through the same function and the same required steps as the policy: wait. Red CI voids the approval with "CI red".
4. `head_in_base_repo` and `base_is_default_branch` fail: refuse.
5. Otherwise `managePr(..., "merge", headSha)`, the code path that exists. A 409 voids the approval as head moved. Success moves the row to `merged` with `merge_sha`, and writes `approved-merged`.

The tick runs every 5 minutes, so an approved PR with green CI merges within 5 minutes. A PR whose CI is still running merges on the first tick after it goes green. The merge method stays `merge`, so the approved head sha survives in history.

The executor is the only thing that merges an approved PR. The seat keeps `manage_pr` as the manual path for class `seat`.

Its source is a refused path (`src/auto-merge-tick.ts`), so the PRs that build it wait for the seat. That is intended.

## 5. Reaching Dustin

**Inbox.** Shown in the Portal (screens in the Portal evaluation design). It lists `approve`, `typed` and `seat` PRs beside blocked jobs and questions, read from the one `/ops/inbox` gatherer (`src/inbox.ts`), extended with the class and its reasons. Each card shows:
- the class and why;
- CI on the head sha;
- the reviewer verdict when one exists;
- files by path class;
- the linked job;
- a recommended answer ("Approve" for an `approve` PR with green CI and no reviewer objection).

**Phone push**, for urgent items only:
- a `typed` PR waiting more than 2 hours;
- a rollback;
- a correction cap reached;
- a question over 4 hours old on a job with priority 70 or more.

Everything else waits for the morning digest. The research on approval fatigue all points the same way: gate by risk tier and keep low-risk items out of the queue (TechTarget, "The human in the loop is falling asleep"; Tian Pan, "Approval Fatigue", 2026-06-25; both opinion pieces).

| Channel | Extra cost | Approve button | iOS | Notes |
|---|---|---|---|---|
| Web Push (VAPID) from the Worker | $0 | Android and desktop: yes | **No action buttons. Opens a URL. Needs a Home Screen web app** (OneSignal Safari Web Push FAQ; Apple Developer Forums thread 726793) | No third party, but no Approve button on an iPhone |
| ntfy.sh | $0 on the free tier (rate-limited) | Yes: an `http` action POSTs to a URL (docs.ntfy.sh/publish) | Yes, view and http actions since iOS app 1.1 (docs.ntfy.sh/releases) | A public topic is secured only by its name. Message text passes through ntfy.sh |
| Telegram bot | $0 | Yes: inline keyboard plus `callback_query` to a Worker webhook | Yes | A bot token as a secret. Message text passes through Telegram |
| Email (`send_email`) | $0 to a verified address (Cloudflare "Send emails from Workers") | Link only | Any mail app | Good for the digest. Needs Email Routing on, which is an account setting |

**Recommendation: ntfy for push and email for the digest.** It is the only $0 channel with an Approve button on both phone platforms and no bot account to run.

The button never carries authority on its own. It POSTs to `https://mcp.dustinedwards.info/ops/approve/<token>`, where the token:
- is an HMAC over (repo, pr, head sha, expiry 30 minutes);
- is single-use (KV) and checked against the current head;
- is accepted only for class `approve`.

A `typed` or `seat` item gets an Open link to the Portal and never an Approve button. The message names only repo, PR number and class, never the title, so a private repo's work does not pass through ntfy.sh.

If Dustin's phone is Android-only, Web Push removes the third party, so the channel is a DECIDE.

## 6. Safety after merge

**What exists per repo.**
- **capsid** is covered end to end: deploy, 9 live gates, automatic rollback, and `/health` polled until the sha moves.
- **carrel** deploys on merge. Its live gate and rollback were not read from here.
- **dustinedwards** ships by dispatch, so a merge deploys nothing.
- **The other configured sites** (germomics, foxing, foxhound, txasm, bsw, julieedwards on Vercel, claude-skills) are outside auto-merge. The watcher covers them with probes and sha drift only.

**What is missing.**
1. **A shared deploy, verify and rollback workflow.** Port capsid's `live` job (`ci.yml:256-362`) and `scripts/rollback-guard.mjs` into one reusable workflow in the shared devkit repo (renovate-config, due to be renamed by job_a2ff4667382e). Each repo calls it with its Worker name, health URL and verify command. Cloudflare's rollback swaps code and bindings only. It is blocked when D1 or KV resources changed between the two versions, and it never undoes a D1 migration (Cloudflare Docs, "Rollbacks"). That is why `migration` stays class `seat`. Data recovery is D1 Time Travel, by hand (Cloudflare Docs, "Time Travel").
2. **Memory of a rollback.** The watcher already reads each roster repo's latest default-branch CI run (snapshot `ci`). It gains a reader for the `live` job's conclusion and its step summary (`rollback_from` and `rollback_to`). A rollback becomes a critical inbox row, a push, and a row in a new `deploy_outcomes` table: repo, sha, PR, outcome (`verified`, `rolled_back` or `rollback_failed`), at. No CI secret is added, because the watcher reads CI with the App's existing access.
3. **Verify before traffic, later.** Cloudflare lets a new version be uploaded without traffic and called through the `Cloudflare-Workers-Version-Overrides` header, then promoted (Cloudflare Docs, "Version overrides" and "Gradual deployments"). Running `verify:live` against the uploaded version before it takes traffic turns a rollback into a promotion that never happens. That matches the canary idea of a partial, time-limited deployment and its evaluation (Google SRE Workbook, "Canarying Releases") and Argo Rollouts' abort on a failed analysis. It costs a second deploy path, so it comes after the rollback memory, and only if rollbacks happen.

capsid is included in one-tap approval. Its protection is the live gate and the rollback, not routing through chat.

## 7. Earned promotion and demotion

**Unit.** One unit is (namespace, path class). The signed policy gains a section listing which units are `auto`. Like the author allowlist, the list lives only in the document. The code holds the fixed set of path classes and refuses a document that names an unknown one.

**Evidence, per unit, over 90 days.** These are the same windows the `models` view uses:
- approved merges from `pr_approvals`;
- approvals voided by CHANGES or a reviewer BLOCK;
- rollbacks and reverts from `deploy_outcomes`;
- the CI-green share from `job_outcomes`.

**Promotion proposal.**
- Rule: at least 20 approved merges over at least 14 days, no rollback, no revert, and at most one approval voided for anything but a new push.
- What it raises: an inbox item, "Promote capsid tests to auto: 24 approved, 0 rollbacks, median 3 minutes of Dustin". It carries a recommended Approve.
- What Approve does: writes the next policy version (snapshotted, audited) and signs it in one admin control, `sign_policy_change`. That control needs a typed confirmation of the new version number, because it widens autonomy.
- Signing stays admin-only, as `improve_run sign_policy` is (`src/policy-sign.ts:41-124`).

**Demotion.**
- Trigger: a rollback or a revert of a PR from an `auto` unit.
- Immediate effect: the tick suspends that unit (a KV flag, so its PRs fall to `approve`). This only narrows, so it needs no human, and the inbox shows it with Undo.
- What it raises: a proposal to remove the unit from the signed list, approved the same way.

The learning table proposes and never applies (conventions 11.3). Promotion follows the same rule: every widening is one tap and one signature by Dustin.

## 8. The permanent exception

Money paths, and foxhound billing in particular, are class `typed`, whatever the promotion record says:
- **Never automatic.** `paths_not_money` stays first in the never-list, and `mergeClass` maps `money` to `typed` before any class rule is read.
- **Never batched.** `approve_pr` refuses a batch that holds one.
- **Never approved from a push.** The button is absent.
- **Approved only by typing.** The PR number is typed in the Portal, or sent as `confirm` from chat.

foxhound stays outside the auto-merge roster unless Dustin adds it. Even then its money paths stay `typed`.

## 9. Cost and PR order

Sizes: S is under a day of driver time, M is one to two days, L is more.

| # | PR | Size | Gate | Proves (each seen red once) |
|---|---|---|---|---|
| 0 | Dustin signs auto-merge v6 | n/a | seat | the next tick's `auto-merged` row names version 6 |
| 1 | `docs/rollback.md` describes the CI rollback. `docs/autonomy.md` says v6 for the author allowlist | S | none (docs) | `npm run lint` |
| 2 | `mergeClass` and path classes, report-only: the class and its reasons go into the awaiting-seat set and `/ops/inbox` | M | seat (touches the tick) | unit tests per class. A money file in a docs PR gives `typed`. A migration gives `seat`. A plant mapping `money` to `approve` turns the test red |
| 3 | Migration `pr_approvals`, plus control `approve_pr` with void on head move and Undo | M | seat (migration) | a plant where the control merges turns `test/portal-actions.test.ts:229` red. A batch with a money PR is refused whole. Approval at sha A with head B is refused |
| 4 | Executor branch in the tick | M | seat (refused path) | approved and green merges. Head moved voids. Red CI voids. Expiry at 7 days. A 409 voids. The merge carries the approved sha (extends `test/auto-merge.test.ts:1276,1287`) |
| 5 | Inbox screens (Portal evaluation design) | M | visual label, Dustin | browser test: approve two PRs in one batch |
| 6 | Deploy-outcome reader, `deploy_outcomes`, rollback finding | M | seat (migration) | a fixture CI run with `rollback_from` gives a critical row. A green run gives `verified` |
| 7 | ntfy push and the `/ops/approve/<token>` route | M | seat (secret: topic name and HMAC key) | a reused token is refused. A token for an old head is refused. A `typed` PR gets no button |
| 8 | Shared deploy-verify-rollback workflow, adopted by carrel, then each Worker site | M plus S per repo | seat (workflows) | a planted failing verify triggers the rollback in a test deploy (`test/deploy-pipeline.test.ts:45` as the model) |
| 9 | Promotion and demotion proposals, report-only | M | seat | a fixture with 20 clean merges proposes. One rollback suspends the unit |
| 10 | Class list in the policy (v7), plus `sign_policy_change` | M | seat, signature | a document naming an unknown class is refused at load. A missing typed version is refused |
| 11 | D5 advisory reviewer verdict on the card | S once D5 exists | seat | a BLOCK verdict moves `auto` to `approve` |

PRs 2 to 4 are the core, and the first measurable drop in Dustin's minutes comes after PR 5. The minutes metric (experience review section 8) counts `pr-approved` rows by surface from PR 3 on.

## 10. Sources

Every external source below was seen through search results on 2026-10-09. The session's network proxy refused page fetches, so no page was opened. Verify a quote before relying on it.

- GitHub Docs, "About protected branches" (stale approvals; approval of the most recent push). "Managing a merge queue" (`merge_group`, eviction on a failed check). "Automatically merging a pull request" (auto-merge is disabled when someone without write access pushes).
- Mergify, "Speculative Checks" and "Batches". Graphite, "Graphite Merge Queue". bors.tech (test the merged result before the branch moves). A queue is not proposed here: one executor merging approved heads one at a time, with a 5-minute tick, does not have the throughput problem queues solve (own knowledge).
- Cloudflare Docs: "Rollbacks" (the newest page says 100 versions, older copies say 10; rollback is blocked across D1 or KV resource changes); "Versions and deployments"; "Gradual deployments"; "Version overrides"; "Time Travel"; "Workers pricing" (the Paid plan is $5 a month); "Send emails from Workers".
- Google SRE Workbook, ch. 16, "Canarying Releases". Argo Rollouts, "Analysis and Progressive Delivery". Flagger docs. Vercel, "Instant Rollback". DORA, "DORA's software delivery performance metrics" (change fail rate, failed deployment recovery time).
- Anthropic, "Building Effective AI Agents" (2024-12-19) and "Our framework for developing safe and trustworthy agents" (2025-08-04). Claude Code docs, "Choose a permission mode". OpenAI, "Guardrails and human review" (`needsApproval`). LangGraph, "Interrupts". GitHub Docs, "Reviewing a pull request created by Copilot" (the requester cannot approve their own agent's PR), and the changelog of 2026-03-13 (an opt-out of the workflow approval).
- TechTarget, "The human in the loop is falling asleep". Tian Pan, "Approval Fatigue" (2026-06-25). Opinion pieces.
- ntfy docs, "Sending messages" and "Releases". OneSignal, "FAQ: Safari Web Push". Apple Developer Forums 726793. MDN, `showNotification()`. Pushover licensing.
- Own knowledge: that merging a PR that changes `.github/workflows/` through a GitHub App needs the App's workflows permission, which is why `workflow` is class `seat`.

## DECIDE

In the order to answer them. Each has a recommendation.

1. **Sign auto-merge v6 now.** Until it is signed nothing auto-merges anywhere. Recommend yes, today.
2. **The classes** (`auto`, `approve`, `typed`, `seat`, `wait`) and the rule that an approval can waive a refused path except money, migration and workflow. Recommend yes. Approval replaces the seat's hand merge for those PRs.
3. **The approval record:** a new `pr_approvals` table, with chat reaching it through the existing `controls` tool and no new tool. Recommend yes.
4. **Executor rules:** an approval voids on a new push, on red CI or after 7 days, and the executor merges within one tick of green. Recommend yes, with 7 days.
5. **Push channel:** ntfy with signed single-use Approve URLs and no titles in messages, plus the digest by email. Recommend ntfy if the phone is an iPhone, and Web Push if it is Android. Turning Email Routing on is an account setting for Dustin.
6. **Push triggers:** a typed PR waiting over 2 hours, a rollback, a correction cap, and a priority question over 4 hours. Recommend these four only.
7. **Rollback memory:** the watcher reads CI's live job and writes `deploy_outcomes`, with no new CI secret. Recommend yes.
8. **The shared deploy-verify-rollback workflow** in the devkit repo, adopted by carrel first. Recommend yes. Verify-before-traffic waits until a rollback has happened.
9. **Promotion:** at least 20 approved merges over at least 14 days, no rollback and no revert, proposed in the inbox and approved by typing the new policy version. Recommend yes.
10. **Demotion:** a rollback suspends the unit at once (it only narrows), and the permanent removal is proposed. Recommend yes.
11. **Money:** typed confirmation forever, no batch, no push button, whatever the record says. Recommend yes. This only restates the ruling.
