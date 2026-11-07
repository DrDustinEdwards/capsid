# Bootstrap

What it takes to stand this up, and what to check before a push. Written for a stranger with a Cloudflare account and a GitHub org.

## 1. Configuration

The real `wrangler.jsonc` is gitignored and a fresh clone has none. Copy the
example and fill in the ids:

```
cp wrangler.jsonc.example wrangler.jsonc
```

Everything a fresh clone needs to typecheck and test works without it: types come
from `@cloudflare/workers-types` in `node_modules` rather than from generated
bindings. Only `wrangler dev` and `wrangler deploy` need the real file.

## 2. Bindings

| binding    | kind | why it is separate                                  |
| ---------- | ---- | --------------------------------------------------- |
| `DB`       | D1   | documents, versions, links, audit log, jobs, agents |
| `APP_KV`   | KV   | the Worker's own bookkeeping: caches, counters      |
| `OAUTH_KV` | KV   | the OAuth provider's clients, grants and tokens     |
| `MEDIA`    | R2   | backups, the markdown mirror, the report sink       |

The two KV namespaces are separate. They shared one for a while,
which meant the Worker's caches lived in the same keyspace as the provider's
tokens.

`MEDIA` is the one bucket.

Resolve by name, verify by id. Assert the resolved id equals a pinned value
rather than trusting the name. A name is not an identity. A Worker pointed at
nothing starts fine and answers healthy while every read errors.

## 3. Secrets

```
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # the .pem contents
npx wrangler secret put ACCESS_TEAM_DOMAIN       # https://<team>.cloudflareaccess.com, the MCP and Capsid Portal logins (docs/auth.md)
npx wrangler secret put ACCESS_SAAS_CLIENT_ID    # the Access for SaaS app "Capsid"
npx wrangler secret put ACCESS_SAAS_CLIENT_SECRET
npx wrangler secret put ADMIN_EMAIL              # the primary owner's email, admitted by both logins, exactly
npx wrangler secret put CO_OWNER_EMAILS          # optional: co-owners, comma separated, admitted like ADMIN_EMAIL (docs/auth.md, "Co-owner")
npx wrangler secret put COOKIE_ENCRYPTION_KEY    # openssl rand -hex 32; signs the login state and the Portal cookie and confirm tokens
npx wrangler secret put IMPROVE_SCORE_SECRET     # root of the job, policy and backup credential HMAC keys
```

Never commit one, and never read, display or log the contents of an env file.

## 4. The GitHub App

Capsid reaches private repositories through a GitHub App installation token,
cached in KV. It is a GitHub App, not a personal token, so access is scoped to
an installation and revocable in one place.

### Permissions

Each row names the tools it enables and the evidence that the permission is
actually granted, because a permission list copied from a setup guide is a claim
nobody has checked.

| permission    | level          | what needs it                                            | evidence                                                                                                 |
| ------------- | -------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Metadata      | Read           | resolving the default branch, every other call           | implied by every working call                                                                            |
| Contents      | Read and write | reading files and trees; tagging and publishing releases | exercised continuously since 2026-07-06                                                                  |
| Pull requests | Read and write | merging and closing pull requests                        | exercised continuously                                                                                   |
| Actions       | Read and write | reading workflow runs and logs                           | read confirmed 2026-08-16; write was for `capsid_run_ci`, removed 2026-10-31, and can be lowered to read |
| Workflows     | Write          | nothing since 2026-10-31                                 | was for committing under `.github/workflows/` through `capsid_change_repo`; can be removed               |

Since `capsid_change_repo` was removed, no tool commits to a repository, so the App's
Workflows permission and Actions write are unused and can be dropped.

The granted permission set was not read back from the API. Each row is
evidence from a call that worked. On a fresh setup, grant the list above and
expect missed permissions to show up as failed calls.

### The connector that does not work

The hosted GitHub MCP connector 404s on every private repository in this
installation while the App token reaches them all. That is a known upstream
indexing bug, not a permissions setting: reconnecting, re-running the OAuth flow
and changing the App's repository scope all fail. This repository's own repository
tools exist partly because of it.

## 5. Migrations

Applied by hand, and CI asserts it:

```
npx wrangler d1 migrations apply capsid --remote
npx wrangler d1 migrations list capsid --remote   # must print "No migrations to apply!"
```

The deploy job fails if the live database is behind, which is deliberate: a Worker
deployed against a schema it does not have is a Worker that answers errors on
every write path.

Restore is in `docs/backups.md`. Do not use `wrangler d1 export`.

## 6. Verifying a deploy

```
npm run check          # typecheck src
npm run check:test     # typecheck the unit suite (its own config)
npm run check:integration
npm test               # unit suite, node:test
npm run test:integration   # the whole Worker in workerd, real D1, KV, R2
npm run deploy
npm run verify:live    # the live gate family against the deployed Worker
```

`EXPECT_SHA` asserts which commit is live. A tool list is cached by the client
at connect time, so a tool deployed mid-session is invisible until the connector
reconnects. Verify a fresh deploy by calling the Worker directly rather than by
waiting.

## 7. Minting an agent, one per project and per machine

An agent is a caller: its own key, its own scopes, its own audit identity, its own
revocation. Every key Capsid accepts is an agent's.

Mint one as the admin with Capsid Admin's `capsid_admin_manage_agents`, from an OAuth
session on `/mcp/admin`, which needs a recent sign-in (within 2 hours, sliding, and at
most 12 hours old). That session is the only admin: no key is, so a minted agent cannot
mint another. An agent that can widen itself has no scope.

```
capsid_admin_manage_agents(action: "mint", name: "capsid-driver", kind: "driver", namespaces: ["capsid"],
       grants: ["read", "write"])
```

The response carries the key once, so it lands in that chat's transcript: save it to
the key file below at once and mint from a session you are not sharing. Nothing
stores it: the table holds its sha256, and a lost key is replaced by revoking that
agent and minting another.

One agent per project and per machine. The name says both, so an audit row
reads as a sentence: `capsid-driver-laptop`, `sample-driver-desktop`. Revoking a
compromised laptop does not stop the desktop working. `agent:sample-driver-laptop`
in the audit log needs no lookup to understand.

An agent from a second client on the same project is a role named `<namespace>-<client>`
(`ROLES` in `scripts/roles.ts`): `sample-grok` is Grok Build's driver for sample. Each
client's MCP config must not load another client's servers. Grok Build loads `~/.claude.json`
and a project's `.mcp.json` unless `[compat.claude] mcps = false` is set in `~/.grok/config.toml`
(docs.x.ai/build/features/mcp-servers); without it Grok would act as `agent:dustinedwards-driver`.

### Where the key lives on the machine

The driver reads its own key from a file, one per agent:

```
~/.capsid/agent-<name>.key
```

One line, the key, nothing else. `chmod 600` it. It is never committed, never
pasted into another chat, and never read back by anything but the driver, which sends it
as the bearer token:

```
Authorization: Bearer <contents of ~/.capsid/agent-capsid-driver.key>
```

against `POST /ops/mcp`. A file rather than an environment variable because the
driver is a long-lived session on a workstation, and an environment variable set
once in a shell profile ends up in every process on the machine, including the
ones a job runs.

### What a driver should hold, and what it should not

The default for a new agent is read on its named namespaces with no flags. Widen
it to what the work actually needs and no further:

| scope                 | a project driver                                  | the seat    |
| --------------------- | ------------------------------------------------- | ----------- |
| `namespaces`          | its own                                           | all of them |
| `repos`               | its namespace's mapped repos                      | all of them |
| `grants`              | read, write                                       | read, write |
| `can_merge`           | no                                                | yes         |
| `can_touch_protected` | no, except capsid-driver and claude-skills-driver | no          |

**`repos` is derived, not typed.** A mint that names no repos reads the live
namespace mapping and sets the axis from it, so a driver reaches its own repos
and nothing else. It refuses to mint a driver for a namespace that maps to no repos
rather than falling back to the `*` wildcard, because a wildcard can never refuse
and a mint is the wrong place to discover that. Mapping a namespace is admin-only
(`capsid_admin_manage_namespaces` action `register` and `capsid_admin_manage_namespaces` action `update`), so the boundary and the axis are set
by different calls and neither is editable by the credential they bind.

**The two exceptions are named rather than left as a general no**, because a table
that says no while the inventory says yes teaches a reader to distrust the table.
The seat granted them on 2026-09-11. Every other driver holds none. `capsid_read_status` action `status` and Capsid Portal list what each agent actually holds, so the
inventory settles it and this table describes the rule.

A driver opens pull requests with its own GitHub access and never merges them. A driver's pull request is
merged either by the seat or by the Worker under the signed auto-merge policy
(`docs/policy/auto-merge.md`); the gates policy cannot approve a merge. Giving a
driver `can_merge` would bypass both.

Widen one later with `capsid_admin_manage_agents(action: "update_scopes", ...)`, which names the axes it
changes and leaves the rest. Revoke with `capsid_admin_manage_agents(action: "revoke", name: ...)`: the
row stays, so the audit rows that agent wrote still resolve to what it was allowed
to do, and its key stops working immediately.

### The first agents

A fresh install mints these six, each with its key saved on the machine that uses it:

```
capsid_admin_manage_agents(action: "mint", name: "capsid-driver",        kind: "driver", namespaces: ["capsid"],        grants: ["read", "write"])
capsid_admin_manage_agents(action: "mint", name: "dustinedwards-driver", kind: "driver", namespaces: ["dustinedwards"], grants: ["read", "write"])
capsid_admin_manage_agents(action: "mint", name: "foxhound-driver",      kind: "driver", namespaces: ["foxhound"],      grants: ["read", "write"])
capsid_admin_manage_agents(action: "mint", name: "foxing-driver",        kind: "driver", namespaces: ["foxing"],        grants: ["read", "write"])
capsid_admin_manage_agents(action: "mint", name: "germomics-driver",     kind: "driver", namespaces: ["germomics"],     grants: ["read", "write"])
capsid_admin_manage_agents(action: "mint", name: "seat",                 kind: "seat",   namespaces: ["*"],             grants: ["read", "write"], flags: { can_merge: true })
```

Five drivers, one per namespace, each with write on its own namespace and no
flags: no merge. One seat across every namespace that may merge.

Nothing else is granted. `can_touch_protected` stays off for all six until something concrete needs one, at which point
`update_scopes` grants it and the audit row records who widened what, and from what.

### Jobs can say what they need

`capsid_work_jobs(action: "post", ..., required_flags: ["can_merge"])` records the blast radius
the work needs. The claim refuses a driver that does not hold those flags and
leaves the job queued for one that does, so the mismatch surfaces at the claim
rather than after a driver has already taken it.

## 8. Names kept from the removed improve loop

`capsid_read_status` serves only action `status`, a read-grant read of Capsid's state,
and `capsid_admin_manage_switches` holds the admin's switches (`sign_policy`,
`breaker_reset` and `overnight`). `IMPROVE_SCORE_SECRET` is the root the
job, policy and backup credential keys are derived from.

## 9. A fresh install, step by step

The sections above explain each part. This is the order to do them in. The host names in `src/mcp-host.ts` (`MCP_HOST`) and `src/portal-host.ts` (`PORTAL_HOST`) are this deployment's own; set them to yours, each a Custom Domain on the Worker. `wrangler.jsonc.example` turns the workers.dev address off.

1. Install dependencies with `npm install`.
2. Create your own Cloudflare resources:

   ```
   npx wrangler d1 create capsid
   npx wrangler kv namespace create APP_KV
   npx wrangler kv namespace create OAUTH_KV
   npx wrangler r2 bucket create capsid-media
   ```

3. Copy `wrangler.jsonc.example` to `wrangler.jsonc` and fill in the ids from step 2. **`APP_KV` and `OAUTH_KV` must be different namespace ids.** The real `wrangler.jsonc` is gitignored. Never commit it.
4. Apply the migrations (idempotent, `IF NOT EXISTS` everywhere) with `npx wrangler d1 migrations apply capsid --remote`.
5. Create a Cloudflare Access for SaaS application for the logins, in the Zero Trust dashboard: Access, Applications, Add an application, SaaS, OIDC.
   - Redirect URLs, both spelled exactly: `https://<your MCP host>/callback` for the MCP flow and `https://<your Portal host>/callback` for Capsid Portal.
   - Scopes openid, email and profile, PKCE on, and a policy that allows your email only (and any co-owner's).
   - Then set the secrets `ACCESS_TEAM_DOMAIN`, `ACCESS_SAAS_CLIENT_ID`, `ACCESS_SAAS_CLIENT_SECRET`, `ADMIN_EMAIL` and `COOKIE_ENCRYPTION_KEY` (section 3).
6. Create the GitHub App (section 4), install it on the repositories you want reachable, note its Client ID, generate a private key (`.pem`), put the Client ID in `wrangler.jsonc` vars as `GITHUB_APP_CLIENT_ID` and set `GITHUB_APP_PRIVATE_KEY`. Only the private key mints installation tokens; the App client secret is not needed. The installation id is not configured: it resolves from GitHub per owner and repo and is cached for a day, because one pinned id cannot be correct for two owners.
7. `IMPROVE_SCORE_SECRET`, the root the job-signing, policy-signing and backup credential keys are derived from. Without it the work queue refuses to post a job and no signed policy loads.
8. Optional secrets and vars, each inert until set: `CO_OWNER_EMAILS` (docs/auth.md, "Co-owner"); `CF_OPS_TOKEN` and `CF_ACCOUNT_ID` (the Portal's Cloudflare read, and Workers Builds with Workers CI Read); `CF_SECRETS_TOKEN` (Workers Scripts Edit, for `capsid_admin_set_site_key`; docs/portal.md, "Site keys"); `ACCESS_DRIFT_AUD` (the drift check's admin list, docs/auth.md, "Access drift check"); `VAPID_PRIVATE_KEY` (phone alerts, docs/portal.md); `DCR_REDIRECT_URIS` (docs/auth.md); and the `R2_*` credential-minting secrets for the Amazon backup copy.
9. Type check and deploy with `npm run check` and `npm run deploy`. Deploy builds the Portal first and stops if the build or its size budget fails.
10. Connect claude.ai: Settings, Connectors, Add custom connector, URL `https://<your MCP host>/mcp`. The connector registers itself and walks you through the Cloudflare Access sign-in. Only the `ADMIN_EMAIL` identity and any `CO_OWNER_EMAILS` identity get in (docs/auth.md). Add Capsid Admin the same way at `https://<your MCP host>/mcp/admin`, then mint the first agents (section 7). To test the flow first, run `npx @modelcontextprotocol/inspector`, set the transport to Streamable HTTP, set the URL to the same address, open the Auth tab and run Quick OAuth Flow.

MCP clients cache the tool list at connect time. After deploying new tools, reconnect the connector or start a new chat to see them.

Optional parts stay hidden or inert until configured:

- With no row in `ops_sites` that has an origin, nothing is probed and Health shows no Sites section.
- Without `CF_OPS_TOKEN`, deploy and error columns say the Cloudflare read is not configured.
- The telemetry receiver (`/ops/otlp/v1/*`, docs/telemetry.md) and the hook receiver (`/ops/hooks`, docs/hooks.md) are live but store nothing until a Claude Code session is configured to send to them with a key.
- Auto-merge is off by default (section 10).

## 10. Switches

One switch, off by default.

- **Auto-merge and pre-approved gates** run only when their policy document's `enabled` field is `true` and the document has been signed again afterwards with `capsid_admin_manage_switches` action `sign_policy`, which is admin only. Editing without re-signing leaves the policy authorizing nothing (docs/autonomy.md).

Those are a clone's defaults. On this deployment the pre-approved gates were enabled on 2026-09-13 and auto-merge on 2026-09-16.

## 11. Checks before a push

Run `npm ci --prefix dashboard` once, then `npm run check`, `npm run check:test`, `npm run check:integration`, `npm run check:scripts`, `npm run check:dashboard`, `npm run lint`, `npm run lint:repo`, `npm test`, `npm run build:dashboard` and `npm run test:browser`. `npm run test:integration` runs the Worker in workerd. `EXPECT_SHA=<sha> npm run verify:live` checks the live Worker. `npm --prefix dashboard run dev` serves the Portal with fake sample data.
