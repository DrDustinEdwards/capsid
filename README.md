# Capsid

Capsid is a Model Context Protocol (MCP) server and control plane for AI coding agents. It runs as a single Cloudflare Worker and provides four functions to the agents that connect to it:

- a versioned knowledge base of project documents, stored in D1 and searchable by keyword and by meaning;
- a work queue of signed task descriptions, from which agents claim and complete work;
- per-agent credentials with explicit scopes, enforced at a single authorization point;
- mediated access to GitHub repositories through a GitHub App, with a record of each agent's reported outcome alongside the outcome GitHub confirms.

The repository contains the source of one production deployment, operated by its owner and the co-owners listed in `CO_OWNER_EMAILS`. It is published under the MIT licence for reference. It is not a hosted service and is not supported for third-party use; [Installation](#installation) describes how to run a separate instance.

[![The Capsid system explorer](docs/images/explorer-light.png)](https://capsid.dustinedwards.info)

*The public system explorer at [capsid.dustinedwards.info](https://capsid.dustinedwards.info), generated daily from Capsid's public data.*

## Contents

- [Architecture](#architecture)
- [Components](#components)
- [MCP tools](#mcp-tools)
- [HTTP interface](#http-interface)
- [Repository layout](#repository-layout)
- [Installation](#installation)
- [Development](#development)
- [Documentation](#documentation)
- [Licence](#licence)

## Architecture

### Runtime and storage

Capsid is written in TypeScript and deployed as one Cloudflare Worker. It uses the following bindings:

| Binding | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 | Documents, document versions, jobs, agents, namespaces, outcomes and the audit log. Full-text search uses SQLite FTS5. |
| `APP_KV` | KV | Cached GitHub installation tokens, switches and short-lived state. |
| `OAUTH_KV` | KV | OAuth grants and client registrations. |
| `MEDIA` | R2 | Daily database exports and the Markdown mirror of every document. |
| `AI_SEARCH` | AI Search | A derived semantic index of the documents, used for hybrid search. D1 remains the source of record. |
| `ASSETS` | Static assets | The built Capsid Portal (`dashboard/dist`). |

### Hosts

The Worker answers on two hosts, each restricted to its own set of paths:

- **MCP host** (`mcp.dustinedwards.info`): the MCP endpoints, OAuth sign-in, agent and operator routes under `/ops/`, and the public read-only documents. The permitted paths are listed in `src/mcp-host.ts`.
- **Portal host** (`portal.dustinedwards.info`): the Capsid Portal, the administrative web application. See `src/portal-host.ts`.

The system explorer at `capsid.dustinedwards.info` is a separate, assets-only Worker built from `explorer/`. It is prerendered from Capsid's public documents and makes no requests to Capsid at read time.

### Authentication

| Caller | Mechanism |
| --- | --- |
| Owner and co-owners, through an MCP client or the Portal | Cloudflare Access for SaaS (OIDC), issued as an OAuth access token by `@cloudflare/workers-oauth-provider`. |
| Agents and scheduled clients | A per-agent bearer key on `/ops/mcp`. Only the key's SHA-256 hash is stored. |
| Capsid, towards GitHub | A GitHub App. The Worker signs an RS256 JWT and exchanges it for a short-lived installation token; no long-lived GitHub token is stored. |

Every caller resolves to an agent record with a name, a set of scopes and an audit identity. Authorization is checked in one function, `checkScope` in `src/scope.ts`.

### Scheduled work

Three Cron Triggers are declared, and their expressions are defined once in `src/index.ts`:

| Schedule (UTC) | Task |
| --- | --- |
| `*/5 * * * *` | The tick: site watcher, auto-merge evaluation, merge-state sweep, search indexing, phone alerts, the daily email digest, and the daily build of the public model and statistics. |
| `0 9 * * *` | Database backup to R2, followed by pruning of old document versions and audit rows. |
| `30 9 * * *` | Weekly skills refresh, which runs on one configured day and posts a job when a model's prompting guide has changed. |

## Components

### Knowledge base

A document is a row in D1 identified by namespace and path, with a title, a Markdown body, a type, a status and tags. A namespace corresponds to one project and maps to one or more GitHub repositories; that mapping is also the boundary for repository access. Document types include `core`, `concept`, `decision`, `spec`, `protocol`, `procedural`, `task` and `reference` ([docs/schema.md](docs/schema.md)).

Every overwrite or delete stores the previous body in `document_versions` and writes a row to `audit_log`. Search combines FTS5 keyword matching with semantic matching from an AI Search index. The index is filled from D1 by the five-minute tick, and every semantic result is re-checked against D1 before it is returned.

### Authorization

An agent's scopes have five axes: `namespaces`, `repos`, `tools`, `grants` (read, or read and write) and `flags`. Flags control operations with a wide effect, such as merging (`can_merge`), committing directly to a default branch (`can_direct_write`), dispatching workflows (`can_dispatch`) and writing protected paths (`can_touch_protected`). A new agent receives read access to its named namespaces and no flags. Scopes that fail to parse resolve to no access. The required grant for each tool is declared in `TOOL_GRANTS` (`src/scope.ts`), and a tool absent from that table requires the write grant. See [docs/auth.md](docs/auth.md).

### Work queue

A job consists of a title and a body; the body is the complete prompt an agent executes. Bodies are signed when posted, and a claim verifies the signature first, so a body altered outside the queue's own `edit` action is rejected. The lifecycle is `post`, `claim`, then `complete`, `fail`, `block` or `resume`. A job that reaches an operation requiring a person (a push, a deploy, a secret, a live migration or a merge) is blocked with the exact command to run. Capsid assigns each job a kind and a recommended model and effort (`src/model-routing.ts`).

Capsid can start a Claude Code cloud session for a queued job by firing a saved Claude Code routine ([docs/routines.md](docs/routines.md)). When an agent completes a job, it names the pull request that carries the work. Capsid then reads that pull request from GitHub and stores the verified state beside the agent's claim, so the two can be compared ([docs/work-queue.md](docs/work-queue.md)).

### GitHub integration and merge policy

Repository tools resolve the target repository from the namespace mapping and check the resolved repository against the caller's `repos` axis ([docs/repo-access.md](docs/repo-access.md)). Agents open pull requests; merging requires the `can_merge` flag.

Automatic merging is governed by a policy document that must be signed by the administrator before it has any effect; an unsigned policy, or one edited after signing, authorizes nothing. When enabled, the tick merges only pull requests that pass every check in the policy. Certain paths, including migrations, workflows, lockfiles and authentication code, are always refused automatic merging ([docs/autonomy.md](docs/autonomy.md)). Both automatic merging and the overnight run ([docs/overnight.md](docs/overnight.md)) are disabled in a new installation.

### Capsid Portal

The Portal is a single-page application in `dashboard/`, served by the Worker as static assets and restricted to the administrator's Cloudflare Access session. It presents items awaiting the owner, site health, the job queue, open pull requests, deploys, agents, activity and backups, and exposes the administrative controls defined in `src/controls.ts` ([docs/portal.md](docs/portal.md)).

![The Portal Health view, rendered from sample data](docs/images/health-light.png)

*Portal Health view, rendered from sample data.*

![The Portal job queue with a job's detail drawer open, rendered from sample data](docs/images/queue-drawer-light.png)

*Portal job queue with a job's detail drawer open, rendered from sample data.*

### Site monitoring

The watcher, which runs on the tick, reads each registered site's health route, CI status, deploys and live responses ([docs/health-format.md](docs/health-format.md), [docs/live-checks.md](docs/live-checks.md)). Search performance is read from Google Search Console and Bing Webmaster Tools ([docs/search-console.md](docs/search-console.md), [docs/bing-webmaster.md](docs/bing-webmaster.md)).

### Session telemetry

Claude Code sessions can send hook events to `/ops/hooks` and OpenTelemetry metrics to `/ops/otlp/v1/*`. Capsid keeps per-session summaries and per-job cost and token totals; it does not store prompts, responses or tool content ([docs/hooks.md](docs/hooks.md), [docs/telemetry.md](docs/telemetry.md)).

### Public data

Once a day the Worker builds a public system model and a set of aggregate statistics, after a privacy filter, and serves them without authentication ([docs/public-data.md](docs/public-data.md)). Current figures are available at [mcp.dustinedwards.info/public/stats/v1.json](https://mcp.dustinedwards.info/public/stats/v1.json). The system explorer is built from these documents ([explorer/README.md](explorer/README.md)).

### Backups and recovery

D1 Time Travel provides 30-day point-in-time recovery. In addition, the daily backup writes one JSON export per table and a Markdown mirror of every document to R2, and the exports are mirrored to a private repository outside the Cloudflare account. A scheduled workflow rehearses a restore ([docs/backups.md](docs/backups.md)). Rolling back a faulty deploy is described in [docs/rollback.md](docs/rollback.md).

## MCP tools

Capsid serves 22 tools over two MCP servers. The count is derived from `TOOL_GRANTS` by `src/counts.ts`, and the registrations are in `src/tools/surface.ts`. Most tools take an `action` argument that selects one operation.

**Capsid** (`/mcp`, `/ops/mcp`): 14 tools for project work.

| Tool | Grant | Function |
| --- | --- | --- |
| `capsid_start_session` | read | Session briefing for a namespace. |
| `capsid_find_docs` | read | List, glob or full-text search documents; list reachable namespaces. |
| `capsid_read_doc` | read | Read a document, its versions or its edges. |
| `capsid_write_doc` | write | Create, change, restore or move a document. |
| `capsid_delete_doc` | write | Delete a document, retaining its last version. |
| `capsid_lint_namespace` | per action | Gather, finalize and report on a namespace's documents ([docs/consolidation.md](docs/consolidation.md)). |
| `capsid_read_repo` | read | List directories, read files and search code in a mapped repository. |
| `capsid_inspect_repo` | read | Branches, tags, pull requests, history, CI runs, live site checks and search-console data. |
| `capsid_change_repo` | write | Write or delete a file, or create a branch. |
| `capsid_open_pr` | write | Open a pull request or comment on one. |
| `capsid_close_pr` | write | Merge or close a pull request, delete a branch, tag a commit or publish a release. |
| `capsid_run_ci` | write | Dispatch a workflow or rerun failed jobs. |
| `capsid_work_jobs` | per action | The work queue lifecycle. |
| `capsid_run_improve` | read | Capsid status per namespace: queue, breaker, maintenance and items awaiting the owner. The name is retained from a removed feature. |

**Capsid Admin** (`/mcp/admin`, `/ops/mcp/admin`): 8 tools, available to the administrator identity only.

| Tool | Grant | Function |
| --- | --- | --- |
| `capsid_admin_whats_next` | admin read | Items awaiting the owner across every namespace. |
| `capsid_admin_manage_namespaces` | admin | Register, remap or delete a namespace. |
| `capsid_admin_manage_agents` | admin | Mint, revoke and re-scope agent credentials. |
| `capsid_admin_read_claims` | admin read | Agent claims beside verified outcomes. |
| `capsid_admin_read_ops` | admin read | Watcher state, Cloudflare Access and Email Routing configuration, Workers Builds. |
| `capsid_admin_run_controls` | admin | Preview and perform administrative controls with a single-use token. |
| `capsid_admin_control_improve` | admin | Operator keys, policy signing, the job breaker and the overnight switch. |
| `capsid_admin_set_site_key` | admin | Mint a site key and install it on the site Worker. |

Adding a tool requires a recorded ruling (CLAUDE.md, rule 1).

## HTTP interface

The router is `defaultHandler` in `src/routes.ts`. The principal routes are:

| Route | Authentication | Purpose |
| --- | --- | --- |
| `POST /mcp`, `POST /mcp/admin` | OAuth | MCP over Streamable HTTP for the owner and co-owners. |
| `POST /ops/mcp`, `POST /ops/mcp/admin` | Bearer key | MCP for agents and scheduled clients. |
| `/authorize`, `/callback`, `/token`, `/register`, `/.well-known/*` | None | OAuth sign-in and discovery. |
| `POST /ops/hooks`, `POST /ops/otlp/v1/*` | Bearer key | Claude Code hook events and telemetry. |
| `GET /ops/inbox`, `POST /ops/inbox/report` | Bearer key | Items awaiting the owner, per application. |
| `GET /health` | None | Deploy provenance and a store probe; returns 503 when D1 or FTS5 fails. |
| `GET /public/model/v1.json`, `/public/stats/v1.json`, `/public/code/v1.json` | None | Public system model, statistics and code maps. |
| `/portal/*` | Access session | The Capsid Portal and its API. |

The complete list, including signed backup and benchmark routes, is in [docs/auth.md](docs/auth.md#endpoints).

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | Worker source. `index.ts` is the entry point; `tools/` holds the MCP tool surface. |
| `migrations/` | D1 schema migrations, applied in order. |
| `dashboard/` | The Capsid Portal (Vite) and its Playwright tests. |
| `explorer/` | The public system explorer, a separate assets-only Worker. |
| `system/` | The hand-written public system model and its JSON Schema. |
| `scripts/` | Deploy, agent minting, backup and verification scripts. |
| `test/` | Unit tests and lint checks. |
| `test-integration/` | Integration tests run in workerd through `@cloudflare/vitest-plugin`. |
| `docs/` | Reference documentation. `docs/policy/` holds the reviewable copies of the signed policies. |
| `wrangler.jsonc.example` | Template for the Worker configuration. The real `wrangler.jsonc` is not committed. |

## Installation

An installation requires a Cloudflare account and a GitHub App. The procedure is given in full in [docs/bootstrap.md](docs/bootstrap.md), section 10. In outline:

1. Install dependencies with `npm install`. Node.js 26.11.1 or later is required.
2. Create a D1 database, two KV namespaces and an R2 bucket with Wrangler.
3. Copy `wrangler.jsonc.example` to `wrangler.jsonc` and enter the resource identifiers. `APP_KV` and `OAUTH_KV` must be different namespaces.
4. Apply the migrations: `npx wrangler d1 migrations apply capsid --remote`.
5. Create a Cloudflare Access for SaaS (OIDC) application and a GitHub App, and set the required secrets.
6. Run `npm run check` and `npm run deploy`.
7. Add `https://<worker-host>/mcp` as a custom connector in the MCP client.

`wrangler.jsonc`, `.dev.vars`, `.env`, keys and real document content must never be committed. Optional features, including site monitoring, Cloudflare reads, phone alerts and automatic merging, remain inactive until configured.

## Development

| Command | Purpose |
| --- | --- |
| `npm run check` | Type-check the Worker. |
| `npm test` | Unit tests. |
| `npm run test:integration` | Integration tests in workerd. |
| `npm run lint` | Lint checks, including documentation drift. |
| `npm run build:dashboard` | Build the Portal and enforce its size budget. |
| `npm run test:browser` | Portal browser tests (Playwright). |
| `npm --prefix dashboard run dev` | Serve the Portal locally against sample data. |
| `EXPECT_SHA=<sha> npm run verify:live` | Verify the deployed Worker. |

The full pre-push sequence is in [docs/bootstrap.md](docs/bootstrap.md#12-checks-before-a-push). Continuous integration runs these checks on every pull request, and a merge to `master` deploys to production.

## Documentation

**Setup and access**

- [docs/bootstrap.md](docs/bootstrap.md): installation, agent minting, switches and pre-push checks.
- [docs/auth.md](docs/auth.md): authentication, scopes, roles, co-owners and endpoints.
- [docs/repo-access.md](docs/repo-access.md): the GitHub App and repository resolution.
- [docs/hooks.md](docs/hooks.md): Claude Code hook events.
- [docs/telemetry.md](docs/telemetry.md): session and job telemetry.

**Jobs and agents**

- [docs/work-queue.md](docs/work-queue.md): the job lifecycle, signing and recorded evidence.
- [docs/routines.md](docs/routines.md): starting cloud sessions through routines.
- [docs/autonomy.md](docs/autonomy.md): automatic merging and pre-approved gates.
- [docs/overnight.md](docs/overnight.md): the overnight plan and morning digest.
- [docs/bench.md](docs/bench.md): the paired comparison run in capsid-bench.

**Sites and public data**

- [docs/portal.md](docs/portal.md): the Capsid Portal.
- [docs/health-format.md](docs/health-format.md): the health route format.
- [docs/live-checks.md](docs/live-checks.md): checks against deployed sites.
- [docs/search-console.md](docs/search-console.md): Google Search Console data.
- [docs/bing-webmaster.md](docs/bing-webmaster.md): Bing Webmaster Tools data.
- [docs/public-data.md](docs/public-data.md): the public model, statistics and code maps.
- [explorer/README.md](explorer/README.md): the system explorer.

**Data and recovery**

- [docs/schema.md](docs/schema.md): document types and database tables.
- [docs/consolidation.md](docs/consolidation.md): namespace maintenance and destructive writes.
- [docs/backups.md](docs/backups.md): backup contents and restore procedure.
- [docs/rollback.md](docs/rollback.md): reverting a deploy.

## Licence

MIT. See [LICENSE](LICENSE). Citation metadata is in [CITATION.cff](CITATION.cff).
