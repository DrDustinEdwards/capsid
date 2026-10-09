# Auth model

Every caller resolves to an agent: a name, a set of scopes, and its own audit identity. There is one enforcement point, `checkScope` in `src/scope.ts`. The registrar wraps every tool registration before any tool module runs, so a tool is covered by existing, and `TOOL_GRANTS` states what each tool requires.

Scopes are five axes. `namespaces` and `repos` are a list or `*`. `tools` is an allow list or `*`. `grants` is read, or read and write. `flags` are the blast radius:

| flag | what it gates |
| --- | --- |
| `can_merge` | merging a pull request, which can trigger a deploy on a repo that deploys on push. CLOSING one needs it too, since 2026-09-16: close deletes the head branch, which is the same destruction. So does `delete_branch` with `force: true`, since 2026-09-25, because force lifts its open-PR refusal. |
| `can_direct_write` | a `mode: "direct"` commit, which lands on a default branch with no review |
| `can_dispatch` | dispatching a workflow, which spends CI minutes and runs code with that repo's secrets in scope |
| `can_write_workflows` | writing under `.github/workflows/` |
| `can_touch_protected` | tests, CI, lint and compiler config, lockfiles, manifests, the agent steering layer, migrations |
| `money_paths` | a path naming a billing or payment surface |
| `can_comment_pr` | commenting on a pull request, the smallest write `manage_pr` makes. It is not `can_merge`. |

Beside the axes, the scopes JSON carries `max_claims`, how many jobs the agent may hold claimed at once (docs/work-queue.md, "More than one claim"). It authorizes no tool, `checkScope` does not read it, and absent it reads as 1.

A new agent gets read on its named namespaces and no flags. Scopes are stored as JSON and the parse fails closed: a null, truncated or wrong-shaped column resolves to no namespaces, no tools, no grants and no flags.

**The `repos` axis is set per driver, and editing the mapping is admin work.** Both halves were added 2026-09-13 and either alone leaves a hole. Until then every agent carried `repos: "*"`, because `scripts/mint-agents.mjs` named no repos for a driver and an omitted axis mints wide, and `allowsScope("*", v)` can never refuse. That made the namespace-to-repo mapping the only thing standing between a driver and every repo the App reaches, and `update_namespace` took a plain write grant, which every driver holds. A driver could therefore remap its own namespace onto any repo and then read and write it.

- `register_namespace` and `update_namespace` are `admin` in `TOOL_GRANTS`, checked by the registrar like every other requirement. A driver that needs a namespace mapped asks for it, the way it asks for a mint.
- `delete_namespace` (added 2026-09-29) is `admin` too: it removes the mapping and, with `cascade`, every live document in the namespace. It never touches an open job or a live agent: either one refuses the delete until it is ended with the `jobs` tool or revoked or re-scoped with the `agents` tool. docs/schema.md, "Deleting a namespace", lists what it deletes and what it keeps.
- A driver is minted with `repos` set to its namespace's mapped repos, read from the live mapping rather than from a list in the script, so the axis and the mapping cannot disagree. A namespace that maps to nothing refuses the mint rather than falling back to the wildcard. This is the MINT HANDLER, not only the script: until 2026-09-13 the derivation ran on `scripts/mint-agents.mjs --apply` and `mintAgent` still started from a wildcard, so an agent minted over MCP was born reaching every repo while the script's agents were narrow.
- **The axis is asked about the RESOLVED repo, not about the `repo` argument.** That argument is a selector: a label, or an owner/name, and omitting it is the default. Comparing it to the axis was wrong twice over, and both were measured on 2026-09-13: the legitimate label `primary` was refused, and omitting it skipped the axis while `resolveRepo` picked the namespace primary. Every repo tool now resolves first and asks about the result, reads included.

After all three, a remap gains a driver nothing: the repos axis refuses independently of what the mapping says.

**Every caller may read the portfolio documents in capsid, and nothing else there** (added 2026-10-08). Every repo's CLAUDE.md tells a session to follow the conventions, the rulings and the decisions log, and a driver scoped to its own namespace was refused all of them. This is the one exception to the namespaces axis, stated once in `PORTFOLIO_DOCS` (`src/portfolio-docs.ts`) and checked in `checkScope`:

- The paths: `conventions.md`, `core.md`, `decisions.md`, `decisions-vol-<n>.md`, `archive/decisions-vol-<n>.md` (n a number from 1), and `rulings/<name>.md` one level deep. A path must be lowercase letters, digits, `.`, `-`, `_` and `/` with no `..` and no empty segment, so `rulings/../policy/gates.md`, `Rulings/x.md`, `rulings/%2e%2e/x.md`, `rulings-secret/x.md` and `rulings/a/b.md` are all refused.
- The tools: `read`, which must name one of those paths, and `list`, `find` and `search` with `namespace: "capsid"`, whose handlers keep only those paths for such a caller. Omitting the namespace is still refused to a narrowed caller.
- Not covered: every other capsid path (research, policy, jobs, reports, episodics, `repo-structure.md`), `brief`, `history`, `backlinks`, every write tool and `jobs`. History and backlinks stay out because a version list or an edge can name a capsid path that is not on the list. The `capsid://` resources stay scoped as before.
- `brief` for any namespace returns `portfolio_documents`: the paths above that exist, so a session reads them first.

### Roles

Roles are few and separated. Each one is a single capability, not a bundle. `scripts/mint-agents.mjs` holds them in two lists: `ROLES`, asked for by name, and `AGENTS`, the per-namespace bootstrap that holds the drivers and the seat. `node scripts/mint-agents.mjs --roles` prints a mint command for each entry in `ROLES`, which is the four below that are not a driver or the seat; the driver rows and the seat are minted by the same script's namespace path (`docs/bootstrap.md`). A test fails the build if any role names a second blast-radius flag.

| role | reads | writes | flag |
| --- | --- | --- | --- |
| `<ns>-driver` | its own namespace | its own namespace, pull requests only | none by default; two exceptions below |
| `auditor` | every namespace and repo | nothing at all | none |
| `reviewer` | every namespace and repo | a comment on a pull request | `can_comment_pr` |
| `watcher` | every namespace | `jobs.post`, and no other job action | none |
| `seat` | every namespace | every namespace | `can_merge` |
| `site-seat` | `dustinedwards` | `dustinedwards` | `can_merge` |

**A project driver holds no blast-radius flag by default, and two of them hold one.** Granted by the seat on 2026-09-11, each for a stated reason rather than as a convenience: `capsid-driver` holds `can_touch_protected`, and `claude-skills-driver` holds `can_touch_protected` and `can_write_workflows`. In both repos the protected list is what the driver's own jobs edit, because tests, CI and `scripts/` are the subject of the work rather than something near it, and in claude-skills a skill's workflow is part of the artifact. Every other driver holds none, and `improve_status` and Capsid Portal list the flags each one actually has, so the inventory is the answer rather than this paragraph. Widening one is `agents` action `update_scopes`, which is admin only and audit-logged with the scopes before and after.

The reviewer and the watcher both need the write grant, because commenting and posting a job both go through write tools. The tools axis keeps that from being a general write. An entry can name an action: `jobs.post` or `manage_pr.comment`. A list naming at least one action of a tool is narrowed to the actions it names. A bare tool name with no qualified sibling still means the whole tool, and `*` still allows everything, so no agent minted before this changes behaviour. **The action reaches `checkScope` on every call that has one**, which until 2026-09-13 was true of `jobs` alone: the registrar passed no action, so a reviewer holding `["manage_pr", "manage_pr.comment"]` could `close` a pull request, and closing deletes the head branch. The registrar now reads the action off the tool's own declared argument, named per tool in `ACTION_ARG` because `lint` spells it `mode`, and `guardedWrite` names it again for every repo mutation. An unknown action on a narrowed tool is refused rather than read as the whole tool, so a call path that forgets to pass one fails closed.

The `agents` tool is admin only. An agent that could mint another could widen itself. `mint` returns a key once and stores only its sha256. `list` is the inventory, revoked rows included. `revoke` sets `revoked_at` rather than deleting, so rows an agent wrote still resolve to what it was allowed to do, while its key stops resolving immediately. `update_scopes` replaces named axes and leaves the rest.

**A runner key can be bound to one job** (`agents.job_id`, migrations/0021; `capsid/research/design-seat-session-hardening.md`). A bound key resolves only while its job is live for it: claimed by it under an unexpired lease, or queued within the 20-minute pending-start window before its first claim. Blocked, done, failed, a lapsed lease or a claim by anyone else all end it, with no revocation to remember, and a dead bound key does not fall through to `OPERATOR_KEY_HASH`. In `checkScope` it may `claim`, `heartbeat`, `complete`, `fail`, `block` and `resume` its own job only, and `list` without naming another. Every other `jobs` action is refused, including one added later. The only thing that mints one is `/ops/runner-key`, which a seat-started workflow calls with its GitHub OIDC token (`docs/seat-start.md`), and complete, fail, block, a seat fail and supersede also set `revoked_at` on it in the same batch, so `agents` action `list` shows when it stopped.

Audit rows and `jobs.claimed_by` record a minted agent as `agent:<name>`.

**Four of these have never connected, and what each is waiting for is written down so an unused credential reads as a plan rather than a loose end.** `improve_status` shows `last_seen: null` for all four today.

- `seat` is not what auto-merge uses. `capsid/policy/auto-merge.md` is signed and enabled, and the Worker merges a qualifying pull request itself on its cron tick (`src/improve/tick.ts`), on the namespaces the policy names. Version 5 names dustinedwards, capsid, carrel and capsomer; a pull request that touches a refused path, or fails any other check, waits for the seat. The seat's key is for a seat session working through `/ops/mcp`, and its `last_seen` in `improve_status` shows whether one has.
- `reviewer` is used the first time a job is posted with `review_required`, since that is the only thing that waits for a `REVIEW:` comment. No job has been posted with it yet.
- `auditor` is used by an outside model doing a cold audit, which is a thing a person starts rather than something the system reaches for.
- `watcher` is different from the other three, and its `null` means something else. The tick has no bearer token to present, so it builds a SYNTHETIC watcher identity in `src/watcher.ts` shaped to match the minted role exactly, and `touchLastSeen` returns early for an agent with no row. The minted `watcher` key is therefore unused by construction, and its `last_seen` stays `null` however many findings the tick posts. What records that work is `audit_log`, where the actor is `agent:watcher` either way. The key is there for a person driving the watcher's checks by hand from outside the Worker.

Three kinds of caller resolve, in this order:

1. **A minted agent**, matched on the sha256 of its bearer token. Checked first, so a key that is both an agent and an operator entry gets the narrower authority.
2. **A legacy operator key**, until its hash is removed from `OPERATOR_KEY_HASH` by hand.
3. **The OAuth admin session**, the synthetic agent `admin` with every scope.

The operator hash is removed once every machine runs as its folder's driver agent and the admin OAuth session is the only wider credential. That is the last step of the migration in `docs/bootstrap.md`. On this deployment it was done on 2026-09-12, when `OPERATOR_KEY_HASH` was deleted (recorded in `docs/bootstrap.md`), and the secret list read on 2026-09-25 did not contain it. On any deployment where the secret is still set, the legacy path stays live: `src/auth.ts` reads the secret on every bearer request, and `src/agents.ts` gives a plain entry the admin grant, so a key in it can still mint agents. `npx wrangler secret list --name capsid` shows whether it is set, and prints names only.

Two gated endpoints:

1. **OAuth (`/mcp`)** for human clients. The client discovers the server via `.well-known` and identifies itself by Client ID Metadata Document (CIMD): its client id is the https URL of a JSON document naming its redirect URIs, which the Worker fetches. There is no dynamic registration since the design's PR 4 (#189, merged 2026-09-28 03:50 UTC), and CIMD is advertised only while the `global_fetch_strictly_public` compatibility flag is set. Clients DCR registered before then keep their records until the 90-day TTL they were given. It then goes through `/authorize` and a one-time approval screen to Cloudflare Access for SaaS (OIDC), the app "Capsid" on the `dustinedwards.cloudflareaccess.com` team (capsid/research/design-capsid-access-login.md). Access has been the upstream since #185 merged, 2026-09-28 00:01 UTC (2026-09-27 in America/Chicago); GitHub was the upstream before.
   - **The sign-in** uses PKCE and a nonce. `src/access-jwt.ts` verifies the ID token with jose (6.2.12, pinned; the verifier the portfolio's sites share): RS256 only, against the app's `/jwks` through `createRemoteJWKSet` (a kid it does not hold refetches the keys at once, so a rotation is picked up), `iss` the app's issuer, `aud` its client id, `exp` and `nbf` on the caller's clock. A token must name a kid, whatever the key set holds. Then, checked in that file, the nonce, `email_verified` not false, and an email. The admin is still `ADMIN_EMAIL`, checked on every request.
   - **The admin check:** the email must equal `ADMIN_EMAIL` exactly (trimmed, no case folding). Any other identity gets a 403, and the check runs again on every `/mcp` request.
   - **Grants from before the switch** carry a GitHub login and no email, fail that check, and the client signs in again once.
   - **The audit actor** is `access:<email>`, since #185 (2026-09-28 00:01 UTC). Audit rows and job rows from before it name the admin as `github:<login>`, so a query for the admin's history across the switch matches both prefixes.
   - **Capsid Portal** (https://portal.dustinedwards.info, and `/portal/` on workers.dev until that is verified live) signs in through the same Access app with its own redirect URL on each host, `https://portal.dustinedwards.info/callback` and `/portal/callback` on workers.dev, both listed in the Access app, and keeps a signed twelve-hour cookie carrying the email (docs/portal.md). It signed in at `/console/callback` from the design's PR 3 (#188, merged 2026-09-28 02:37 UTC) until PR B of capsid/research/design-portal-unify.md moved it to `/portal` with no redirects; the Access app's `/console/callback` redirect URL is removed once the Portal sign-in is confirmed live. The same `ADMIN_EMAIL` check runs on every Portal request, so a cookie from the GitHub login, which carries no email, is refused and the Portal asks to sign in once. A click in the Portal is audited as `access:<email>`.
   - An admitted admin holds a full write grant.
   - **Settings:** `ACCESS_TEAM_DOMAIN`, `ACCESS_SAAS_CLIENT_ID`, `ACCESS_SAAS_CLIENT_SECRET`, `ADMIN_EMAIL`. Any unset closes the sign-in with a 503.
2. **Agent and operator keys (`/ops/mcp`)** for agents and cron, gated by sha256-hashed bearer keys. An agent key resolves to its row. Failing that, `OPERATOR_KEY_HASH` holds comma-separated hashes: a plain entry is a write key, an entry prefixed `ro:` is read-only and is denied every tool `TOOL_GRANTS` marks write: write, delete, move, restore, register_namespace, update_namespace, delete_namespace, repo writes, PR management, improve_run, agents, lint finalize, and every `jobs` action but `list`. Revoke by removing a hash; the others keep working. The OAuth library never sees this route.

Login and repo access use different credentials: the Access for SaaS app for both logins, and a GitHub App for repo access. The GitHub OAuth App that was the login before the switch was deleted on 2026-09-28, after PR 4 was live and the claude.ai connector had reconnected by CIMD, and its three secrets (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ADMIN_GITHUB_LOGIN`) were deleted from the Worker the same day. No code reads them.

`register_namespace` returns the command that mints the new namespace's driver agent, `node scripts/mint-agents.mjs --namespace <ns> --apply`. It does not mint it, and since 2026-09-13 it is admin only itself, so the separation is now belt and braces: registering a namespace and minting a credential for it are two acts by the same caller rather than one act that quietly does both.

## Tool hints and list caching

Every tool in `tools/list` carries all four annotations, from `src/tool-annotations.ts`. They are hints to a client and enforce nothing; `checkScope` is still the only gate.

- `readOnlyHint` is the negation of the write gate in `TOOL_GRANTS`, so an admin tool that only reads (`claims`) is served as not read-only.
- `destructiveHint` is true when a write can overwrite or remove existing state.
- `idempotentHint` is true for every read-only tool, and for a write only when a repeat of the same call changes nothing further (a second `delete` finds nothing and is refused). Tools that create something on every call, such as `ci_dispatch`, `open_pr` and `jobs` post, are false.
- `openWorldHint` is true when the handler reaches GitHub or Cloudflare: the repo tools, `ci_status`, `lint` (gather reads the repo tree), `jobs` (evidence checks and seat starts) and `improve_run`.

Both of the last two are stated for every tool, because the protocol reads an omitted `idempotentHint` as false and an omitted `openWorldHint` as true. `test/tool-annotations.test.ts` derives each hint from the handler source and fails in both directions.

List results carry the cache fields of MCP 2026-07-28 (`CacheableResult`), `ttlMs` and `cacheScope` (`src/cache-hints.ts`). `tools/list` is `public` for 60 seconds: every caller is served the same list, and scope refuses at call time. `prompts/list`, `resources/list`, `resources/templates/list` and `resources/read` are `private` for 60 seconds, because each is filtered to the caller's namespaces.

What the clients do with them, as of 2026-09-29:

- **Claude Code**, verified: it refreshes its tool list on `notifications/tools/list_changed`. On protocol 2026-07-28 it rejects a `tools/list` result that lacks `ttlMs` or `cacheScope` (anthropics/claude-code#88128). capsid's SDK (1.31.0) negotiates 2025-11-25, where the two fields are extra and ignored, so today they are forward-looking. Nothing shows Claude Code caching by `ttlMs`.
- **claude.ai**, unknown: nothing observed shows whether it reads the annotations, the cache fields, or either. It is known to cache the tool list from connect time, so a deploy still needs a reconnect (docs/bootstrap.md, "Verifying a deploy").
