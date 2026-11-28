# Auth model

Every caller resolves to an agent: a name, a set of scopes, and its own audit identity. There is one enforcement point, `checkScope` in `src/scope.ts`. The registrar wraps every tool registration before any tool module runs, so a tool is covered by existing, and `TOOL_GRANTS` states what each tool requires.

Scopes are five axes. `namespaces` and `repos` are a list or `*`. `tools` is an allow list or `*`. `grants` is read, or read and write. `flags` are the blast radius:

| flag                  | what it gates                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `can_merge`           | merging or closing a pull request (close deletes the head branch, the same destruction), `capsid_close_pr` action `delete_branch` with `force: true` (force lifts the open-PR refusal), and actions `tag` and `release` (a tag or release can start a deploy as a merge can) |
| `can_touch_protected` | writing or deleting an autonomy policy document under `capsid/policy/` (`allow_policy_paths`), which decides what this Worker does without a human                                                                                                                           |

A stored scopes JSON that names a retired flag or `max_claims` still loads; the extra field is ignored and dropped the next time the scopes are written.

A new agent gets read on its named namespaces and no flags. Scopes are stored as JSON and the parse fails closed: a null, truncated or wrong-shaped column resolves to no namespaces, no tools, no grants and no flags.

**The `repos` axis is set per driver, and editing the mapping is admin work.** A driver minted with `repos: "*"` could remap its own namespace onto any repo and then read and write it, since `allowsScope("*", v)` can never refuse. So:

- Registering, re-mapping and deleting a namespace (`capsid_admin_manage_namespaces` actions `register`, `update`, `delete_preview` and `delete_perform`) are `admin` in `TOOL_GRANTS`. A driver that needs a namespace mapped asks for it. Delete never touches a live agent: it is refused until the agent is revoked or re-scoped ([schema.md](schema.md), "Deleting a namespace").
- A driver is minted with `repos` set to its namespace's mapped repos, read from the live mapping (`src/agents-admin.ts`). A namespace that maps to nothing refuses the mint rather than falling back to the wildcard.
- **The axis is asked about the resolved repo, not the `repo` argument**, which is a selector (a label, or an owner/name, or omitted for the default). Every repo tool resolves first and asks about the result, reads included.

**Every caller may read the portfolio documents in capsid, and nothing else there**: the one exception to the namespaces axis, stated in `PORTFOLIO_DOCS` (`src/portfolio-docs.ts`) and checked in `checkScope`, so a driver scoped to its own namespace can follow the conventions and rulings every repo's CLAUDE.md names:

- The paths: `conventions.md`, `core.md`, and `rulings/<name>.md` one level deep. A path must be lowercase letters, digits, `.`, `-`, `_` and `/` with no `..` and no empty segment, so `rulings/../policy/gates.md`, `Rulings/x.md`, `rulings/%2e%2e/x.md`, `rulings-secret/x.md` and `rulings/a/b.md` are all refused.
- The tools: `capsid_read_doc` action `read`, which must name one of those paths, and `capsid_find_docs` actions `list`, `glob` and `search` with `namespace: "capsid"`, whose handlers keep only those paths for such a caller. Omitting the namespace is still refused to a narrowed caller.
- Not covered: every other capsid path, `capsid_start_session`, `capsid_read_doc` actions `versions` and `links`, and every write tool. Versions and links stay out because a version list or an edge can name a capsid path that is not on the list. The `capsid://` resources stay scoped as before.
- `capsid_start_session` for any namespace returns `portfolio_documents`: the paths above that exist, so a session reads them first.

### Roles

Each role is a single capability, not a bundle. `ROLES` in `scripts/roles.ts` holds every row below that is not a driver or the seat. The admin mints each with `capsid_admin_manage_agents` action `mint` ([bootstrap.md](bootstrap.md)). A test fails if a role names a second blast-radius flag.

| role          | reads                                                                                                                                                | writes                                | flag                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------- |
| `<ns>-driver` | its own namespace                                                                                                                                    | its own namespace, pull requests only | none by default; two exceptions below |
| `auditor`     | every namespace and repo                                                                                                                             | nothing at all                        | none                                  |
| `seat`        | every namespace                                                                                                                                      | every namespace                       | `can_merge`                           |
| `site-seat`   | `dustinedwards`                                                                                                                                      | `dustinedwards`                       | `can_merge`                           |
| `live-probe`  | `capsid`, through the `capsid_read_doc` tool only                                                                                                    | nothing at all                        | none                                  |
| `live-check`  | `capsid`, through the `capsid_read_doc` tool only; devkit's daily AI and MCP check, its key the `MCP_TEST_GRANT_MCP_DUSTINEDWARDS_INFO` secret there | nothing at all                        | none                                  |

**A project driver holds no blast-radius flag by default, and two hold one:** `capsid-driver` and `claude-skills-driver` hold `can_touch_protected`. `capsid_read_status` action `status` and the Portal list the flags each agent actually has. Widening one is `capsid_admin_manage_agents` action `update_scopes`, which is admin only and audit-logged with the scopes before and after.

The tools axis can narrow a grant: an entry can name an action, `capsid_close_pr.delete_branch` or `capsid_lint_namespace.gather`, and a list naming at least one action of a tool is narrowed to those. A bare tool name with no qualified sibling still means the whole tool and `*` allows everything. The registrar reads the action off the tool's declared argument (`ACTION_ARG`; `capsid_lint_namespace` spells it `mode`), and `guardedWrite` names it again for every repo mutation. An unknown action on a narrowed tool is refused.

The `capsid_admin_manage_agents` tool is admin only. An agent that could mint another could widen itself. `mint` returns a key once and stores only its sha256, and the key resolves nothing until Dustin clicks Activate on the agent's drawer in the Portal (the Portal-only `activate_agent` control, `agents.pending`): every project thread is the admin and can mint, so a mint a thread was talked into reaches nothing. `list` is the inventory, revoked rows included. `revoke` sets `revoked_at` rather than deleting, so rows an agent wrote still resolve to what it was allowed to do, while its key stops resolving immediately. `update_scopes` replaces named axes and leaves the rest.

**A revoked agent is archived, not deleted** (`src/agents-archive.ts`). The watcher pass archives it in place 7 days after revocation (`agents.archived_at`, `archive_reason` and `audit_rows`): the row is stamped with the count of its audit rows, and an `agents.archive` audit row is written by `agent:watcher`. Every audit row carries the actor string `agent:<name>` itself, so none needs the agents row. An archived row is still revoked, so a mint refuses its name and its key is refused. `capsid_admin_manage_agents` action `list` with `archived: true` returns the archive; `capsid_read_status` action `status` lists the 50 newest moves after the live rows. The Portal's Agents roster shows live agents only and its Archive tab the revoked and archived.

A routine's cloud session reaches Capsid with the cloud-driver key from the network secret.

Audit rows record a minted agent as `agent:<name>`.

The `seat` is not a merge path: a pull request merges on green, by the session that opened it or by GitHub auto-merge.

Two kinds of caller resolve:

1. **A minted agent**, matched on the sha256 of its bearer token.
2. **The OAuth admin session**, the synthetic agent `admin` with every scope. It is the only admin identity: no key is the admin, so minting an agent is always the admin's OAuth session.

Three gated MCP endpoints, two servers. Capsid (10 tools) is served on `/mcp` and `/ops/mcp`; Capsid Admin (5 tools, every name starting `capsid_admin_`) is served on `/mcp/admin` and nowhere else, so a client connects to it as a separate connector.

1. **OAuth (`/mcp`)** for human clients. The client discovers the server via `.well-known` and identifies itself by Client ID Metadata Document (CIMD): its client id is the https URL of a JSON document naming its redirect URIs. Grok and Gemini cannot send one, so `POST /register` is a tightened Dynamic Client Registration (site-runtime's `registrationLimited` and `registrationRefusal`, `src/index.ts`) on the MCP host only. Every redirect URI a registration names must be on the allowlist, matched exactly: Grok's and ChatGPT's legacy callbacks are fixed in code, and the per-connector callbacks Gemini and ChatGPT issue are listed in the `DCR_REDIRECT_URIS` var (comma separated). Registration is rate limited (5 an hour per address, 30 a day overall), refuses when the limit cannot be read, and grants nothing: the client still meets the consent page on its first `/authorize` and the Access sign-in. Every token is bound to its host's resource (RFC 8707) and refused at any other, and the API handler checks the audience again with site-runtime's `audienceRefusal`. The protected resource metadata lists `capsid.read` and `capsid.write` while the 401 challenge names `capsid.read` alone, so a client asks for the least first. A tool the token's grant cannot call is not served to it at all (`toolListed`), so a read grant calling a write tool gets an unknown tool. An action that needs more than the token holds (`TOOL_GRANTS` through `declaredScope`, `src/scope.ts`) is answered `403 insufficient_scope` naming every scope it needs, before the tool runs, so the client can step up (site-runtime's `toolScopeChallenge`); a key on `/ops/mcp` carries no token and is refused in words. Every tool call also passes site-runtime's `authorizeCall` before `checkScope`. `npm run check:conformance` runs the official MCP conformance suite against this door in CI. The live gate's probe client document is served by the Worker at `/oauth/clients/verify-live.json` (`src/oauth-client-docs.ts`), a path that names no branch; a 404 there fails the deploy's gate. Sign-in then goes through `/authorize` and the consent page (site-runtime's `loginHandler`: shown on every sign-in, `capsid.write` granted only when "Allow changes" is ticked) to Cloudflare Access for SaaS (OIDC), the app "Capsid" on the `dustinedwards.cloudflareaccess.com` team.
   - **The sign-in** uses PKCE and a nonce. site-runtime's `access-login` (`finishSignIn`, called from `src/access-login.ts`) verifies the ID token with jose: RS256 only, against the app's `/jwks` (an unknown kid refetches the keys, so a rotation is picked up), `iss` the app's issuer, `aud` its client id, `exp` and `nbf`, a kid, the nonce, `email_verified` not false, and an email.
   - **The admin check:** the email must equal `ADMIN_EMAIL` or an entry of `CO_OWNER_EMAILS` (comma separated, trimmed and lower-cased, empty entries ignored; site-runtime's `isAdminEmail`). Any other identity gets a 403, and the check runs again on every `/mcp` request. A co-owner is audited as `access:<her email>` and cannot change `ADMIN_EMAIL` or `CO_OWNER_EMAILS`, which are set only in Cloudflare.
   - **The audit actor** is `access:<email>`. Rows from before 2026-09-28 name the admin `github:<login>`, so a query for the admin's history across that date matches both prefixes.
   - **Capsid Portal** signs in through the same Access app with its own redirect URL, `https://portal.dustinedwards.info/callback`, and keeps a signed 24-hour cookie carrying the email, ended after an hour with no request ([portal.md](portal.md)). The same admin check runs on every Portal request.
   - An admitted admin holds a full write grant.
   - **Settings:** `ACCESS_TEAM_DOMAIN`, `ACCESS_SAAS_CLIENT_ID`, `ACCESS_SAAS_CLIENT_SECRET`, `ADMIN_EMAIL`. Any unset closes the sign-in with a 503. Optional: `CO_OWNER_EMAILS`.
2. **Agent keys (`/ops/mcp`)** for agents and cron, gated by sha256-hashed bearer keys. A key resolves to its agent row, with that row's scopes. A read-grant agent is denied every tool or action `TOOL_GRANTS` marks write: `capsid_write_doc`, `capsid_delete_doc` and `capsid_close_pr` are not in its `tools/list` at all, and `capsid_lint_namespace` finalize and report are refused by name. Revoke with `capsid_admin_manage_agents` action `revoke`. The OAuth library never sees this route.
3. **Capsid Admin (`/mcp/admin`)** for the admin alone: the OAuth route above, with the same Access sign-in and the same `ADMIN_EMAIL` or `CO_OWNER_EMAILS` check on every request. There is no bearer-key route to it: no minted key is the admin. Every Capsid Admin tool is `admin` or `admin_read` in `TOOL_GRANTS`, so a scoped agent is refused it whatever route it reaches. `capsid_admin_read_ops` and `capsid_admin_whats_next` are `admin_read`: the admin identity and the read grant, served read-only.
   - **Step-up.** A grant lives for weeks and is refreshed without a person, so the risky admin actions also need a recent Access sign-in (`STEP_UP`, `STEP_UP_IDLE_MS` and `STEP_UP_MAX_MS` in `src/scope.ts`): a sliding window. The action is allowed when the Access sign-in or the last successful step-up action was within 2 hours, and never more than 12 hours after the sign-in. The last step-up time is kept per session in `APP_KV` (`step-up:last:<actor>:<sign-in time>`), so activity in one session never keeps another inside the window. An unreadable entry, or one later than now, is treated as absent, so a KV failure can only narrow access. A step-up action that errors or answers `ok: false` does not reset the clock. Only the MCP admin tools enforce it; the Portal's controls do not. The actions: `capsid_admin_manage_namespaces` actions `register`, `update` and `delete_perform`, `capsid_admin_manage_agents` actions `mint`, `revoke` and `update_scopes` and `capsid_admin_run_controls` action `perform`. An older or idle session is refused with `step-up required` and nothing is done; reconnecting the Capsid Admin connector (disconnect, connect, sign in) starts a fresh one. It is a re-authentication, not a mid-call confirmation. Only an OAuth session carries a sign-in time.

Login and repo access use different credentials: the Access for SaaS app for both logins, and a GitHub App for repo access.

`capsid_admin_manage_namespaces` action `register` returns the instruction that mints the new namespace's driver agent: `capsid_admin_manage_agents` action `mint` with name `<ns>-driver`, kind `driver`, its namespace and read and write. It does not mint it: registering a namespace and minting a credential for it are two acts.

## Tool hints and list caching

Every tool in `tools/list` carries all four annotations, from `src/tool-annotations.ts`. They are hints to a client and enforce nothing; `checkScope` is still the only gate.

- `readOnlyHint` is true when every action of the tool needs only the read grant in `TOOL_GRANTS` and `TOOL_ACTION_GRANTS`: `read`, or `admin_read` for an admin tool that only reads (`capsid_admin_read_ops`, `capsid_admin_whats_next`).
- `destructiveHint` is true when a write can overwrite or remove existing state.
- `idempotentHint` is true for every read-only tool, and for a write only when a repeat of the same call changes nothing further (a second `capsid_delete_doc` finds nothing and is refused). Tools that create something on every call, such as `capsid_admin_manage_agents` (its `mint`), are false.
- `openWorldHint` is true when the handler reaches GitHub or Cloudflare: the repo tools, `capsid_inspect_repo` (CI runs and the live site check among them), `capsid_lint_namespace` (gather reads the repo tree), `capsid_admin_read_ops` (Cloudflare and the watcher's site probes), and `capsid_admin_whats_next`.

All four are stated for every tool, because the protocol reads an omitted `idempotentHint` as false and an omitted `openWorldHint` as true.

All four MCP endpoints speak MCP 2026-07-28 through `@modelcontextprotocol/server` 2 and `agents` (`src/mcp-handler.ts`), stateless, with `server/discover` and no session. A client that opens with `initialize` is served the 2025-11-25 era by site-runtime's `routeMcpEra`, until the clients that reach Capsid open with `server/discover`. Each caller is limited to 30 calls a minute (`checkRateLimit`, failing closed), and every tool call is logged to the `ToolCallLog` Durable Object, refused, started and finished (canceled when the client left), beside the D1 `audit_log` the Portal reads (`src/scope.ts`). The 09:00 UTC run copies new log rows to the `capsid-mcp-tool-calls` R2 bucket (`AUDIT_BUCKET`, a 365-day lock rule on `tool-calls/`) and prunes copied rows after 90 days; `/health`'s `tool-call-log` check warns on a call that never finished, a spike, or rows uncopied for two days.

A tool with a read action (`capsid_lint_namespace`) is served to every grant; to a caller holding only the read grant it is served with its read actions alone (`gather`; `READ_VIEWS` in `src/tools/surface-composite.ts`) and annotated read-only, so every tool a read grant lists is read-only, and a write action asked for is refused by name. Every tool's input schema is closed (`additionalProperties: false`, nested objects included), so an argument no action takes is refused, never dropped. Each tool carries the server's icon. A call's abort signal reaches every outbound request it makes (`src/call-signal.ts`), so a client that closes the call stops its GitHub and Cloudflare requests. A result of `capsid_read_repo` or `capsid_inspect_repo` (repository files, pull requests, CI logs) is marked as outside data with site-runtime's `outsideResult`.

On protocol 2026-07-28 the cacheable results carry `ttlMs` and `cacheScope`, set by the SDK's `cacheHints` server option (site-runtime's `mcpCacheHints`, `src/server.ts`); a 2025-11-25 response never carries them. `server/discover` is `public` for 60 seconds. `tools/list` is `private` for 60 seconds, because it depends on the caller's grant, and so are `prompts/list`, `resources/list`, `resources/templates/list` and `resources/read`, because each is filtered to the caller's namespaces.

Claude Code refreshes its tool list on `notifications/tools/list_changed`, and on protocol 2026-07-28 rejects a `tools/list` result that lacks `ttlMs` or `cacheScope` (anthropics/claude-code#88128); the live probe refuses a deploy that omits them. claude.ai caches the tool list from connect time and what it does with the annotations and cache fields is unknown, so a deploy still needs a reconnect ([bootstrap.md](bootstrap.md), "Verifying a deploy").

## Co-owner

A second person can hold the same access as the administrator. Her email goes in the optional Worker secret `CO_OWNER_EMAILS` (comma separated for more than one; each entry trimmed and lower-cased, empty entries ignored, the same check as `ADMIN_EMAIL`). Unset or empty means no co-owners, and while `ADMIN_EMAIL` is unset nobody is admitted, a co-owner included.

- She is admitted to `/mcp`, `/mcp/admin` and the Portal like the administrator. Every audit row, actor and "signed in as" carries the email Access verified for her, `access:<her email>`, never `ADMIN_EMAIL`.
- The step-up applies to her exactly as to the administrator, on her own sign-in and her own idle clock.
- `ADMIN_EMAIL` stays the primary owner and is set only in Cloudflare. No Capsid tool, Portal action or sync can change it, `CO_OWNER_EMAILS` or who is admitted, so a co-owner cannot remove or demote the primary owner from inside Capsid. The push alerts' VAPID subject stays `ADMIN_EMAIL`.
- To add her: in the Cloudflare dashboard, Workers & Pages, capsid, Settings, Variables and Secrets, add `CO_OWNER_EMAILS` as a Secret (Type: Secret, not Text) holding her email. The Access policies that admit the admin (the Capsid app and the apps behind Access) must list her email too, or Access refuses her before Capsid is asked.

## Access drift check

`.github/workflows/access-drift.yml` runs devkit's daily drift check: it reads who the Access for SaaS application `capsid-login` lets in and compares them with `ADMIN_EMAIL` plus `CO_OWNER_EMAILS`, so an address taken off one and not the other is found the next morning. The list comes from the Worker, hashed with a fresh salt, at `https://portal.dustinedwards.info/admin/access-drift` (site-runtime's `adminListResponse`, `src/index.ts`), so GitHub holds no copy of it. Only a GET carrying an Access service token for that path is answered; everything else is 404.

The Portal signs people in through Access for SaaS, so no Access application stands in front of it, and that path needs its own. Set up once in Zero Trust: Applications, add a Self-hosted application `capsid-drift-list` for `portal.dustinedwards.info`, path `admin/access-drift`, with one policy, action **Service Auth**, Include Service Token `access-drift`; copy its Application Audience (AUD) tag into the Worker variable `ACCESS_DRIFT_AUD`. `access-drift` is the one service token every site's drift check shares, so it is never created again per site. To get a new secret, rotate it (Service credentials, the token's menu, Rotate secret, keeping the old secret valid for a day) and set `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` in every repo that runs the check. Then add the repository secrets `ACCESS_READ_TOKEN` (Access: Apps and Policies Read, and Zero Trust Read; one API token shared by every repo), `CLOUDFLARE_ACCOUNT_ID`, `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET`. Until all four are set the job fails, by design.

## Repo mutations and the audit trail

Every write to GitHub goes through `guardedWrite` (`src/tools/repo-guards.ts`). It resolves the repo the call actually reaches, asks `checkScope` about that repo with the flags the call's intent needs, runs the write, and then writes an `audit_log` row. GitHub cannot join a D1 transaction, so if that audit insert fails after the write landed, the result reports the write as done with an `audit_warning` rather than as a failure (`test/blast-radius.test.ts` covers the rule).

Every overwrite and delete of a document snapshots the prior version to `document_versions` and writes `audit_log` (`test/invariants.test.ts`, `test/write-invariants.test.ts`). These tables are not kept forever in D1: after each daily backup, `document_versions` rows older than 90 days and `audit_log` rows older than 365 days are pruned, and they survive only in retained dumps (docs/backups.md).

The minted roles each hold at most one blast-radius flag, and `test/roles.test.ts` fails the build if a role names a second. Two project drivers hold a flag by a recorded exception; the Portal and `capsid_read_status` action `status` list what each agent actually holds.

## What Capsid cannot control

- The admin's own session. The OAuth admin is a synthetic agent with every scope, so a client holding that login on Dustin's machine is not narrowed by `checkScope`, and his own shell can push, deploy or run `wrangler` without Capsid.
- Client-side tool caching: a deploy is verified by calling the Worker directly.
- Tool annotations are hints to the client and enforce nothing.
- The Access session at the team domain is Cloudflare's. Portal sign-out ends the Portal session on the server (its session id in D1 `portal_session_ends`), a copied cookie included, and the idle end sends the browser to Access's logout as well.

## Endpoints

The router is `defaultHandler` in `src/routes.ts`, behind the OAuth provider and the host rules in `src/index.ts`. On the MCP host (`mcp.dustinedwards.info`) only the paths in `src/mcp-host.ts` answer; the Portal host serves the Portal and nothing else (`src/portal-host.ts`). Each route's auth is also stated in `src/scope.ts`.

MCP and sign-in:

- `POST /mcp` and `POST /mcp/admin` MCP over Streamable HTTP, requires an OAuth access token (the admin and any co-owner only)
- `POST /ops/mcp` MCP over Streamable HTTP for agents and cron, requires an agent key as `Authorization: Bearer <key>`
- `GET /authorize`, `POST /authorize`, `GET /callback` the MCP sign-in, through Cloudflare Access for SaaS
- `GET /owner`, `POST /owner/revoke`, `POST /owner/sign-out` the owner page (site-runtime's `./owner-page`, mounted by `loginHandler`): the same Access sign-in and admission as consent, through the same `/callback`; it lists the signed-in person's grants with Revoke, the agent keys and the tool-call log, newest first
- `POST /token` token exchange (served by the library)
- `POST /register` tightened dynamic client registration for Grok and Gemini, MCP host only, rate limited, grants nothing (`src/index.ts`, above). Claude and ChatGPT use a Client ID Metadata Document instead
- `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` discovery metadata (served by the library)
- `GET /oauth/clients/verify-live.json` the live gate's probe client document (`src/oauth-client-docs.ts`)

Agents (`/ops/`):

- `GET /ops/inbox` what needs Dustin, per app: failing CI, a site that is down, and what the app reported about itself. Read by an app's server with a bearer key; a key scoped to one namespace sees that app only, a key on every namespace sees every app, and the response carries no CORS headers ([portal.md](portal.md))
- `POST /ops/inbox/report` what an app reports about itself to the inbox (Carrel's drafts waiting), with its own key and the write grant on its namespace; replaced whole, expires after 6 hours, one per minute per key ([portal.md](portal.md))

Backups (signed, no bearer; [backups.md](backups.md)):

- `POST /backup/credential` mints the read credential the off-account copy uses, and `POST /backup/offaccount-report` receives its report

Public (no auth):

- `GET /health` in the family shape ([health-format.md](health-format.md)). It reports the git sha and probes the store: `SELECT 1` against D1 plus an FTS5 MATCH pinned to one known document. Either failing returns 503 with `status: "fail"` and a `store` object naming which. The backup, MEDIA, APP_KV, OAUTH_KV and the task ledger only warn.
- `GET /public/model/v1.json`, `/public/stats/v1.json`, `/public/code/v1.json` and `/public/versions/v1.json`: the stored public documents, edge-cached, limited per IP, no CORS ([public-data.md](public-data.md)).
- `POST /csp-report`: CSP and COOP violation reports, received by site-runtime's `receiveCspReport`: always 204, the body read to 16 KB, at most ten violations logged with every URL cut to origin and path, nothing stored. A limited caller, or one the limiter cannot count, has its report dropped.

Capsid Portal (admin Access session only; a request with any `Authorization` header is refused with 403; [portal.md](portal.md), "Routes"):

- `GET /portal/` the app, and `GET /portal/callback` its sign-in return
- `GET /portal/api/ops` the feed, and `POST /portal/api/ops/refresh` an on-demand watcher pass (header `X-Capsid-Ops: refresh`, once per two minutes)
- `POST /portal/api/actions/preview` and `POST /portal/api/actions/perform` the controls as a preview and a perform (header `X-Capsid-CSRF`)
- `GET /portal/api/` reads: see [portal.md](portal.md), "Routes"
- `GET` and `POST /portal/api/push` phone alerts, and `POST /portal/api/sign-out`
- Any other path under `/portal/api/` is a JSON 404
