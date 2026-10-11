---
paths:
  - "scripts/deploy.mjs"
  - "scripts/verify-live.mjs"
  - "scripts/bindings.mjs"
  - "wrangler.jsonc.example"
  - "dashboard/**"
---

# Deploy and verify

- Deploy: `npm run deploy` (builds the dashboard first and stops if the build or its size budget fails), then `EXPECT_SHA=<sha> npm run verify:live`. Secrets: `npx wrangler secret put KEY`.
- `npm --prefix dashboard run dev` serves the Portal with fake sample data.
- Verify a deploy directly: MCP clients cache the tool list when they connect. Call the Worker on `/ops/mcp` with this project's driver key (the Authorization header in `.mcp.json`): `initialize`, `notifications/initialized`, `tools/list`, then a read tool. Never read `~/.claude/.credentials.json`: its `mcpOAuth` entry is the admin login, and a driver acts only as its own agent. An admin-only tool (Capsid Admin, served only on `/mcp/admin` and `/ops/mcp/admin`) is verified by the seat. Never print a key.
