---
paths:
  - ".github/workflows/ci.yml"
  - "scripts/verify-live.mjs"
  - "scripts/bindings.mjs"
  - "wrangler.jsonc.example"
  - "dashboard/**"
---

# Deploy and verify

- Deploy: a merge to master, through devkit's shared worker-deploy.yml (ci.yml `deploy`): 10% of traffic for 10 minutes, the live gate (`scripts/verify-live.mjs`), then all traffic, or a rollback. A change that adds a Durable Object migration sets `gradual-percent: 0` for that deploy, because Cloudflare applies one only with `wrangler deploy`. Secrets: `npx wrangler secret put KEY`.
- Verify a deploy directly: MCP clients cache the tool list when they connect. Call the Worker on `/ops/mcp` with this project's driver key (in a cloud session the Claude Code network secret adds it on the way out; the committed `.mcp.json` names the server and carries no key, test/mcp-config.test.ts): `initialize`, `notifications/initialized`, `tools/list`, then a read tool. Never read `~/.claude/.credentials.json`: its `mcpOAuth` entry is the admin login, and a driver acts only as its own agent. An admin-only tool (Capsid Admin, served only on `/mcp/admin` and `/ops/mcp/admin`) is verified by the seat. Never print a key.
