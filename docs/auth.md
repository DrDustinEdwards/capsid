# Auth model

Every caller resolves to an agent: a name, a set of scopes, and its own audit identity. There is one enforcement point, `checkScope` in `src/scope.ts`. The registrar wraps every tool registration before any tool module runs, so a tool is covered by existing, and `TOOL_GRANTS` states what each tool requires.

Scopes are five axes. `namespaces` and `repos` are a list or `*`. `tools` is an allow list or `*`. `grants` is read, or read and write. `flags` are the blast radius:

| flag | what it gates |
| --- | --- |
| `can_merge` | merging a pull request, which can trigger a deploy on a repo that deploys on push. CLOSING one needs it too, since 2026-09-16: close deletes the head branch, which is the same destruction. So does `capsid_close_pr` action `delete_branch` with `force: true`, since 2026-09-25, because force lifts its open-PR refusal. So do `capsid_close_pr` actions `tag` and `release`, since 2026-10-10, because a tag or a release can start a deploy as a merge can. |
| `can_direct_write` | a `mode: "direct"` commit, which lands on a default branch with no review |
| `can_dispatch` | dispatching a workflow, which spends CI minutes and runs code with that repo's secrets in scope |
| `can_write_workflows` | writing under `.github/workflows/` |
| `can_touch_protected` | tests, CI, lint and compiler config, lockfiles, manifests, the agent steering layer, migrations |
| `money_paths` | a path naming a billing or payment surface |
| `can_comment_pr` | commenting on a pull request (`capsid_open_pr` action `comment`), the smallest write the pull request tools make. It is not `can_merge`. |

A scopes JSON written before 2026-10-11 may still carry `max_claims`, a claim limit that no longer exists. It is ignored on read and dropped the next time the scopes are written.

A new agent gets read on its named namespaces and no flags. Scopes are stored as JSON and the parse fails closed: a null, truncated or wrong-shaped column resolves to no namespaces, no tools, no grants and no flags.

**The `repos` axis is set per driver, and editing the mapping is admin work.** Both halves were added 2026-09-13 and either alone leaves a hole. Until then every agent carried `repos: "*"`, because `scripts/mint-agents.mjs` named no repos for a driver and an omitted axis mints wide, and `allowsScope("*", v)` can never refuse. That made the namespace-to-repo mapping the only thing standing between a driver and every repo the App reaches, and `capsid_admin_manage_namespaces` action `update` took a plain write grant, which every driver holds. A driver could therefore remap its own namespace onto any repo and then read and write it.

- Registering and re-mapping a namespace (`capsid_admin_manage_namespaces` actions `register` and `update`) are `admin` in `TOOL_GRANTS`, checked by the registrar like every other requirement. A driver that needs a namespace mapped asks for it, the way it asks for a mint.
- Deleting a namespace (`capsid_admin_manage_namespaces` actions `delete_preview` and `delete_perform`, added 2026-09-29) is `admin` too: it removes the mapping and, with `cascade`, every live document in the namespace. It never touches an open job or a live agent: either one refuses the delete until it is ended with the `capsid_work_jobs` tool or revoked or re-scoped with the `capsid_admin_manage_agents` tool. docs/schema.md, "Deleting a namespace", lists what it deletes and what it keeps.
- A driver is minted with `repos` set to its namespace's mapped repos, read from the live mapping rather than from a list in the script, so the axis and the mapping cannot disagree. A namespace that maps to nothing refuses the mint rather than falling back to the wildcard. This is the MINT HANDLER, not only the script: until 2026-09-13 the derivation ran on `scripts/mint-agents.mjs --apply` and `mintAgent` still started from a wildcard, so an agent minted over MCP was born reaching every repo while the script's agents were narrow.
- **The axis is asked about the RESOLVED repo, not about the `repo` argument.** That argument is a selector: a label, or an owner/name, and omitting it is the default. Comparing it to the axis was wrong twice over, and both were measured on 2026-09-13: the legitimate label `primary` was refused, and omitting it skipped the axis while `resolveRepo` picked the namespace primary. Every repo tool now resolves first and asks about the result, reads included.

After all three, a remap gains a driver nothing: the repos axis refuses independently of what the mapping says.

**Every caller may read the portfolio documents in capsid, and nothing else there** (added 2026-10-08). Every repo's CLAUDE.md tells a session to follow the conventions, the rulings and the decisions log, and a driver scoped to its own namespace was refused all of them. This is the one exception to the namespaces axis, stated once in `PORTFOLIO_DOCS` (`src/portfolio-docs.ts`) and checked in `checkScope`:

- The paths: `conventions.md` and its topic files (`conventions-web.md`, `-cloudflare.md`, `-testing.md`, `-routing.md`, `-cloud.md`, `-names.md`, `-store.md`; not `conventions-improve.md`, which is Capsid's own), `core.md`, `decisions.md`, `decisions-vol-<n>.md`, `archive/decisions-vol-<n>.md` (n a number from 1), and `rulings/<name>.md` one level deep. A path must be lowercase letters, digits, `.`, `-`, `_` and `/` with no `..` and no empty segment, so `rulings/../policy/gates.md`, `Rulings/x.md`, `rulings/%2e%2e/x.md`, `rulings-secret/x.md` and `rulings/a/b.md` are all refused.
- The tools: `capsid_read_doc` action `read`, which must name one of those paths, and `capsid_find_docs` actions `list`, `glob` and `search` with `namespace: "capsid"`, whose handlers keep only those paths for such a caller. Omitting the namespace is still refused to a narrowed caller.
- Not covered: every other capsid path (research, policy, jobs, reports, episodics, `repo-structure.md`), `capsid_start_session`, `capsid_read_doc` actions `versions` and `links`, every write tool and `capsid_work_jobs`. Versions and links stay out because a version list or an edge can name a capsid path that is not on the list. The `capsid://` resources stay scoped as before.
- `capsid_start_session` for any namespace returns `portfolio_documents`: the paths above that exist, so a session reads them first.

### Roles

Roles are few and separated. Each one is a single capability, not a bundle. `scripts/mint-agents.mjs` holds them in two lists: `ROLES`, asked for by name, and `AGENTS`, the per-namespace bootstrap that holds the drivers and the seat. `node scripts/mint-agents.mjs --roles` prints a mint command for each entry in `ROLES`, which is every row below that is not a driver or the seat; the driver rows and the seat are minted by the same script's namespace path (`docs/bootstrap.md`). A test fails the build if any role names a second blast-radius flag.

| role | reads | writes | flag |
| --- | --- | --- | --- |
| `<ns>-driver` | its own namespace | its own namespace, pull requests only | none by default; two exceptions below |
| `auditor` | every namespace and repo | nothing at all | none |
| `reviewer` | every namespace and repo | a comment on a pull request | `can_comment_pr` |
| `watcher` | every namespace | `capsid_work_jobs.post`, and no other job action | none |
| `seat` | every namespace | every namespace | `can_merge` |
| `site-seat` | `dustinedwards` | `dustinedwards` | `can_merge` |
| `live-probe` | `capsid`, through the `capsid_read_doc` tool only | nothing at all | none |

**A project driver holds no blast-radius flag by default, and two of them hold one.** Granted by the seat on 2026-09-11, each for a stated reason rather than as a convenience: `capsid-driver` holds `can_touch_protected`, and `claude-skills-driver` holds `can_touch_protected` and `can_write_workflows`. In both repos the protected list is what the driver's own jobs edit, because tests, CI and `scripts/` are the subject of the work rather than something near it, and in claude-skills a skill's workflow is part of the artifact. Every other driver holds none, and `capsid_run_improve` action `status` and Capsid Portal list the flags each one actually has, so the inventory is the answer rather than this paragraph. Widening one is `capsid_admin_manage_agents` action `update_scopes`, which is admin only and audit-logged with the scopes before and after.

The reviewer and the watcher both need the write grant, because commenting and posting a job both go through write tools. The tools axis keeps that from being a general write. An entry can name an action: `capsid_work_jobs.post` or `capsid_open_pr.comment`. A list naming at least one action of a tool is narrowed to the actions it names. A bare tool name with no qualified sibling still means the whole tool, and `*` still allows everything, so no agent minted before this changes behaviour. **The action reaches `checkScope` on every call that has one**, which until 2026-09-13 was true of the work queue tool alone (then `jobs`): the registrar passed no action, so a reviewer holding `["manage_pr", "manage_pr.comment"]` (the pull request tool of the time) could `close` a pull request, and closing deletes the head branch. Since 2026-10-10 commenting and closing are separate tools as well, `capsid_open_pr` and `capsid_close_pr`. The registrar reads the action off the tool's own declared argument, named per tool in `ACTION_ARG` because `capsid_lint_namespace` spells it `mode`, and `guardedWrite` names it again for every repo mutation. An unknown action on a narrowed tool is refused rather than read as the whole tool, so a call path that forgets to pass one fails closed.

The `capsid_admin_manage_agents` tool is admin only. An agent that could mint another could widen itself. `mint` returns a key once and stores only its sha256. `list` is the inventory, revoked rows included. `revoke` sets `revoked_at` rather than deleting, so rows an agent wrote still resolve to what it was allowed to do, while its key stops resolving immediately. `update_scopes` replaces named axes and leaves the rest.

**A revoked agent is archived, not deleted** (`migrations/0038_agents_archive.sql`, `src/agents-archive.ts`; Dustin, 2026-10-10). The watcher pass moves a revoked agent from `agents` to `agents_archive` 7 days after revocation, and a retired runner key bound to one job on the first pass after that job is done, failed or superseded. Each move is one batch: the row is copied with the counts of its audit rows and jobs taken at the move, deleted from `agents`, and an `agents.archive` audit row is written by `agent:watcher`. Every row that records what an agent did carries the actor string `agent:<name>` itself (audit_log, jobs, job_outcomes, job_claims, job_touches, agent_sessions), so none needs the agents row. Three readers still look in the archive: a mint refuses an archived name, an archived key is refused and never tried as an operator key, and a reviewer's past verdict is judged on the scopes it held (`test/agents-archive.test.ts`). `capsid_admin_manage_agents` action `list` with `archived: true` returns the archive; `capsid_run_improve` action `status`'s `agents` lists the 50 newest moves after the live rows, each with `archived_at`. The Portal's Agents roster shows live agents only; its Archive tab shows the revoked and the archived.

**Runner keys are retired** (job_2c92174d5bff, 2026-10-11). A key bound to one job (`agents.job_id`, migrations/0021) was minted by `/ops/runner-key` for a seat-started GitHub Actions session. Seat-start is gone, the route and the resolver's binding check are removed, and migration 0045 revokes any key that was still bound. `agents.job_id` and `agents_archive.job_id` stay as columns nothing writes. A routine's cloud session reaches Capsid with the cloud-driver key from the network secret (docs/routines.md).

Audit rows and `jobs.claimed_by` record a minted agent as `agent:<name>`.

**Four of these have never connected, and what each is waiting for is written down so an unused credential reads as a plan rather than a loose end.** `capsid_run_improve` action `status` shows `last_seen: null` for all four today.

- `seat` is not what auto-merge uses. `capsid/policy/auto-merge.md` is signed and enabled, and the Worker merges a qualifying pull request itself on its cron tick (`src/auto-merge-tick.ts`), on the namespaces the policy names. The signed policy (reviewable source: `docs/policy/auto-merge.md`) decides which namespaces may auto-merge; a pull request that touches a refused path, or fails any other check, waits for the seat. The seat's key is for a seat session working through `/ops/mcp`, and its `last_seen` in `capsid_run_improve` action `status` shows whether one has.
- `reviewer` is used the first time a job is posted with `review_required`, since that is the only thing that waits for a `REVIEW:` comment. No job has been posted with it yet.
- `auditor` is used by an outside model doing a cold audit, which is a thing a person starts rather than something the system reaches for.
- `watcher` is different from the other three, and its `null` means something else. The tick has no bearer token to present, so it builds a SYNTHETIC watcher identity in `src/watcher.ts` shaped to match the minted role exactly, and `touchLastSeen` returns early for an agent with no row. The minted `watcher` key is therefore unused by construction, and its `last_seen` stays `null` however many findings the tick posts. What records that work is `audit_log`, where the actor is `agent:watcher` either way. The key is there for a person driving the watcher's checks by hand from outside the Worker.

Three kinds of caller resolve, in this order:

1. **A minted agent**, matched on the sha256 of its bearer token. Checked first, so a key that is both an agent and an operator entry gets the narrower authority.
2. **A legacy operator key**, until its hash is removed from `OPERATOR_KEY_HASH` by hand.
3. **The OAuth admin session**, the synthetic agent `admin` with every scope.

The operator hash is removed once every machine runs as its folder's driver agent and the admin OAuth session is the only wider credential. That is the last step of the migration in `docs/bootstrap.md`. On this deployment it was done on 2026-09-12, when `OPERATOR_KEY_HASH` was deleted (recorded in `docs/bootstrap.md`), and the secret list read on 2026-09-25 did not contain it. On any deployment where the secret is still set, the legacy path stays live: `src/auth.ts` reads the secret on every bearer request, and `src/agents.ts` gives a plain entry the admin grant, so a key in it can still mint agents. `npx wrangler secret list --name capsid` shows whether it is set, and prints names only.

Four gated MCP endpoints, two servers. Capsid (14 tools) is served on `/mcp` and `/ops/mcp`; Capsid Admin (8 tools, every name starting `capsid_admin_`) is served on `/mcp/admin` and `/ops/mcp/admin` and nowhere else, so a client connects to it as a separate connector.

1. **OAuth (`/mcp`)** for human clients. The client discovers the server via `.well-known` and identifies itself by Client ID Metadata Document (CIMD): its client id is the https URL of a JSON document naming its redirect URIs, which the Worker fetches. CIMD is advertised only while the `global_fetch_strictly_public` compatibility flag is set. Grok and Gemini cannot send a metadata document, so `POST /register` is a tightened Dynamic Client Registration (capsid/rulings/mcp-2026-10-10.md, rule 13; `src/dcr.ts`), on the MCP host only. Every redirect URI a registration names must be on the allowlist, matched exactly: Grok's connector callback and ChatGPT's legacy callback are fixed in code, and the per-connector callbacks Gemini and ChatGPT issue are listed by the seat in the `DCR_REDIRECT_URIS` var (comma separated; a listed URI that is not a Google or ChatGPT connector callback is ignored and logged). Registration is rate limited per address, 10 an hour and 30 a day, and refuses when the limit cannot be read. It writes a client record and grants nothing: the client still meets the consent page on its first `/authorize` and the Access sign-in that admits `ADMIN_EMAIL` and `CO_OWNER_EMAILS` only. DCR is removed when Grok and Gemini sign in by CIMD, at the latest when the specification drops it. Every token is bound to its host's resource (RFC 8707) by the provider and refused at any other (`test-integration/oauth-round-trip.test.ts`, the audience plant). The live gate's probe client has its document served by the Worker itself at `/oauth/clients/verify-live.json` (`src/oauth-client-docs.ts`), a path that names no branch, so the master to main rename cannot change the probe's identity. The probe uses it on whatever origin it checks (`probeClientId` in `scripts/cimd-probe-lib.mjs`), so a 404 there is a failed gate of that deploy (test/cimd-probe.test.ts, test/verify-live-no-answer.test.ts). `scripts/verify-live-client.json` on GitHub stays until plan step 4, so a rollback to older code still finds its client. It then goes through `/authorize` and a one-time approval screen to Cloudflare Access for SaaS (OIDC), the app "Capsid" on the `dustinedwards.cloudflareaccess.com` team (capsid/research/design-capsid-access-login.md). Access has been the upstream since #185 merged, 2026-09-28 00:01 UTC (2026-09-27 in America/Chicago); GitHub was the upstream before.
   - **The sign-in** uses PKCE and a nonce. `src/access-jwt.ts` verifies the ID token with jose (6.2.12, pinned; the verifier the portfolio's sites share): RS256 only, against the app's `/jwks` through `createRemoteJWKSet` (a kid it does not hold refetches the keys at once, so a rotation is picked up), `iss` the app's issuer, `aud` its client id, `exp` and `nbf` on the caller's clock. A token must name a kid, whatever the key set holds. Then, checked in that file, the nonce, `email_verified` not false, and an email. The admin is still `ADMIN_EMAIL`, or a co-owner listed in `CO_OWNER_EMAILS`, checked on every request.
   - **The admin check:** the email must equal `ADMIN_EMAIL` or an entry of `CO_OWNER_EMAILS` exactly (comma separated, each trimmed, empty entries ignored, no case folding, timing-safe compare). Any other identity gets a 403, and the check runs again on every `/mcp` request. A co-owner is audited as `access:<her email>`, is stepped up like the admin, and cannot change `ADMIN_EMAIL` or `CO_OWNER_EMAILS`, which are set only in Cloudflare (below, "Co-owner").
   - **Grants from before the switch** carry a GitHub login and no email, fail that check, and the client signs in again once.
   - **The audit actor** is `access:<email>`, since #185 (2026-09-28 00:01 UTC). Audit rows and job rows from before it name the admin as `github:<login>`, so a query for the admin's history across the switch matches both prefixes.
   - **Capsid Portal** (https://portal.dustinedwards.info, and `/portal/` on workers.dev until that is verified live) signs in through the same Access app with its own redirect URL on each host, `https://portal.dustinedwards.info/callback` and `/portal/callback` on workers.dev, both listed in the Access app, and keeps a signed twelve-hour cookie carrying the email (docs/portal.md). It signed in at `/console/callback` from the design's PR 3 (#188, merged 2026-09-28 02:37 UTC) until PR B of capsid/research/design-portal-unify.md moved it to `/portal` with no redirects; the Access app's `/console/callback` redirect URL is removed once the Portal sign-in is confirmed live. The same `ADMIN_EMAIL` or `CO_OWNER_EMAILS` check runs on every Portal request, so a cookie from the GitHub login, which carries no email, is refused and the Portal asks to sign in once. A click in the Portal is audited as `access:<email>`.
   - An admitted admin holds a full write grant.
   - **Settings:** `ACCESS_TEAM_DOMAIN`, `ACCESS_SAAS_CLIENT_ID`, `ACCESS_SAAS_CLIENT_SECRET`, `ADMIN_EMAIL`. Any unset closes the sign-in with a 503. Optional: `CO_OWNER_EMAILS`.
2. **Agent and operator keys (`/ops/mcp`)** for agents and cron, gated by sha256-hashed bearer keys. An agent key resolves to its row. Failing that, `OPERATOR_KEY_HASH` holds comma-separated hashes: a plain entry is a write key, an entry prefixed `ro:` is read-only and is denied every tool or action `TOOL_GRANTS` marks write: `capsid_write_doc`, `capsid_delete_doc`, `capsid_change_repo`, `capsid_open_pr`, `capsid_close_pr`, `capsid_run_ci`, `capsid_lint_namespace` finalize and report, and every `capsid_work_jobs` action but `list`. Revoke by removing a hash; the others keep working. The OAuth library never sees this route.
3. **Capsid Admin (`/mcp/admin` and `/ops/mcp/admin`)** for the admin alone. `/mcp/admin` is the OAuth route above, with the same Access sign-in and the same `ADMIN_EMAIL` or `CO_OWNER_EMAILS` check on every request. `/ops/mcp/admin` takes a bearer key like `/ops/mcp`, answers 401 without one and 403 for any key that is not the admin identity (the seat's operator key at its terminal), and every tool call it serves still passes `checkScope`. Every Capsid Admin tool is `admin` or `admin_read` in `TOOL_GRANTS`, so a scoped agent is refused it whatever route it reaches. `capsid_admin_read_claims`, `capsid_admin_read_ops` and `capsid_admin_whats_next` are `admin_read`: the admin identity and the read grant, served read-only.
   - **Step-up.** A grant lives for weeks and is refreshed without a person, so the risky admin actions also need a recent Access sign-in (`STEP_UP`, `STEP_UP_IDLE_MS` and `STEP_UP_MAX_MS` in `src/scope.ts`): a sliding window, as GitHub's sudo mode has. The action is allowed when the Access sign-in or the last successful step-up action was within 2 hours; each successful step-up action resets that clock; and never more than 12 hours after the sign-in, whatever the activity (NIST SP 800-63B-4 caps an AAL3 session at 12 hours). The last step-up time is kept per session in `APP_KV` (`step-up:last:<actor>:<sign-in time>`, read on `/mcp/admin` where the admin agent is built in `src/index.ts`, written after a step-up action succeeds), so activity in one session never keeps another, idle one inside the window. An unreadable entry, or one later than now, is treated as absent, so a KV failure can only narrow access; a failed write is logged and never fails the action. A step-up action that errors or answers `ok: false` does not reset the clock. Only the MCP admin tools enforce it; the Portal's controls do not. The actions: `capsid_admin_manage_namespaces` actions `register`, `update` and `delete_perform`, `capsid_admin_manage_agents` actions `mint`, `revoke` and `update_scopes`, `capsid_admin_run_controls` action `perform`, every action of `capsid_admin_control_improve`, and `capsid_admin_set_site_key`. An older or idle session is refused with `step-up required` and nothing is done; reconnecting the Capsid Admin connector (disconnect, connect, sign in) starts a fresh one. It is a re-authentication, not a mid-call confirmation. Only an OAuth session carries a sign-in time: a key holder on `/ops/mcp/admin` has no session to refresh and is not stepped up, because its key is the credential.

Login and repo access use different credentials: the Access for SaaS app for both logins, and a GitHub App for repo access. The GitHub OAuth App that was the login before the switch was deleted on 2026-09-28, after PR 4 was live and the claude.ai connector had reconnected by CIMD, and its three secrets (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ADMIN_GITHUB_LOGIN`) were deleted from the Worker the same day. No code reads them.

`capsid_admin_manage_namespaces` action `register` returns the command that mints the new namespace's driver agent, `node scripts/mint-agents.mjs --namespace <ns> --apply`. It does not mint it, and since 2026-09-13 it is admin only itself, so the separation is now belt and braces: registering a namespace and minting a credential for it are two acts by the same caller rather than one act that quietly does both.

## Tool hints and list caching

Every tool in `tools/list` carries all four annotations, from `src/tool-annotations.ts`. They are hints to a client and enforce nothing; `checkScope` is still the only gate.

- `readOnlyHint` is true when every action of the tool needs only the read grant in `TOOL_GRANTS` and `TOOL_ACTION_GRANTS`: `read`, or `admin_read` for an admin tool that only reads (`capsid_admin_read_claims`, `capsid_admin_read_ops`, `capsid_admin_whats_next`).
- `destructiveHint` is true when a write can overwrite or remove existing state.
- `idempotentHint` is true for every read-only tool, and for a write only when a repeat of the same call changes nothing further (a second `capsid_delete_doc` finds nothing and is refused). Tools that create something on every call, such as `capsid_run_ci`, `capsid_open_pr` and `capsid_work_jobs` (its `post`), are false.
- `openWorldHint` is true when the handler reaches GitHub or Cloudflare: the repo tools, `capsid_inspect_repo` (CI runs and the live site check among them), `capsid_lint_namespace` (gather reads the repo tree), `capsid_work_jobs` (evidence checks and seat starts), `capsid_admin_read_ops` (Cloudflare and the watcher's site probes), `capsid_admin_whats_next` and `capsid_admin_set_site_key`.

Both of the last two are stated for every tool, because the protocol reads an omitted `idempotentHint` as false and an omitted `openWorldHint` as true. `test/tool-annotations.test.ts` derives each hint from the handler source and fails in both directions.

All four MCP endpoints speak MCP 2026-07-28 through `@modelcontextprotocol/server` 2 and `agents` (`src/mcp-handler.ts`), stateless, with `server/discover` and no session. A client that opens with `initialize` is served the 2025-11-25 era by a shim (`src/legacy-era.ts`), which is deleted when the clients that reach Capsid open with `server/discover`; the file states the removal condition.

On 2026-07-28 the cacheable results carry `ttlMs` and `cacheScope`, set by the SDK's `cacheHints` server option (`src/cache-hints.ts`); a 2025-11-25 response never carries them. `tools/list` and `server/discover` are `public` for 60 seconds: every caller is served the same list, and scope refuses at call time. `prompts/list`, `resources/list`, `resources/templates/list` and `resources/read` are `private` for 60 seconds, because each is filtered to the caller's namespaces.

What the clients do with them, as of 2026-09-29:

- **Claude Code**, verified: it refreshes its tool list on `notifications/tools/list_changed`. On protocol 2026-07-28 it rejects a `tools/list` result that lacks `ttlMs` or `cacheScope` (anthropics/claude-code#88128). capsid serves both on 2026-07-28 (`test/cache-hints.test.ts`). Nothing shows Claude Code caching by `ttlMs`.
- **claude.ai**, unknown: nothing observed shows whether it reads the annotations, the cache fields, or either. It is known to cache the tool list from connect time, so a deploy still needs a reconnect (docs/bootstrap.md, "Verifying a deploy").

## Co-owner

A second person can hold the same access as the administrator. Her email goes in the optional Worker secret `CO_OWNER_EMAILS` (comma separated for more than one; each entry trimmed, empty entries ignored, exact match, no case folding, the same timing-safe compare as `ADMIN_EMAIL`). Unset or empty means no co-owners, and while `ADMIN_EMAIL` is unset nobody is admitted, a co-owner included.

- She is admitted to `/mcp`, `/mcp/admin` and the Portal like the administrator. Every audit row, actor and "signed in as" carries the email Access verified for her, `access:<her email>`, never `ADMIN_EMAIL`.
- The step-up applies to her exactly as to the administrator, on her own sign-in and her own idle clock.
- `ADMIN_EMAIL` stays the primary owner and is set only in Cloudflare. No Capsid tool, Portal action or sync can change it, `CO_OWNER_EMAILS` or who is admitted, so a co-owner cannot remove or demote the primary owner from inside Capsid. The push alerts' VAPID subject stays `ADMIN_EMAIL`.
- To add her: in the Cloudflare dashboard, Workers & Pages, capsid, Settings, Variables and Secrets, add `CO_OWNER_EMAILS` as a Secret (Type: Secret, not Text) holding her email. The Access policies that admit the admin (the Capsid app and the apps behind Access) must list her email too, or Access refuses her before Capsid is asked.

## Repo mutations and the audit trail

Every write to GitHub goes through `guardedWrite` (`src/tools/repo-guards.ts`). It resolves the repo the call actually reaches, asks `checkScope` about that repo with the flags the call's intent needs, runs the write, and then writes an `audit_log` row. GitHub cannot join a D1 transaction, so if that audit insert fails after the write landed, the result reports the write as done with an `audit_warning` rather than as a failure (`test/blast-radius.test.ts` covers the rule).

Every overwrite and delete of a document snapshots the prior version to `document_versions` and writes `audit_log` (`test/invariants.test.ts`, `test/write-invariants.test.ts`). These tables are not kept forever in D1: after each daily backup, `document_versions` rows older than 90 days and `audit_log` rows older than 180 days are pruned, and they survive only in retained dumps (docs/backups.md).

The minted roles each hold at most one blast-radius flag, and `test/roles.test.ts` fails the build if a role names a second. Two project drivers hold a flag by a recorded exception; the Portal and `capsid_run_improve` action `status` list what each agent actually holds.

## What Capsid cannot control

- The admin's own session. The OAuth admin is a synthetic agent with every scope, so a client holding that login on Dustin's machine is not narrowed by `checkScope`, and his own shell can push, deploy or run `wrangler` without going through Capsid at all.
- The legacy operator key, on any deployment where `OPERATOR_KEY_HASH` is still set: a plain entry has the admin grant. This deployment deleted it on 2026-09-12.
- Client-side tool caching. MCP clients cache the tool list at connect time; claude.ai's handling of the cache hints is unknown. A deploy is verified by calling the Worker directly.
- Tool annotations such as `readOnlyHint` are hints to the client and enforce nothing.
- Portal sign-out ends the Portal cookie only. The Access session is Cloudflare's, and a copied cookie stays valid until it expires.
- Hooks and telemetry from a session are reported by that session. A session that sends no key records nothing.

## Audits

Independent audits of this surface produced these fixes, now in the code: path traversal closed on every document path, OAuth consent bound to the exact redirect it was granted for, protected paths enforced by a deterministic guard, an Origin allowlist on the browser-facing routes, and a replay cache keyed by a database primary key rather than a read-then-write. Two further audits on 2026-09-13, one on the source and one on the test suite, closed four more criticals, each one a check a call path did not reach rather than a rule nobody had written. Each fix ships with a test observed failing against the code it replaced. Private audits live in Capsid. A 2026-09-16 source audit of this Worker is `AUDIT-2026-09-16.md` at the repo root; it is a snapshot, not canon.

## Endpoints

The router is `defaultHandler` in `src/routes.ts`, behind the OAuth provider and the host rules in `src/index.ts`. On the MCP host (`mcp.dustinedwards.info`) only the paths in `src/mcp-host.ts` answer; the Portal host serves the Portal and nothing else (`src/portal-host.ts`). Each route's auth is also stated in `src/scope.ts`.

MCP and sign-in:

- `POST /mcp` and `POST /mcp/admin` MCP over Streamable HTTP, requires an OAuth access token (the admin and any co-owner only)
- `POST /ops/mcp` and `POST /ops/mcp/admin` MCP over Streamable HTTP for agents and cron, requires an agent or operator key as `Authorization: Bearer <key>`; the admin route takes the admin identity only
- `GET /authorize`, `POST /authorize`, `GET /callback` the MCP sign-in, through Cloudflare Access for SaaS
- `POST /token` token exchange (served by the library)
- `POST /register` tightened dynamic client registration for Grok and Gemini, MCP host only, rate limited, grants nothing (`src/dcr.ts`, above). Claude and ChatGPT use a Client ID Metadata Document instead
- `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` discovery metadata (served by the library)
- `GET /oauth/clients/verify-live.json` the live gate's probe client document (`src/oauth-client-docs.ts`)

Agents and operators (`/ops/`):

- `POST /ops/otlp/v1/metrics`, `POST /ops/otlp/v1/logs` Claude Code's OpenTelemetry as OTLP/HTTP JSON, gzip or plain, at most 1MB. A driver key or the admin key as `Authorization: Bearer <key>` (401 without one, 403 for a read-only key). Keeps usage totals per session and a count of api_error events; never a prompt, a response or tool content (docs/telemetry.md)
- `POST /ops/hooks` Claude Code HTTP hook events, requires a driver key as `Authorization: Bearer <key>`; keeps a summary of each session, never a prompt, a response or a tool's input or output beyond its name, an edited file's path and a Bash command's first word and exit code (docs/hooks.md)
- `GET /ops/inbox` what needs Dustin, per app: blocked jobs and questions, pull requests auto-merge declined, failing CI, a site that is down. Read by an app's server with a bearer key; a key scoped to one namespace sees that app only, the admin sees every app, and the response carries no CORS headers (docs/portal.md)
- `POST /ops/inbox/report` what an app reports about itself to the inbox (Carrel's drafts waiting), with its own key and the write grant on its namespace; replaced whole, expires after 6 hours, one per minute per key (docs/portal.md)
- `POST /ops/access-sync` an app's members page makes its Cloudflare Access group hold exactly its current members, with the app's own key and the write grant on its namespace. The group is the one the seat pinned for that namespace in `access_sync_groups`, its name checked before every write; removed people's Zero Trust seats are freed, only for people the group held before the write; every call is audited. Capsid holds the only write token, `CF_ACCESS_SYNC_TOKEN` (docs/portal.md)
- `POST /ops/backup` runs a backup on demand, requires the admin (a write-grant operator key; a minted agent gets 403), returns a JSON summary

Backups and the paired comparison (signed, no bearer; the improve loop's `/improve/score` and `/improve/holdout-credential` were removed 2026-10-19):

- `POST /backup/credential` mints the credential the off-account backup writes with
- `POST /bench/tasks`, `POST /bench/start`, `POST /bench/score` the capsid-bench repo registers a task, opens a run and reports its result, signed with the bench key; a run starts only while KV `bench:enabled` reads `on` (docs/bench.md)

Public:

- `GET /health` no auth. Reports deploy provenance (git sha, whether the tree was dirty, build time) and probes the store: `SELECT 1` against D1 plus an FTS5 MATCH pinned to one known document. Either probe failing returns 503 with `status: "degraded"` and a `store` object naming which one. A Worker whose bindings resolved to nothing starts normally and would otherwise answer `ok` while every read tool errors.
- `GET /public/model/v1.json` no auth. The public system model the explorer and the dustinedwards.info map are built from: what the daily build stored after the privacy filter, never computed per request. Private systems appear as a name and domain only. Edge-cached, then limited per IP; no CORS (docs/public-data.md)
- `GET /public/stats/v1.json` no auth. Counts, rates and medians across every namespace, agent and site, over whole UTC days, computed once a day by the same build: never a name, a title or a time of day; a rate over fewer than ten rows is null. Edge-cached, then limited per IP; no CORS (docs/public-data.md)
- `GET /public/code/v1.json` no auth. The code maps of public systems' repos (modules, imports, cycles, per-function complexity, coverage and scores), read hourly by the same build from each repo's `code-map` branch; a private system's repos are never read. Edge-cached, the same per-IP limit; no CORS (docs/public-data.md)
- `POST /csp-report` no auth. Content-Security-Policy and COOP violation reports, per-IP rate limited, and refused with a 503 when the limiter cannot read its counters

Capsid Portal (admin Access session only; a request with any `Authorization` header is refused with 403; docs/portal.md, "Routes"):

- `GET /portal/` the app, and `GET /portal/callback` its sign-in return
- `GET /portal/api/ops` the feed, and `POST /portal/api/ops/refresh` an on-demand watcher pass (header `X-Capsid-Ops: refresh`, once per two minutes)
- `POST /portal/api/actions/preview` and `POST /portal/api/actions/perform` the controls as a preview and a perform (header `X-Capsid-CSRF`)
- `GET /portal/api/` reads: `namespaces`, `activity`, `claims`, `stale`, `plan`, `digest`, `maintenance`, `convergence`, `packages/history`, `shared-code`, `library`, `trends`
- `GET` and `POST /portal/api/push` phone alerts, and `POST /portal/api/sign-out`
- Any other path under `/portal/api/` is a JSON 404. Nothing answers under `/console`
