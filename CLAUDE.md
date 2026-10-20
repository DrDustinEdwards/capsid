# CLAUDE.md - capsid

A Cloudflare Worker, run by its owner and the co-owners in `CO_OWNER_EMAILS`, serving the portfolio's knowledge base (D1, R2) over MCP, reaching GitHub through an App. Live: https://mcp.dustinedwards.info/mcp; Portal https://portal.dustinedwards.info. Public MIT repo. Read `capsid/conventions.md` and `capsid/core.md` in Capsid before acting. Rule detail loads from `.claude/rules/` when you touch its files.

## Commands

- CI also runs `npm run test:integration` and `npm run test:browser`; run them locally only when needed, one heavy session at a time.
- A merge to master deploys, docs included; refused paths wait for the seat (docs/autonomy.md). Read `.claude/rules/deploy.md` before a deploy or its verification and `.claude/rules/restore.md` before any D1 restore or export.

## Rules

Code comments cite these by name ("CLAUDE.md, public repo rule").

1. **Tool surface.** Every served tool is in `TOOL_GRANTS` and `src/tools/surface.ts`; a new tool needs Dustin's ruling first, recorded as its own file under `capsid/rulings/`.
2. **Public repo.** Never commit `wrangler.jsonc`, `.dev.vars`, `.env`, a key or real vault content; fixtures use fake data (example.com, namespace "sample"). Never print a token.
