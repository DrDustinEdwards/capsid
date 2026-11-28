# Bootstrap

What it takes to stand this up, and what to check before a push.

## 1. Configuration

The real `wrangler.jsonc` is gitignored. Copy `wrangler.jsonc.example` and fill in the ids:

```
cp wrangler.jsonc.example wrangler.jsonc
```

Typecheck and tests work without it; only `wrangler dev` and `wrangler deploy` need it.

## 2. Bindings

| binding    | kind | purpose                                                     |
| ---------- | ---- | ----------------------------------------------------------- |
| `DB`       | D1   | documents, versions, links, audit log, agents               |
| `APP_KV`   | KV   | the Worker's caches, counters and switches                  |
| `OAUTH_KV` | KV   | the OAuth provider's clients, grants and tokens, kept apart |
| `MEDIA`    | R2   | backups and the Markdown mirror                             |

Resolve each binding by name and assert the resolved id equals a pinned value (`scripts/bindings.mjs`). A Worker pointed at nothing starts and answers healthy while every read errors.

## 3. Secrets

```
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # the .pem contents
npx wrangler secret put ACCESS_TEAM_DOMAIN       # https://<team>.cloudflareaccess.com
npx wrangler secret put ACCESS_SAAS_CLIENT_ID    # the Access for SaaS app "Capsid"
npx wrangler secret put ACCESS_SAAS_CLIENT_SECRET
npx wrangler secret put ADMIN_EMAIL              # the primary owner, admitted by both logins
npx wrangler secret put CO_OWNER_EMAILS          # optional, comma separated (auth.md, "Co-owner")
npx wrangler secret put COOKIE_ENCRYPTION_KEY    # openssl rand -hex 32; root of the login-state, cookie and confirm-token keys
npx wrangler secret put IMPROVE_SCORE_SECRET     # root of the backup credential HMAC key
```

Never commit one, and never read, display or log an env file.

## 4. The GitHub App

Capsid reaches private repositories through a GitHub App installation token, cached in KV, so access is scoped to an installation and revocable in one place.

| permission    | level          | what needs it                                                             |
| ------------- | -------------- | ------------------------------------------------------------------------- |
| Metadata      | Read           | resolving the default branch, every other call                            |
| Contents      | Read and write | reading files and trees; tagging and publishing releases                  |
| Pull requests | Read and write | merging and closing pull requests                                         |
| Actions       | Read and write | reading workflow runs and logs; starting capsid-backups' `offaccount.yml` |

No tool commits to a repository, so the App needs no Workflows permission. A missing permission shows up as a failed call.

The hosted GitHub MCP connector 404s on every private repository in this installation while the App token reaches them all, an upstream indexing bug; reconnecting and changing the App's scope do not fix it.

## 5. Migrations

```
npx wrangler d1 migrations apply capsid --remote
npx wrangler d1 migrations list capsid --remote   # must print "No migrations to apply!"
```

The deploy's pre-deploy guard applies pending migrations that only add (`devkit-migrations`) and refuses a drop, rename or row delete; those are run by hand with the command above. A Worker deployed against a schema it lacks errors on every write. Restore is in [backups.md](backups.md); do not use `wrangler d1 export`.

## 6. Verifying a deploy

`EXPECT_SHA=<sha> npm run verify:live` runs the live gate against the deployed Worker. An MCP client caches the tool list at connect time, so a tool deployed mid-session is invisible until the connector reconnects. Verify a fresh deploy by calling the Worker directly.

## 7. Minting an agent

An agent is a caller with its own key, scopes, audit identity and revocation. Every key Capsid accepts is an agent's.

Mint as the admin with `capsid_admin_manage_agents`, from an OAuth session on `/mcp/admin` with a recent sign-in (within 2 hours, sliding, at most 12 hours old). That session is the only admin: no key is, so a minted agent cannot mint another.

```
capsid_admin_manage_agents(action: "mint", name: "capsid-driver", kind: "driver", namespaces: ["capsid"], grants: ["read", "write"])
```

The response carries the key once, so save it to the key file below at once and mint from a session you are not sharing. The table holds only its sha256; a lost key is replaced by revoking the agent and minting another. A mint resolves nothing until the admin clicks Activate on the agent's drawer in the Portal ([auth.md](auth.md)).

One agent per project and per machine, named so an audit row reads as a sentence: `capsid-driver-laptop`. Revoking one machine leaves the others working. An agent from a second client on the same project is a role named `<namespace>-<client>` (`ROLES` in `scripts/roles.ts`). Each client's MCP config must not load another client's servers; Grok Build loads `~/.claude.json` and a project's `.mcp.json` unless `[compat.claude] mcps = false` is set in `~/.grok/config.toml`.

### Where the key lives

```
~/.capsid/agent-<name>.key
```

One line, the key, `chmod 600`. It is never committed or pasted into another chat. The driver sends it as `Authorization: Bearer <key>` to `POST /ops/mcp`. A file rather than an environment variable, because a variable set in a shell profile reaches every process on the machine.

### What a driver holds

A new agent gets read on its named namespaces and no flags. Widen it to what the work needs and no further.

| scope                 | a project driver                                  | the seat    |
| --------------------- | ------------------------------------------------- | ----------- |
| `namespaces`          | its own                                           | all of them |
| `repos`               | its namespace's mapped repos                      | all of them |
| `grants`              | read, write                                       | read, write |
| `can_merge`           | no                                                | yes         |
| `can_touch_protected` | no, except capsid-driver and claude-skills-driver | no          |

`repos` is derived: a mint reads the live namespace mapping and refuses a namespace that maps to no repos rather than falling back to `*`. Mapping a namespace is admin-only, so the boundary and the axis are set by different calls. `capsid_read_status` action `status` and the Portal list what each agent actually holds.

A driver opens pull requests with its own GitHub access. A pull request merges on green, by the session that opened it or by GitHub auto-merge; Capsid runs no merge loop.

Widen with `update_scopes` (names the axes it changes, leaves the rest). Revoke with `capsid_admin_manage_agents(action: "revoke", name: ...)`: the row stays, so audit rows still resolve, and the key stops working at once.

### The first agents

```
capsid_admin_manage_agents(action: "mint", name: "capsid-driver",        kind: "driver", namespaces: ["capsid"],        grants: ["read", "write"])
capsid_admin_manage_agents(action: "mint", name: "dustinedwards-driver", kind: "driver", namespaces: ["dustinedwards"], grants: ["read", "write"])
capsid_admin_manage_agents(action: "mint", name: "foxhound-driver",      kind: "driver", namespaces: ["foxhound"],      grants: ["read", "write"])
capsid_admin_manage_agents(action: "mint", name: "foxing-driver",        kind: "driver", namespaces: ["foxing"],        grants: ["read", "write"])
capsid_admin_manage_agents(action: "mint", name: "germomics-driver",     kind: "driver", namespaces: ["germomics"],     grants: ["read", "write"])
capsid_admin_manage_agents(action: "mint", name: "seat",                 kind: "seat",   namespaces: ["*"],             grants: ["read", "write"], flags: { can_merge: true })
```

## 8. A fresh install, step by step

The host names in `src/mcp-host.ts` (`MCP_HOST`) and `src/portal-host.ts` (`PORTAL_HOST`) are this deployment's own; set them to yours, each a Custom Domain on the Worker. `wrangler.jsonc.example` turns the workers.dev address off.

1. `npm install`.
2. Create the Cloudflare resources:

   ```
   npx wrangler d1 create capsid
   npx wrangler kv namespace create APP_KV
   npx wrangler kv namespace create OAUTH_KV
   npx wrangler r2 bucket create capsid-media
   ```

3. Copy `wrangler.jsonc.example` to `wrangler.jsonc` and fill in the ids. `APP_KV` and `OAUTH_KV` must be different namespaces. Never commit it.
4. `npx wrangler d1 migrations apply capsid --remote`.
5. In Zero Trust create an Access for SaaS application (Access, Applications, Add an application, SaaS, OIDC):
   - Redirect URLs: `https://<your MCP host>/callback` and `https://<your Portal host>/callback`, exactly.
   - Scopes openid, email and profile, PKCE on, and a policy that allows your email only (and any co-owner's).
   - Set `ACCESS_TEAM_DOMAIN`, `ACCESS_SAAS_CLIENT_ID`, `ACCESS_SAAS_CLIENT_SECRET`, `ADMIN_EMAIL` and `COOKIE_ENCRYPTION_KEY` (section 3).
6. Create the GitHub App (section 4), install it on the repositories to reach, put its Client ID in `wrangler.jsonc` vars as `GITHUB_APP_CLIENT_ID` and set `GITHUB_APP_PRIVATE_KEY`. Only the private key mints installation tokens. The installation id resolves from GitHub per owner and repo and is cached for a day.
7. Set `IMPROVE_SCORE_SECRET`. Without it the backup credential endpoint refuses.
8. Optional secrets and vars, each inert until set: `CO_OWNER_EMAILS`; `CF_OPS_TOKEN` and `CF_ACCOUNT_ID` (the Portal's Cloudflare read, and Workers Builds); `CF_SECRETS_TOKEN` (Workers Scripts Edit, for `site_key_rotate`; [portal.md](portal.md)); `ACCESS_DRIFT_AUD` ([auth.md](auth.md)); `VAPID_PRIVATE_KEY` (phone alerts); `DCR_REDIRECT_URIS` ([auth.md](auth.md)); and the `R2_*` credential-minting secrets for the Amazon backup copy.
9. `npm run check` and `npm run deploy`. Deploy builds the Portal first and stops if the build or its size budget fails.
10. Connect claude.ai: Settings, Connectors, Add custom connector, `https://<your MCP host>/mcp`. It registers itself and walks you through the Access sign-in. Add Capsid Admin the same way at `/mcp/admin`, then mint the first agents (section 7). To test the flow first, run `npx @modelcontextprotocol/inspector` with the Streamable HTTP transport and Quick OAuth Flow on the Auth tab.

With no `ops_sites` row that has an origin, nothing is probed and Health shows no Sites section. Without `CF_OPS_TOKEN`, the deploy and error columns say the Cloudflare read is not configured.

## 9. Checks before a push

Run `npm ci --prefix dashboard` once, then `npm run check`, `npm run check:test`, `npm run check:integration`, `npm run check:scripts`, `npm run check:dashboard`, `npm run lint`, `npm run lint:repo`, `npm test`, `npm run build:dashboard` and `npm run test:browser`. `npm run test:integration` runs the Worker in workerd. `npm --prefix dashboard run dev` serves the Portal with fake sample data.
