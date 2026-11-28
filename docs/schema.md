# The knowledge model

Capsid stores documents. This describes how they are organized and the rules around them. It is redacted from the private canon: Capsid documents itself in itself, and where the two disagree the private document is right.

## Documents

A document is a row: namespace, path, title, body, type, status, tags, `created_at`, `updated_at`.

- **Namespace** is a project, one per repository, and the authorization boundary for repository access: the `namespaces` table maps each namespace to a labeled list of repositories, and that mapping decides which repository a tool call can reach. An unmapped selector is rejected, not guessed. `capsid_admin_manage_namespaces` action `register` (admin only) adds one row and refuses a namespace that exists.
- **Path** is a flat filename inside a namespace, like `core.md`. Structure lives in the path and the type, never in nested namespaces. Consolidated raw material moves under `archive/` and stays there.
- **Body** is Markdown. FTS5 indexes title and body, kept in step by triggers on the documents table, so search is a property of the write.

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

The write path validates the type (`src/doc-meta.ts`, so a new word needs no migration): a document with an invented type is invisible to every query that names the real ones.

### Statuses

`draft`, `ready`, `active`, `published`, `superseded`, `closed`. `published` is the default. Status records editorial state and never decides what the consolidation loop can see; only the `archive/` prefix does. When the loop filtered on `status = 'published'`, documents written as `active` were invisible to the backlog count and the archiving step.

## Links

Documents carry typed outgoing edges: `governs`, `references`, `supersedes`, `replaces`, `depends-on`. An edge names a namespace and a path on both ends, so it can cross namespaces. Edges move with the document through the one path helper, so a rename does not orphan them. An edge whose endpoint no longer exists is reported, never auto-repaired: whether to repoint or drop it is not the Worker's call.

## The write path

Four invariants, each enforced in code:

1. **Every overwrite and delete snapshots the prior row** into `document_versions` and appends to `audit_log`. A version row stores title and body only; metadata changes go in the audit row as `prior_meta`. Snapshots are kept by age.
2. **A path mutation goes through one helper**, and a mutating batch carries its own existence predicate, so a zero-row move or delete aborts. D1 row counts cannot be used for this: the FTS triggers inflate them.
3. **Writes normalize wide dashes to ASCII server-side**, for the text the caller supplies only: an append or a patch leaves the stored text around it as it was. Document writes only; repository writes pass content verbatim.
4. **An optional `if_match` is enforced at commit time**, inside the mutation batch, against the body itself rather than a stored hash (a stored hash is a mirror that drifts). A mismatch aborts the transaction and returns the current hash. Racing creates resolve to one winner and one refusal.

There is no cross-namespace move: a namespace is an ownership boundary, not a folder. An overwrite within the hour without `if_match` warns, never refuses. CI logs are withheld from read-only keys, because logs carry whatever a step printed.

### Write modes

- `replace` writes a full body.
- `append` adds to the end; nothing is overwritten.
- `patch` replaces an anchored region. The anchor must occur exactly once or the write is refused. Mismatched line endings are the usual cause of a missed anchor.
- `meta` changes type, tags, status or title and leaves the body byte-identical.

Every mode returns the sha256 and byte count of the stored body. Pass that hash as `if_match` on the next write to the same document. A hash computed locally over a body a read returned is the stored hash. A `patch` whose anchor equals its replacement changes nothing and proves the anchor exists once; a wrong `if_match` writes nothing and returns the current hash.

## Canon and rulings are protected from agent keys

Canon is what every agent is told to trust: `capsid/conventions.md` and `capsid/conventions-<name>.md`, every namespace's `core.md` and `decisions.md`. `CANON_RULES` in `src/canon.ts` is the list. Dustin's rulings (`capsid/rulings/<name>.md`) are guarded the same way but are records, not canon (Dustin, 2026-11-18).

- Only the admin and the seat (`can_merge`) change canon or a ruling; for them a write, restore, move or delete is an ordinary snapshotted, audit-logged one.
- Every other agent key is refused, the portfolio-wide key (namespaces `*`, used by unattended routine sessions) included: every write, restore, move and delete, and a move onto a guarded path, with nothing changed.

## Rule documents are held to a cap and to served tool names

A rule document is one sessions follow as rules: every namespace's `core.md` (cap 8 KB) and `decisions.md`, and in capsid `conventions*.md` (cap 20 KB). Dated records (`archive/`, `research/`, `reports/`, `audits/`, `rulings/`) are not. `ruleDocCap` in `src/rule-docs.ts` is the list.

- **A write may not make a rule document worse.** `capsid_write_doc` (write, restore, a move onto a rule path) refuses a body over the cap that is larger than the stored one, or one naming a tool or action the Worker does not serve that the stored body did not name. A cut that leaves a document over its cap passes, so it can be fixed in steps. A move between rule paths and a restore pass.
- **A stale name** is a `capsid_*` name not in `TOOL_GRANTS`, an action its tool does not take, or an old tool name from the MCP 4 regroup (`scripts/tool-names-lib.ts`) in a backtick span, a call, or, for a name with an underscore, anywhere outside backticks.
- The lint report's `rule_doc_caps` and `stale_tool_names` checks and the daily maintenance pass's `rule-doc` rule list what is already wrong.

## Deleting a namespace

`capsid_admin_manage_namespaces`, admin only, in two calls. `delete_preview` writes nothing: it counts everything that names the namespace and returns a verdict and, when nothing refuses, a token bound to the namespace, `cascade`, `allow_improve_paths`, the counts and the caller, valid for five minutes. `delete_perform` takes the same arguments and the token, reads the counts again, refuses if any moved, and commits one batch whose first statement aborts unless the store still matches the plan.

It refuses, whatever `cascade` says, while any live agent names the namespace in its scopes (revoke it, or `update_scopes` to drop the namespace) and while the namespace is on the roster (`ROSTER` in `src/roster.ts`). It also refuses while live documents exist and `cascade` is not true, and while the namespace holds policy documents (under `policy/`) and `allow_improve_paths` is not true; that flag needs `can_touch_protected`, as on a document delete, and covers only policy documents.

The batch deletes every live document (every path outside `archive/`), each snapshotted to `document_versions` first and removed by the same path helper a document delete uses, which takes every edge touching it; the `ops_sites` row; and the `namespaces` row. One audit row, `namespace-delete`, holds the counts, the deleted paths, the removed edges and the two rows whole.

D1 caps a batch at 100 statements: five fixed plus two per document. A namespace with more than 47 live documents is refused at preview and perform, never half deleted; delete or move documents first.

It keeps history: archived documents and the edges between them, `document_versions`, `audit_log`, revoked agents and the nightly backups. Kept archived documents still carry the deleted name: reads return them under it, writes refuse until the name is registered again, and registering it brings them back into scope.

## The consolidation loop

Raw material accumulates; the loop compiles it. The server orchestrates and does no reasoning; the driving client does that with the ordinary read and write tools.

1. **gather** (read-only) returns the packet: the current `core.md`, the compiled concept and decision documents, every episodic and source document not yet archived, and `capsid/conventions.md` as the rules. It reports `packet_chars` and is size-bounded; when it trims, it stubs whole documents rather than truncating bodies, since a truncated Markdown document hides that the reader holds a fragment.
2. The client compiles (dedupes, resolves contradictions, refreshes cross-references) and writes the results.
3. **finalize** archives the consumed documents by moving them under `archive/` in one batch with one audit row. It refuses any document that is not episodic or source. Archive only, never delete. gather excludes `archive/`, which makes the loop idempotent.

**report** measures the store and writes `<namespace>/reports/lint-<date>.md`. Eight checks: contradictions (prose asserting a number the artifact disagrees with), stale decisions, unbound specs, broken links, unconsolidated documents, doc-vs-code drift (a repository path named in the canon that is gone), and the two rule-document checks. Documents by type is counted beside them. One integrity percentage: subjects in good standing over subjects judged. A check that could not run is excluded and says so; an empty store scores null, not 100.

## Beyond tools

- **Resources.** Every document is addressable at `capsid://<namespace>/<path>`, listed by `resources/list`, read-only with the read tool's visibility.
- **Prompts.** Every `prompt` document appears in the prompt list as `<namespace>/<path without .md>`, with its `{{variable}}` placeholders as required arguments. `prompts/get` substitutes them and returns the body as an embedded resource, not user text: any session with a write grant can write a body, and plain user text would hand whoever last wrote it a message the client's model reads as its own operator.

## Roles and the tools axis

A role is one capability, not a bundle (`scripts/roles.ts`; a test fails if a role names a second blast-radius flag). The tools axis can name an action, `capsid_close_pr.delete_branch`, and `allowsToolAction` states the rule once: `*` allows everything; a list naming at least one action of a tool is narrowed to the actions it names; a bare tool name with no qualified sibling means the whole tool; a qualified entry narrows only its own tool. Every tool whose action decides what it does passes the action to `checkScope`. Roles are in [auth.md](auth.md).

## Retired tables

The job queue retired on 2026-11-28 and migration 0072 dropped its tables (`jobs`, `job_*`, `pr_approvals`, the bench tables); older dumps still hold their rows. `watcher_findings.job_id` and `agents.jobs` are no longer written. No skill table is live. `improve_jti` stays as the replay table for the backup credential.

## Provenance

Reads return `last_actor`: the actor of the most recent audit entry for the document. A document another client wrote is untrusted input, and the stamp is on the response envelope rather than in the body, because the body is what an attacker controls.

## Audit rows from the Portal

The Portal (`/portal/`, [portal.md](portal.md)) reads the store through the same functions the tools call, so the two cannot disagree.

A click in the Portal writes two audit rows: the shared mutator's own row (for example `agent-revoked`), then `portal-<action>` under `access:<email>`. The on-demand watcher pass is `portal-ops-refresh`. Rows from before the move to `/portal` name the click `console-<action>`, and rows from before the Access login name the admin `github:<login>`, so a query across both dates matches both prefixes:

```sql
SELECT at, actor, action, namespace FROM audit_log
WHERE action LIKE 'portal-%' OR action LIKE 'console-%'
ORDER BY id DESC LIMIT 50;
```

**Reads of the rules are audited.** A `capsid_read_doc` read of `capsid/conventions.md`, or a `capsid_start_session` (which carries it), writes one `conventions-read` row under the caller's actor, at most one per caller per hour (`src/conventions-read.ts`). The row is in namespace `capsid` with no path, because a row addressed to the document would make the reader its `last_actor`. `params` are `{"via": "read" | "brief", "for_namespace": ..., "thread": ...}`; `thread` is present only when `capsid_start_session` was given one, and then the limit is one row per caller per thread per hour, because every project thread acts as one login.

```sql
SELECT actor, COUNT(*) AS hours_with_a_read FROM audit_log
WHERE action = 'conventions-read' AND at >= datetime('now', '-7 days')
GROUP BY actor ORDER BY hours_with_a_read DESC;
```

**Site configuration** is the `ops_sites` table ([portal.md](portal.md), "Sites are configuration"). Its edits are audited as `ops-site-added`, `ops-site-edited` and `ops-site-removed` with the row before and after, then the click row. A removed row survives only in that audit row and the nightly dump. Each repair is audited as `site-repair` and each site backup as `site-backup`, with the tool and the site's verdict, never the token.
