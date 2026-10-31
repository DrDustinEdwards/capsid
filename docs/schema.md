# The knowledge model

Capsid stores documents. This describes how they are organized and what the rules
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
  rejected rather than guessed at. The `namespaces` table maps each namespace to a
  labeled list of repositories. `capsid_admin_manage_namespaces` action `register`
  (admin only) adds one row and refuses a namespace that exists.
- **Path** is a flat filename inside a namespace, like `core.md`. Structure
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

## Store design choices and why

Ruled 2026-08-13 to 2026-08-17. The type and status vocabulary is enforced on write in src/doc-meta.ts, so a new word needs no migration. A version row stores title and body only; metadata changes go in audit_log as prior_meta. if_match compares the stored body inside the write batch, with no hash column, because a stored hash is a mirror that drifts. An overwrite within the hour without if_match warns, never refuses. No cross-namespace move: a namespace is an ownership boundary, not a folder. CI logs are withheld from read-only keys, because logs carry whatever a step printed. Decision documents are exempt from the count lint: a dated log is history.

## Canon is protected from namespace keys

Canon is what every agent is told to trust: `capsid/conventions.md` and `capsid/conventions-<name>.md`, every namespace's `core.md`, and every namespace's `decisions.md` with its archived volumes. `CANON_RULES` in `src/canon.ts` is the list, checked by `test/canon.test.ts` and served by `capsid_run_improve` action `status` as `canon_paths`. Ruled by Dustin on 2026-10-03 (D3 of the OWASP hardening, job_9e602b31888f).

- **Only the admin, the seat (`can_merge`) and a portfolio-wide key (namespaces `*`, the key Dustin's cloud sessions use) change canon.** For them a canon write, restore, move or delete is an ordinary one: snapshotted and audit-logged.
- **A key scoped to some namespaces (a site driver, a cron) is refused** every write, restore, move and delete of canon, and a move onto a canon path, with nothing changed.
- Until 2026-10-31 such a key's write became a proposal in `canon_proposals` (migration 0034) for the admin to approve. Nobody approved them any more and Dustin's own sessions were held there too, so he had the queue deleted. The table and its decided rows stay, in backups, until a migration drops it.

## Rule documents are held to their cap and to served tool names

A rule document is one sessions follow as rules rather than read as a record: every namespace's `core.md` (cap 8 KB), `decisions.md`, and in capsid `conventions*.md` and each document directly under `rulings/` (cap 20 KB). Dated records (`archive/`, `research/`, `reports/`, `audits/`, `jobs/`) are not. `ruleDocCap` in `src/rule-docs.ts` is the list (job_c13dc0d4f22f).

- **A write may not make a rule document worse.** `capsid_write_doc` (write, restore, and a move onto a rule path) refuses a body over the cap that is larger than the stored one, or one naming a tool or action the Worker does not serve that the stored body did not name. A cut that leaves a document still over its cap passes, so an over-cap document can be fixed in steps. A move from one rule path to another and a restore that recreates a deleted document put back what was held, and pass. Checked before the canon branch, so a proposal that could never be applied is refused too.
- **A stale name** is an old tool name (the MCP 4 regroup's mapping, `scripts/tool-names-lib.ts`) in a backtick span, a call or, for a name with an underscore, anywhere outside backticks; or a `capsid_*` name that is not in `TOOL_GRANTS`, or one given an action its tool does not take.
- **The lint report and the daily maintenance pass list what is already wrong**: the report's `rule_doc_caps` and `stale_tool_names` checks over its namespace, and the pass's `rule-doc` rule over every namespace (docs/work-queue.md).

test/rule-docs.test.ts plants both kinds, through the write tool too; test-integration/maintenance.test.ts sees the pass list them from a real D1.

## Deleting a namespace

Deleting a namespace is `capsid_admin_manage_namespaces`, admin only, in two calls. `action: "delete_preview"` writes
nothing. It counts everything that names the namespace and returns a verdict, and
when nothing refuses, a token bound to the namespace, `cascade`,
`allow_improve_paths`, those counts and the caller, valid for five minutes.
`action: "delete_perform"` takes the same arguments and the token, reads the counts again,
and refuses if any of them moved. Then it commits one batch whose first statement
aborts it unless the store still matches the plan.

It refuses, whatever `cascade` says:

- while any job in the namespace is queued, claimed or blocked. End each with the
  `capsid_work_jobs` tool (`supersede` for a queued job, `fail` for a claimed or blocked one).
- while any live agent names the namespace in its scopes. Use the `capsid_admin_manage_agents` tool
  (`revoke`, or `update_scopes` to drop the namespace).
- while the namespace is on the roster (`ROSTER` in `src/roster.ts`), which is a list in code.

It also refuses while live documents exist and `cascade` is not true, and while the
namespace holds signed policy documents (under `policy/`, counted as
`policy_documents` and listed as `policy_paths`) and `allow_improve_paths` is not
true. `allow_improve_paths` needs the `can_touch_protected` flag, as it does on a
document delete. Despite its name, it covers only the signed policy documents.

What the batch deletes: every live document (every path outside `archive/`), each
snapshotted to `document_versions` first and then removed by the same path helper a
document delete uses, which takes every edge touching it too; the `ops_sites` row;
the `access_sync_groups` pin; the `namespaces` row. An edge that was already dangling (its end in the namespace
names no document) touches nothing deleted and stays. One audit row, action
`namespace-delete`, holds the counts, the deleted paths, the removed edges, and
the `ops_sites`, `access_sync_groups` and `namespaces` rows whole.

The whole delete is one D1 batch, and D1 caps a batch at 100 statements: six fixed
ones plus two per document. So a namespace with more than 47 live documents is
refused at preview and at perform, never half deleted. Delete or move documents
with the `capsid_delete_doc` tool first, or ask the seat to rule a set-based helper.

What it keeps, because it is history: archived documents and the edges between
them, `document_versions`, `audit_log`, finished jobs, `job_outcomes`,
`job_claims`, `job_touches`, revoked agents and the nightly backups. The kept archived documents
still carry the deleted name. `capsid_read_doc`, `capsid_find_docs` and
`capsid_start_session` return them under it. `capsid_write_doc` and `capsid_delete_doc` refuse there until
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
   archived, and `capsid/conventions.md` as the rules. It reports its size as
   `packet_chars`, and it is size-bounded, and when it trims it
   stubs whole documents rather than truncating bodies. A truncated markdown
   document hides that the reader is holding a fragment.
2. The driving client compiles: dedupes, resolves contradictions, refreshes
   cross-references, and writes the results with the ordinary write tool.
3. **finalize** archives the consumed documents by moving them under `archive/`,
   in one batch, with one audit row. It refuses any document that is not an
   episodic or source document. Archive only, never delete. gather
   excludes `archive/`, which is what makes the loop idempotent.

### report

A third mode measures the store instead of compiling it, and writes what it found
to `<namespace>/reports/lint-<date>.md`. Eight checks: contradictions (prose
asserting a number the artifact disagrees with), stale decisions, unbound specs,
broken links, unconsolidated documents, doc-vs-code drift, where a repository
path named in the canon is no longer in the repository, and the two rule document
checks, a rule document over its cap and one naming a tool the Worker does not serve. Documents by type is
counted and reported beside the checks rather than being one of them.

It produces one integrity percentage: subjects in good standing over subjects
judged. A check that could not run is excluded from the number rather than counted
as clean, and says so. An empty store scores null, not 100.

A number in a tool response is a number one session saw. A number in a dated
document is a series.

## Beyond tools

- **Resources.** Every document is addressable at `capsid://<namespace>/<path>`,
  listed by `resources/list`. Read-only, with the read tool's visibility.
- **Prompts.** Every `prompt` document appears in the prompt list as
  `<namespace>/<path without .md>`, described by its title, with its
  `{{variable}}` placeholders as required arguments. A missing argument is an error. `prompts/get` substitutes
  them and returns the body as an embedded resource, not as user text. A
  document body is writable by any session holding a write grant. Returning it as
  plain user text hands whoever last wrote that row a message the client's model
  reads as its own operator speaking.

## Jobs as evidence

A finished job writes one row to `job_outcomes` (`migrations/0011_job_outcomes.sql`),
so the queue produces verified evidence of how a job went. Before it,
the only record of how a job went was `result_summary`: prose, written by the party
being measured.

One row per job, keyed by `job_id`, written by `complete` and by `fail` alike.

A superseded job writes none. `supersede` closes a job the seat replaced before any
work was done on it, so there is nothing to record against a driver. The jobs that
`migrations/0020_jobs_superseded.sql` relabelled from failed to superseded had
already written a row when they were failed; those rows are kept, and every read
that builds a record or a count from `job_outcomes` leaves out a row whose job is
superseded (`src/agent-record.ts` and the
pull request re-verification in `src/outcome-prs.ts`).

| column | what it is |
| --- | --- |
| `agent`, `namespace` | who did the work and where, copied from `jobs.claimed_by` at the moment the job ended rather than joined, since a later release clears that column |
| `prs_opened`, `prs_merged` | GitHub's answer whenever the driver named any pull request |
| `commits`, `files_changed` | the pull requests' own counts when there are any, the driver's otherwise |
| `tests_added` | the driver's claim, never verifiable here: "a test was added" is a judgment about a diff, not a property of it |
| `ci_green` | `1`, `0`, or `NULL` for not checked. A run still going is `NULL`, because "CI has not answered" is not "CI failed" |
| `blocked_count`, `resumed_count` | how many gates the job hit and how many times a human sent it back, the two numbers the Worker knows first-hand |
| `duration_minutes` | claimed to recorded. The final working stretch: `resume` does not restart the clock from the first claim, so time spent blocked waiting on a human is excluded |
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
| `raw` `claim.usage` | self-reported cost, active seconds and tokens for the session, kept in `raw` with no column of its own and summed per namespace by the `capsid_admin_read_claims` aggregate beside the telemetry on `job_outcomes`; never used to authorize anything |
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
contains the literal text `</name>` for one of the `capsid_work_jobs` tool's own parameter
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
in `capsid_run_improve` action `status`'s `agents` and rendered in Capsid Portal: jobs done, failed and
blocked, gates hit, resumes, pull requests opened and merged, a merge rate, a CI
green rate with `ci_checked` as its stated denominator, and a median duration.

Three rules. Counts and rates, never a composite score: a
score needs a weighting, a weighting is an opinion, and the moment one number
stands for all of them somebody gates on it. Only a verified field feeds a rate,
since a rate built partly from what a credential reported about itself is that
credential scoring its own work. A rate with no denominator is `null`, because
reporting `0%` for an agent that has opened no pull requests puts it below one that
opened ten and merged one.

`capsid_work_jobs.post` can require a record with `min_record` (`{prs_merged: n}`), checked at
the claim against this same function, so the bar a claim is measured against is the
number a human can read on the page.

## Roles, and what each one cannot do

Ruled 2026-09-12. Roles are few and separated, and a role is one capability rather
than a bundle. `scripts/mint-agents.ts` holds them and a test fails the build if any
role names a second blast-radius flag. A role that accumulates flags is still a driver.

The tools axis can name an action. `capsid_work_jobs` is one tool with a read action and
several write ones, and "may post a job" and "may claim, complete and resume one" are different
authorities the tool name cannot separate. So an entry may be qualified, `capsid_work_jobs.post`,
and the rule is stated once in `allowsToolAction`:

- `*` allows everything, so every agent minted before this is untouched.
- A list naming at least one action of this tool is narrowed to the actions it names.
- A bare tool name with no qualified sibling still means the whole tool. Narrowing is
  opted into, never inherited.
- A qualified entry narrows only its own tool.

Every tool whose action decides what it does (`capsid_work_jobs`, `capsid_lint_namespace`
and every composite tool) passes the action to `checkScope` where it is known. That is the same shape the grant check already used and
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

Removed 2026-10-31 with `capsid_open_pr`, whose `comment` action was the only way a
verdict could be posted. `jobs.review_required` (migrations/0017) stays as a column:
new jobs store 0, and no transition reads it.

## Skill records

No skill table is live: `migrations/0048_drop_improve_loop.sql` dropped them with the
improve loop's own tables, and older nightly dumps still hold their rows. `improve_jti`
stays as the replay table for the bench and the backup credential, and the
`skill_ids_offered` and `skill_ids_used` columns on `job_outcomes` stay unused. Skills as
`SKILL.md` guidance in each repo are separate: the weekly skills refresh
(`src/skills-refresh.ts`) posts a job in `claude-skills` when a model's prompting guide
has moved.

## Why documents carry provenance

Reads return `last_actor`: the actor from the most recent audit entry for that
document. A document is data, and a document another client wrote is untrusted
input. The stamp is on the response envelope rather than in the body, because the
body is exactly what an attacker controls.

## Capsid Portal's reads

Capsid Portal (`/portal/`, docs/portal.md) reads the store through the same
functions the tools call, so the two cannot disagree. `GET /portal/api/ops` is the
feed, `OpsFeed` in `src/ops-types/feed.ts`. `GET /portal/api/namespaces` returns each
roster namespace from `capsidStatus()` (`src/status.ts`), the function behind `capsid_run_improve` action `status`.
`GET /portal/api/activity?namespace=&actor=` returns the last 50 `audit_log` rows,
filtered, with ISO times. `GET /portal/api/stale` returns the stale jobs from
`staleJobs()`, the function behind `capsid_work_jobs` action `list` with `stale: true`. All four are admin
session only.

**A click in the Portal writes two audit rows:** the shared mutator's own row (for
example `overnight-set` or `job-resumed`), then the click's row,
`portal-<action>` under `access:<email>`. The automation switch (`overnight`) records
the reason in that row, and an Undo from the
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

**Reads of the rules are audited.** A `capsid_read_doc` read of `capsid/conventions.md`, or a
`capsid_start_session` (which carries it), writes one `conventions-read` row under the caller's actor, at most one per
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
only in that audit row and the nightly dump. Its `operator` column (migrations/0035) is
a site's opt-in to Capsid calling its operator API (docs/portal.md, "Site repairs");
each call is audited as `site-repair` under the caller (`agent:watcher` or
`access:<email>`) with the tool and the site's verdict, never the token.

`record` is the agent record. It is a different measurement from the counts
beside it. The flat `prs_opened` and `prs_merged` count what this credential did
through this Worker, from `audit_log`. The record's counts come from
`job_outcomes`, and its rates come only from the fields the Worker checked against
GitHub itself, which is why a driver can show pull requests in one and a `null`
rate in the other: it opened them without naming them as evidence on a job. A rate
with no denominator is `null` rather than `0`, because `0%` would sort a credential
that has done nothing below one that has done something imperfectly.
