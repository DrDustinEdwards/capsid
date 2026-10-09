# The knowledge model

Capsid stores documents. This describes how they are organised and what the rules
around them are.

**This document is redacted from the private canon.** Capsid documents itself, in
itself, and those documents are the authority. What is here is the model; what is
not here is the content, the namespace inventory, and the rulings. Where the two
ever disagree, the private document is right and this one is stale.

## Documents

A document is a row: namespace, path, title, body, type, status, tags,
`created_at`, `updated_at`.

- **Namespace** is a project, one per repository. It is also the authorization
  boundary for repository access: the namespace-to-repository mapping is what
  decides which repository a tool call can reach, so an unmapped selector is
  rejected rather than guessed at.
- **Path** is a flat filename inside a namespace, like `decisions.md`. Structure
  lives in the path and the type, never in nested namespaces. Consolidated raw
  material moves under an `archive/` prefix and stays there.
- **Body** is markdown. FTS5 indexes title and body, kept in step by triggers on
  the documents table, so search is a property of the write rather than a
  separate job that can fall behind.

### Types

| type | what it is |
| --- | --- |
| `core` | one always-loaded summary per namespace, read first to orient |
| `concept` | a compiled wiki topic, one subject per document |
| `decision` | a ruling and the measurement that forced it |
| `spec` | a design a piece of work is built to |
| `protocol` | a tested procedure |
| `procedural` | rules for working in a namespace |
| `task` | an open piece of work |
| `reference` | pointers outward: URLs, dashboards, lookup tables |
| `semantic`, `note`, `post` | compiled knowledge and content |
| `episodic` | a session record: raw material for the consolidation loop |
| `source` | raw, un-compiled input, an inbox |
| `prompt` | a reusable template, with `{{variable}}` placeholders |

The write path validates the type. An unknown type is refused rather than stored,
because a document with an invented type is invisible to every query that names
the real ones.

### Statuses

`draft`, `ready`, `active`, `published`, `superseded`, `closed`. `published` is the
default.

Status records editorial state and never decides what the consolidation loop can
see. Only the `archive/` prefix does that. This rule has a measured failure
behind it: while the loop's queries filtered on `status = 'published'`, documents
written as `active` were invisible to the backlog count, absent from the
consolidation packet, and therefore unreachable by the step that archives what
the packet surfaced. The gate read 2 against a real backlog of 24 and waved
through five consecutive sessions.

## Links

Documents carry typed outgoing edges: `governs`, `references`, `supersedes`,
`replaces`, `depends-on`. An edge names a namespace and a path on both ends, so it
can cross namespaces.

Edges are moved by the same helper that moves a document, which is the only reason
a rename does not orphan them. An edge whose endpoint no longer exists is
reported, never auto-repaired. A dangling edge usually means the target was
renamed by hand or removed before a delete cascaded, and which of those it was
decides whether the fix is repointing the edge or dropping it. The Worker does
not make that call.

## The write path, and what it guarantees

Four invariants, each enforced in code rather than by discipline:

1. **Every overwrite and every delete snapshots the prior row** into a versions
   table and appends to an audit log. There is no write path that skips either.
   Retention on snapshots is by age.
2. **A path mutation goes through one helper and nowhere else**, and a mutating
   batch carries its own existence predicate, so a zero-row move or delete aborts
   instead of reporting success. Row counts from the database cannot be used for
   this: the FTS triggers inflate them.
3. **Writes normalize wide dashes to ASCII server-side**, so no client can store
   an em dash regardless of what it sends. Only the text the caller supplies is
   normalized: an append or a patch leaves the stored text around it as it was.
   Scope: document writes only. Repository
   writes pass content through verbatim, which is a known and deliberate gap.
4. **An optional `if_match` is enforced at commit time**, inside the mutation
   batch, against the body itself rather than a stored hash. A mismatch aborts the
   whole transaction and returns the current hash to rebase against. Racing
   creates resolve to one winner and one refusal.

## Deleting a namespace

`delete_namespace` is admin only and takes two calls. `action: "preview"` writes
nothing. It counts everything that names the namespace and returns a verdict, and
when nothing refuses, a token bound to the namespace, `cascade`,
`allow_improve_paths`, those counts and the caller, valid for five minutes.
`action: "perform"` takes the same arguments and the token, reads the counts again,
and refuses if any of them moved. Then it commits one batch whose first statement
aborts it unless the store still matches the plan.

It refuses, whatever `cascade` says:

- while any job in the namespace is queued, claimed or blocked. End each with the
  `jobs` tool (`supersede` for a queued job, `fail` for a claimed or blocked one).
- while any live agent names the namespace in its scopes. Use the `agents` tool
  (`revoke`, or `update_scopes` to drop the namespace).
- while the namespace is on the improve roster, which is a list in code.

It also refuses while live documents exist and `cascade` is not true, and while the
namespace holds improve loop control documents and `allow_improve_paths` is not
true. `allow_improve_paths` needs the `can_touch_protected` flag, as it does on a
document delete.

What the batch deletes: every live document (every path outside `archive/`), each
snapshotted to `document_versions` first and then removed by the same path helper a
document delete uses, which takes every edge touching it too; the `ops_sites` row;
the `namespaces` row. An edge that was already dangling (its end in the namespace
names no document) touches nothing deleted and stays. One audit row, action
`namespace-delete`, holds the counts, the deleted paths, the removed edges, and
the `ops_sites` and `namespaces` rows whole. After the batch commits, the
namespace's four improve KV keys (`improve:best:`, `improve:paused:`,
`improve:anchor:`, `improve:driver:`) are deleted. A key that cannot be deleted is
named in the response, not dropped.

The whole delete is one D1 batch, and D1 caps a batch at 100 statements: five fixed
ones plus two per document. So a namespace with more than 47 live documents is
refused at preview and at perform, never half deleted. Delete or move documents
with the `delete` tool first, or ask the seat to rule a set-based helper.

What it keeps, because it is history: archived documents and the edges between
them, `document_versions`, `audit_log`, finished jobs, `job_outcomes`,
`job_claims`, `job_touches`, the skill records, every `improve_*` row, revoked
agents, the nightly backups and the holdout bucket. The kept archived documents
still carry the deleted name. `read`, `list`, `search`, `brief` and `history`
return them under it. `write`, `delete`, `move` and `restore` refuse there until
the name is registered again, and registering it again brings them back into
scope.

## Write modes

A write is one of four modes. Amending a large document used to mean re-emitting
the whole thing:

- `replace` writes a full body.
- `append` adds to the end. No title needed, no confirmation, because nothing is
  overwritten.
- `patch` replaces an anchored region. The anchor must occur exactly once or
  the write is refused, so a missed or ambiguous anchor cannot silently corrupt a
  body. Mismatched line endings are the usual cause of a missed anchor.
- `meta` changes type, tags, status or title and leaves the body byte-identical,
  normalization included.

Every mode returns the sha256 and byte count of the stored body, so a write is
verified without reading the document back. Pass that hash as `if_match` on the
next write to the same document and the server enforces the re-read rule.

A `patch` whose anchor equals its replacement is non-destructive. A match
  changes nothing and returns the same hash and byte count; a mismatch is a
  refusal that writes nothing. Use it to prove a moved block byte-exact at its
  destination, to read a document's current size without touching it, or to
  confirm an anchor exists exactly once before betting a real patch on it.

A wrong `if_match` is a non-mutating hash oracle. The server
refuses, writes nothing, and returns the current hash.

A hash computed locally over the body a read returned is the stored hash, so
a session that has already read a document does not need a write to obtain one.

## The consolidation loop

Raw material accumulates; the loop compiles it. The server orchestrates and does
no reasoning: whichever client is driving does all of it with the ordinary read
and write tools.

1. **gather** (read-only) returns the packet: the current `core.md`, the compiled
   concept and decision documents, every episodic and source document not yet
   archived, and the rules documents. It is size-bounded, and when it trims it
   stubs whole documents rather than truncating bodies. A truncated markdown
   document hides that the reader is holding a fragment.
2. The driving client compiles: dedupes, resolves contradictions, refreshes
   cross-references, and writes the results with the ordinary write tool.
3. **finalize** archives the consumed documents by moving them under `archive/`,
   in one batch, with one audit row. Archive only, never delete. gather
   excludes `archive/`, which is what makes the loop idempotent.

### report

A third mode measures the store instead of compiling it, and writes what it found
to `<namespace>/reports/lint-<date>.md`. Six checks: contradictions (prose
asserting a number the artifact disagrees with), stale decisions, unbound specs,
broken links, unconsolidated documents, and doc-vs-code drift, where a repository
path named in the canon is no longer in the repository. Documents by type is
counted and reported beside the checks rather than being one of them.

It produces one integrity percentage: subjects in good standing over subjects
judged. A check that could not run is excluded from the number rather than counted
as clean, and says so. An empty store scores null, not 100.

A number in a tool response is a number one session saw. A number in a dated
document is a series.

## Beyond tools

- **Resources.** Every document is addressable at `capsid://<namespace>/<path>`.
- **Prompts.** Every `prompt` document appears in the prompt list, with its
  `{{variable}}` placeholders as required arguments. `prompts/get` substitutes
  them and returns the body as an embedded resource, not as user text. A
  document body is writable by any session holding a write grant. Returning it as
  plain user text hands whoever last wrote that row a message the client's model
  reads as its own operator speaking.

## Jobs as evidence

A finished job writes one row to `job_outcomes` (`migrations/0011_job_outcomes.sql`),
so the queue produces the same kind of evidence the improve loop does. Before it,
the only record of how a job went was `result_summary`: prose, written by the party
being measured.

One row per job, keyed by `job_id`, written by `complete` and by `fail` alike.

A superseded job writes none. `supersede` closes a job the seat replaced before any
work was done on it, so there is nothing to record against a driver. The jobs that
`migrations/0020_jobs_superseded.sql` relabelled from failed to superseded had
already written a row when they were failed; those rows are kept, and every read
that builds a record or a count from `job_outcomes` leaves out a row whose job is
superseded (`src/agent-record.ts`, the skill totals in `src/improve-run.ts`, and the
pull request re-verification in `src/outcome-prs.ts`).

| column | what it is |
| --- | --- |
| `agent`, `namespace` | who did the work and where, copied from `jobs.claimed_by` at the moment the job ended rather than joined, since a later lease expiry clears that column |
| `prs_opened`, `prs_merged` | GitHub's answer whenever the driver named any pull request |
| `commits`, `files_changed` | the pull requests' own counts when there are any, the driver's otherwise |
| `tests_added` | the driver's claim, never verifiable here: "a test was added" is a judgement about a diff, not a property of it |
| `ci_green` | `1`, `0`, or `NULL` for not checked. A run still going is `NULL`, because "CI has not answered" is not "CI failed" |
| `blocked_count`, `resumed_count` | how many gates the job hit and how many times a human sent it back, the two numbers the Worker knows first-hand |
| `duration_minutes` | claimed to recorded. The final working stretch: `resume` takes a fresh lease, so time spent blocked waiting on a human is excluded |
| `result_kind` | `pr`, `doc` or `none`, derived from `result_ref` rather than declared |
| `verified` | a JSON object of booleans saying which of the above this Worker checked itself |

The Worker never stores a count it could check and did not. The driver reports;
this Worker holds a GitHub App token and can ask. Where a check ran the stored
number is GitHub's and the field is marked verified; where it could not run the
driver's number is stored and the field is not. Mixing the two would look like measurement.

Partial verification is refused. If any named pull request cannot be
read, every count on that row stays the driver's and every flag stays false. A
merged count over the subset that happened to resolve is a smaller number presented
as a total.

`NULL` is not zero. A field nobody reported is `NULL`; a field somebody counted
and found empty is `0`. An average over a column that spelled both the same way
would treat missing as empty.

### Claims apart from outcomes

`job_outcomes` keeps one value per field, and where the Worker could ask GitHub it
stores GitHub's number in place of the driver's. That loses the claim itself: how
often an agent's own account of its work is wrong cannot be read from a row that
overwrote the account. `migrations/0023_job_claims.sql` adds three tables that keep
the claim and the check side by side. All three are append-only, enforced by
triggers that abort any UPDATE or DELETE, because a record that can be rewritten
after the fact is not evidence.

`job_claims` is what the agent said: one row per `complete`, `fail` or `block` call
that reached the transition, so a job blocked three times and then completed has
four. It is captured before any verification runs, in the same batch as the
transition. A call refused before the transition writes none, and neither does a
seat's `fail` of another credential's job, since that agent made no claim.

| column | what it is |
| --- | --- |
| `action`, `agent`, `namespace` | the call, the caller, and the job's namespace at the time |
| `raw` | the claim-bearing arguments exactly as sent: `evidence`, `claim`, `result_summary` or `reason`, `result_ref`, `command` |
| `prs_opened_urls`, `prs_merged_urls`, `prs_opened`, `prs_merged` | the pull requests the agent says it opened and says are merged, as JSON arrays and their lengths |
| `commits`, `files_changed`, `tests_added` | the driver's own counts from `evidence`, never GitHub's |
| `tests_run`, `tests_passed`, `tests_failed`, `tests_result` | the tests the agent says it ran, and their result |
| `deploy_state` | what the agent says about deployment |
| `files_touched` | a JSON array of the paths the agent says it touched |
| `model_id`, `client_name`, `client_version`, `permission_mode` | self-reported, recorded and never used to authorize anything |
| `raw` `claim.usage` | self-reported cost, active seconds and tokens for the session, kept in `raw` with no column of its own and summed per namespace by the `claims` aggregate beside the telemetry on `job_outcomes`; never used to authorize anything |
| `capsid_sha` | the Worker's own deployed commit, not the agent's word |

`job_evaluations` holds one row per check, named for OpenTelemetry's
`gen_ai.evaluation.result` event: `name`, `score_value`, `score_label` (`pass`,
`fail` or `unknown`) and `explanation`. `claimed` and `verified` sit side by side as
JSON, and `agreement` is computed once when the row is written: `agree`,
`disagree`, `unclaimed` (the agent said nothing) or `unchecked` (no verified
value). `evaluator` is `worker`, `model` or `human`, and `evaluator_id` names which
one, `capsid@<sha>` for this Worker. The Worker writes `pr_merged`, `prs_opened`,
`commits`, `files_changed` and `ci_green` at `complete` and `fail`; `hidden_tests`
and `scope_respected` are reserved for later evaluators.

`job_touches` is the human-touch log: every gate, resume, approval, correction,
note, release, supersede, seat fail and acted-on review, with the actor, an
`actor_kind` (`human`, `seat`, `driver`, `policy`, `reviewer` or `system`) and, for
a touch that ends a wait, `waited_ms` since the job's latest gate. Without it, human
effort confounds any comparison of agents: a job that needed four rescues and one
that needed none both end merged.

The same rule as `job_outcomes` holds, more strictly: a field the agent did not
state is `NULL`, never `0` and never false. "Nobody said" and "said none" are
different facts. Times are ISO 8601 with milliseconds, because a wait is a
difference of two times.

### A swallowed parameter tag is refused

`complete`, `fail` and `post` refuse a `result_summary`, `reason` or `body` that
contains the literal text `</name>` for one of the `jobs` tool's own parameter
names, and the refusal names both the field and the tag.

This is a measured failure, twice on 2026-09-11, not a hypothetical. A caller that
closes a parameter tag inside a value sends one argument where it meant to send
three: `result_ref` and `evidence` never arrive as arguments at all, they arrive as
literal text in the middle of `result_summary`. Both times the job was completed
with no reference and no evidence, and the outcome row recorded nothing.

It is refused rather than cleaned up because what was lost is the structure, not the
text: stripping the tags would leave a tidy summary still missing its `result_ref`
and its `evidence`, and the caller would never learn. The outcome row cannot be
corrected afterwards by design, so before the write is the only place to catch it.

The match is the full `</name>` spelling and nothing looser, so prose about the rule
is not refused: a job body that writes the pieces apart, as this feature's own job
body did, passes. `test/jobs.test.ts` checks both directions, against the actual
stored text of the first job it happened to.

### agent_record

`src/agent-record.ts` aggregates those rows into one record per credential, served
in `improve_status`'s `agents` and rendered in Capsid Portal: jobs done, failed and
blocked, gates hit, resumes, pull requests opened and merged, a merge rate, a CI
green rate with `ci_checked` as its stated denominator, a median duration, and for
drivers the loop's kept and reverted counts.

Three rules. Counts and rates, never a composite score: a
score needs a weighting, a weighting is an opinion, and the moment one number
stands for all of them somebody gates on it. Only a verified field feeds a rate,
since a rate built partly from what a credential reported about itself is that
credential scoring its own work. A rate with no denominator is `null`, because
reporting `0%` for an agent that has opened no pull requests puts it below one that
opened ten and merged one.

`jobs.post` can require a record with `min_record` (`{prs_merged: n}`), checked at
the claim against this same function, so the bar a claim is measured against is the
number a human can read on the page.

## Roles, and what each one cannot do

Ruled 2026-09-12. Roles are few and separated, and a role is one capability rather
than a bundle. `scripts/mint-agents.mjs` holds them and a test fails the build if any
role names a second blast-radius flag. A role that accumulates flags is still a driver.

A reviewer never writes code. Commenting on a pull request goes through
`manage_pr`, which is a write tool, so the reviewer needs the write grant. `can_comment_pr`
is what stops that grant also being merge and close. It is the smallest write this
Worker makes, kept separate from the largest.

The tools axis can name an action. `jobs` is one tool with a read action and seven
write ones, and "may post a job" and "may claim, complete and resume one" are different
authorities the tool name cannot separate. So an entry may be qualified, `jobs.post`,
and the rule is stated once in `allowsToolAction`:

- `*` allows everything, so every agent minted before this is untouched.
- A list naming at least one action of this tool is narrowed to the actions it names.
- A bare tool name with no qualified sibling still means the whole tool. Narrowing is
  opted into, never inherited.
- A qualified entry narrows only its own tool.

The two tools whose action decides what they do, `jobs` and `lint`, pass the action to
`checkScope` where it is known. That is the same shape the grant check already used and
not a second enforcement point.

## Two corrections, then a human

`resume` made a gate a pause rather than an ending (migrations/0007), and left the loop
unbounded: block, sent back, block again, sent back again, block again. Every step is
defensible on its own. The ceiling is counted at each one.

`jobs.corrections_count` (migrations/0016) is that ceiling's budget. It is
a third counter beside `blocked_count` and `resumed_count`, which are history and are
never reset: those answer "how many gates has this job hit" and "how many times has it
come back". Deriving the budget from them would tie the cap to gates the job passed
legitimately.

- `resume` spends one. At `CORRECTION_CAP` (2) a further resume is refused for a driver
  and for the seat, because the seat is a machine and the cap exists to put a person
  at the boundary.
- An admin resume passes and does not spend the budget. The human arriving
  lifts the cap.
- `block` writes `retry cap; human decision required` into `result_summary`, above
  whatever the driver said rather than instead of it: the person now deciding needs to
  read what the driver was trying to do.
- `atCorrectionCap` fails closed. A count that is not a finite number at or above
  zero is treated as at the cap, because a budget that cannot be read is one that cannot
  be bounded.

## The review gate

`jobs.review_required` (migrations/0017) says a job's work needs a second reader before
it reaches the seat. A gate on the row, checked by the Worker. The alternative is a
driver remembering to wait, which is the party being reviewed deciding whether it is
reviewed.

A review is a comment whose body starts with `REVIEW:` and ends with `APPROVE`,
`CHANGES` or `BLOCK`. An `APPROVE` must also quote the pull request's head sha it
reviewed, full or as a prefix of at least 7 hex characters, for example
`REVIEW: checked abc1234, the scope check is right. APPROVE`. It is not a GitHub review approval: the reviewer agent holds
`can_comment_pr` and nothing else, so a comment is the only mark it can leave.

The envelope is strict at both ends and `src/review.ts` states why. A comment that opens
with `REVIEW:` and trails off is a reviewer who did not finish, and inventing a verdict
there is the one thing this parser must never do. A comment ending in `APPROVE` without
the prefix is ordinary prose that happens to end in a word.

The newest review wins, ordered by timestamp rather than by the order GitHub
returned, because a reviewer that said `CHANGES`, watched the driver fix it and then
said `APPROVE` has changed its mind.

| verdict | what happens |
| --- | --- |
| none yet | the job stays claimed and its lease keeps running |
| `APPROVE` | the hand-off proceeds exactly as it would with no reviewer |
| `CHANGES` | back to the driver, and it spends a correction from the budget above |
| `BLOCK` | blocked for the seat, with the objection as the reason |

Both `complete` and `block` consult it. A gate on one of them is not a gate: the driver
would use the other and the bypass would look like ordinary use. A job with no
`review_required`, or one whose `result_ref` is not a pull request, proceeds untouched.
An unreadable GitHub holds the job rather than waving it through, since an unreadable
comment list is not evidence that anybody read the code.

The gate is bound to the job's own pull request and head. The first pull request it
reads is recorded in the claimed job's `result_ref`, and a later call naming a
different one is refused. The URL's repo is resolved through the namespace mapping,
and a repo the namespace does not map is refused without reading it. An `APPROVE`
counts only when the sha it quotes is the pull request's head at the time the gate
reads it, so a push after the approval needs a fresh review. The sha is used rather
than the head commit's committer date because whoever commits sets that date. A
`CHANGES` or `BLOCK` needs no sha and counts whichever head it was written against.

## Skill records

A skill is an idea abstracted from work that landed, written down so another project
can act on it. `improve_skills` has held one row per skill since the first improve
migration; migrations 0012 and 0013 gave those rows a lifecycle and the evidence to
move through it.

The rule: a skill's status changes on VERIFIED evidence, never on a driver's judgement
of its own run. A driver reporting that a skill helped is the party being measured
reporting the measurement. Verified means the Worker read the signal from GitHub
itself: a pull request merged and CI green, as stored on `job_outcomes`, and a scored
improve attempt when the loop runs.

AMENDED 2026-09-16 (option C). The 2026-09-12 rule said evaluations were the only
evidence. They were also the only evidence that never existed: the fortnightly probe
that was meant to produce them dispatched a scorer workflow body GitHub refuses, so no
`skill_evaluations` row was ever written and no status could ever move. Scheduled
probing is dropped, and verified job outcomes take its place. Everything below about
how evidence is counted is unchanged; what changed is where it comes from.

Three states. Every skill starts `candidate`, including one abstracted from an
attempt that was kept: being born of a success is not evidence that the written form
of the idea helps anybody else, which is the only thing an evaluation measures. A
candidate promotes to `live` on two positive evaluations. A live skill goes `retired`
on two consecutive non-positive ones. Retired rows are kept with their whole record,
both because a retirement is evidence about what does not work and because the
creating path checks them, so the same idea is not abstracted again from the same
source next month.

Two evaluations minimum, in both directions. One result is a sample. A system that
promoted on one would spend its life promoting and retiring the same skill on noise.
Promotion and retirement have different shapes: promotion asks for a
pattern of helping, retirement asks for a run of not helping, so a live skill that
alternates positive and neutral is doing something and stays.

Evidence is counted per version and per probe set. An evaluation of version 2 says
nothing about version 3, and a delta measured against a different probe set is not
comparable to one measured against this one. So an accepted edit costs a skill every
evaluation it had accumulated, which is what makes the edit bound matter.

Edits are bounded at 20 percent of the instruction lines, counted by distinct
lines touched, and accepted only on strict improvement. A tie is a rejection: an edit
that changes nothing measurable still resets the evidence. Rejected edits are stored
in `skill_edits` and handed to the next optimizer run, so a proposal that was already
refused is not proposed again.

Attribution separates three things a single counter conflated. A skill moves only
when it was used and the verifier reported on the work itself. A skill that was
offered and ignored while the run succeeded anyway counts as nothing, because the
success is not its. A run that died on the environment counts as nothing either,
because charging a loss for a failed checkout would retire skills for being present
during an outage.

Offered and used are both stored, on `job_outcomes`. The gap between them is its
own measurement: a skill offered fifty times and used twice is not a failing skill.
It is a trigger condition that does not describe the work it is matched to, and those
are different problems with different fixes.

Failure notes are not a second score. `skill_failures` carries a note per reverted
attempt and failed job, linked to the skills in use at the time, and the recommend
step attaches the two most recent for each skill it offers. Nothing there moves a
status; it exists so the next driver reads the failure rather than repeating it.

## Why documents carry provenance

Reads return `last_actor`: the actor from the most recent audit entry for that
document. A document is data, and a document another client wrote is untrusted
input. The stamp is on the response envelope rather than in the body, because the
body is exactly what an attacker controls.

## Capsid Portal's reads

Capsid Portal (`/portal/`, docs/portal.md) reads the store through the same
functions the tools call, so the two cannot disagree. `GET /portal/api/ops` is the
feed, `OpsFeed` in `src/ops-types.ts`. `GET /portal/api/namespaces` returns each
roster namespace from `improveStatus()`, the function behind `improve_status`.
`GET /portal/api/activity?namespace=&actor=` returns the last 50 `audit_log` rows,
filtered, with ISO times. `GET /portal/api/stale` returns the stale jobs from
`staleJobs()`, the function behind `jobs` list with `stale: true`. All four are admin
session only.

**A click in the Portal writes two audit rows:** the shared mutator's own row (for
example `improve-paused` by `improve-loop`, or `job-resumed`), then the click's row,
`portal-<action>` under `access:<email>`. The five automation switches (`pause`,
`unpause`, `mode`, `seat_start`, `overnight`) record the reason in that row, and an Undo from the
Portal's result message writes `portal-undo-<action>` instead, with `"undo": true`
in its params. The Portal's on-demand watcher pass is
`portal-ops-refresh`. Rows written before the Portal moved from `/console` to
`/portal` name the click `console-<action>` and the refresh `console-ops-refresh`,
and rows from before the Access login name the admin `github:<login>`, so a query
for the admin's clicks across both dates matches both prefixes:

```sql
SELECT at, actor, action, namespace FROM audit_log
WHERE action LIKE 'portal-%' OR action LIKE 'console-%'
ORDER BY id DESC LIMIT 50;
```

**Reads of the rules are audited.** A `read` of `capsid/conventions.md`, or a `brief` (which
carries it), writes one `conventions-read` row under the caller's actor, at most one per
caller per hour (`src/conventions-read.ts`, `test-integration/conventions-read.test.ts`).
The row is in namespace `capsid` with no path, because a row addressed to the document
would make the reader its `last_actor`. `params` are `{"via": "read" | "brief",
"for_namespace": ...}`. Per caller over the last week:

```sql
SELECT actor, COUNT(*) AS hours_with_a_read FROM audit_log
WHERE action = 'conventions-read' AND at >= datetime('now', '-7 days')
GROUP BY actor ORDER BY hours_with_a_read DESC;
```

**The site configuration** is the table `ops_sites`, one row per namespace
(docs/portal.md, "Sites are configuration"). Its edits are audited as
`ops-site-added`, `ops-site-edited` and `ops-site-removed` under `access:<email>`,
each carrying the row before and after as `params`, then the click row
`portal-site_add`, `portal-site_edit` or `portal-site_remove`. A removed row survives
only in that audit row and the nightly dump.

`attempts_kept` and `attempts_reverted` on an agent are `null` for every kind
except `driver`, because an attempt belongs to a namespace's runs and crediting a
seat with them would attribute one credential's work to another.

`record` is the agent record. It is a different measurement from the counts
beside it. The flat `prs_opened` and `prs_merged` count what this credential did
through this Worker, from `audit_log`. The record's counts come from
`job_outcomes`, and its rates come only from the fields the Worker checked against
GitHub itself, which is why a driver can show pull requests in one and a `null`
rate in the other: it opened them without naming them as evidence on a job. A rate
with no denominator is `null` rather than `0`, because `0%` would sort a credential
that has done nothing below one that has done something imperfectly.
