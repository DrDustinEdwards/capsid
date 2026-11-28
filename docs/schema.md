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

| type                       | what it is                                                    |
| -------------------------- | ------------------------------------------------------------- |
| `core`                     | one always-loaded summary per namespace, read first to orient |
| `concept`                  | a compiled wiki topic, one subject per document               |
| `decision`                 | a ruling and the measurement that forced it                   |
| `spec`                     | a design a piece of work is built to                          |
| `protocol`                 | a tested procedure                                            |
| `procedural`               | rules for working in a namespace                              |
| `task`                     | an open piece of work                                         |
| `reference`                | pointers outward: URLs, dashboards, lookup tables             |
| `semantic`, `note`, `post` | compiled knowledge and content                                |
| `episodic`                 | a session record: raw material for the consolidation loop     |
| `source`                   | raw, un-compiled input, an inbox                              |
| `prompt`                   | a reusable template, with `{{variable}}` placeholders         |

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

## Canon and rulings are protected from agent keys

Canon is what every agent is told to trust: `capsid/conventions.md` and `capsid/conventions-<name>.md`, every namespace's `core.md`, and every namespace's `decisions.md`. `CANON_RULES` in `src/canon.ts` is the list, checked by `test/canon.test.ts`. Dustin's rulings (`capsid/rulings/<name>.md`) are guarded the same way but are records, not canon: no session is served them as rules (Dustin, 2026-11-18). Both are served by `capsid_read_status` action `status` as `canon_paths`. Ruled by Dustin on 2026-10-03 (D3 of the OWASP hardening, job_9e602b31888f); the portfolio-wide key lost its exemption on 2026-11-18 (security review round 4, finding 3).

- **Only the admin and the seat (`can_merge`) change canon or a ruling.** For them a write, restore, move or delete is an ordinary one: snapshotted and audit-logged.
- **Every other agent key is refused**, the portfolio-wide one (namespaces `*`, the key unattended routine sessions use) included: every write, restore, move and delete, and a move onto a guarded path, with nothing changed.

## Rule documents are held to their cap and to served tool names

A rule document is one sessions follow as rules rather than read as a record: every namespace's `core.md` (cap 8 KB), `decisions.md`, and in capsid `conventions*.md` (cap 20 KB). Dated records (`archive/`, `research/`, `reports/`, `audits/`, `jobs/`, and Dustin's rulings under `rulings/`) are not. `ruleDocCap` in `src/rule-docs.ts` is the list.

- **A write may not make a rule document worse.** `capsid_write_doc` (write, restore, and a move onto a rule path) refuses a body over the cap that is larger than the stored one, or one naming a tool or action the Worker does not serve that the stored body did not name. A cut that leaves a document still over its cap passes, so an over-cap document can be fixed in steps. A move from one rule path to another and a restore that recreates a deleted document put back what was held, and pass. Checked before the canon branch, so a proposal that could never be applied is refused too.
- **A stale name** is an old tool name (the MCP 4 regroup's mapping, `scripts/tool-names-lib.ts`) in a backtick span, a call or, for a name with an underscore, anywhere outside backticks; or a `capsid_*` name that is not in `TOOL_GRANTS`, or one given an action its tool does not take.
- **The lint report and the daily maintenance pass list what is already wrong**: the report's `rule_doc_caps` and `stale_tool_names` checks over its namespace, and the pass's `rule-doc` rule over every namespace.

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
the `namespaces` row. An edge that was already dangling (its end in the namespace
names no document) touches nothing deleted and stays. One audit row, action
`namespace-delete`, holds the counts, the deleted paths, the removed edges, and
the `ops_sites` and `namespaces` rows whole.

The whole delete is one D1 batch, and D1 caps a batch at 100 statements: five fixed
ones plus two per document. So a namespace with more than 47 live documents is
refused at preview and at perform, never half deleted. Delete or move documents
with the `capsid_delete_doc` tool first, or ask the seat to rule a set-based helper.

What it keeps, because it is history: archived documents and the edges between
them, `document_versions`, `audit_log`, the retired job tables, revoked agents and the
nightly backups. The kept archived documents
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

## Retired job tables

The job queue was retired on 2026-11-28 with no migration: its tables stay, and nothing
reads or writes them except the nightly backup, which still dumps them. They are `jobs`
(migrations/0006), `job_outcomes` (0011), `job_outcome_prs` (0015), `job_claims`,
`job_evaluations` and `job_touches` (0023, `job_touches` rebuilt by 0031), `job_versions`
(0033), and the capsid-bench tables `bench_tasks` and `bench_runs` (0047) and
`bench_registration` and `bench_draw` (0049). The columns `watcher_findings.job_id` (0024)
and `agents.jobs` (0066) are no longer written. Dropping any of them is a migration of its
own.

## Roles, and what each one cannot do

Ruled 2026-09-12. Roles are few and separated, and a role is one capability rather
than a bundle. `scripts/roles.ts` holds them and a test fails the build if any
role names a second blast-radius flag. A role that accumulates flags is still a driver.

The tools axis can name an action, because one tool can hold authorities its name cannot
separate. So an entry may be qualified, `capsid_close_pr.delete_branch`, and the rule is
stated once in `allowsToolAction`:

- `*` allows everything, so every agent minted before this is untouched.
- A list naming at least one action of this tool is narrowed to the actions it names.
- A bare tool name with no qualified sibling still means the whole tool. Narrowing is
  opted into, never inherited.
- A qualified entry narrows only its own tool.

Every tool whose action decides what it does (`capsid_lint_namespace`
and every composite tool) passes the action to `checkScope` where it is known. That is the same shape the grant check already used and
not a second enforcement point.

## Skill records

No skill table is live: `migrations/0048_drop_improve_loop.sql` dropped them with the
improve loop's own tables, and older nightly dumps still hold their rows. `improve_jti`
stays as the replay table for the backup credential. Skills as
`SKILL.md` guidance in each repo are separate.

## Why documents carry provenance

Reads return `last_actor`: the actor from the most recent audit entry for that
document. A document is data, and a document another client wrote is untrusted
input. The stamp is on the response envelope rather than in the body, because the
body is exactly what an attacker controls.

## Capsid Portal's reads

Capsid Portal (`/portal/`, docs/portal.md) reads the store through the same
functions the tools call, so the two cannot disagree. `GET /portal/api/ops` is the
feed, `OpsFeed` in `src/ops-types/feed.ts`. `GET /portal/api/namespaces` returns each
roster namespace from `capsidStatus()` (`src/status.ts`), the function behind `capsid_read_status` action `status`.
`GET /portal/api/activity?namespace=&actor=` returns the last 50 `audit_log` rows,
filtered, with ISO times. All three are admin
session only.

**A click in the Portal writes two audit rows:** the shared mutator's own row (for
example `agent-revoked`), then the click's row,
`portal-<action>` under `access:<email>`. Rows from before 2026-11-28 also hold
`portal-undo-<action>`, an Undo of a switch. The Portal's on-demand watcher pass is
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
"for_namespace": ..., "thread": ...}`; `thread` is present only when `capsid_start_session` was
given its optional `thread` name, and then the limit is one row per caller per thread per hour,
because every project thread acts as one login. Per caller over the last week:

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
`access:<email>`) with the tool and the site's verdict, never the token, and each backup
from Capsid Admin's backups as `site-backup` (docs/portal.md, "Site backups").
