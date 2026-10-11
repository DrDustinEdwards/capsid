# CLAUDE.md - capsid

A single-user Cloudflare Worker serving the portfolio's knowledge base (D1, R2) over MCP, reaching GitHub through an App. Live: https://mcp.dustinedwards.info/mcp; Portal https://portal.dustinedwards.info. Public MIT repo. Read `capsid/conventions.md` and `capsid/core.md` in Capsid before acting; they outrank this file. Rule detail loads from `.claude/rules/` when you touch its files.

## Commands

- Before a push: `npm run check`, `npm run check:test`, `npm run lint`, `npm test`. When `dashboard/` changed: `npm ci --prefix dashboard` once, `npm run check:dashboard`, `npm run build:dashboard` (size budget). When `scripts/` changed: `npm run check:scripts`.
- CI also runs `npm run test:integration` and `npm run test:browser`; run them locally only when needed, one heavy session at a time.
- A merge to master deploys, docs included; refused paths wait for the seat (docs/autonomy.md). Read `.claude/rules/deploy.md` before a deploy or its verification and `.claude/rules/restore.md` before any D1 restore or export.

## Rules

Code comments cite these by name ("CLAUDE.md, snapshot rule").

1. **Tool surface.** Every served tool is in `TOOL_GRANTS` and `src/tools/surface.ts`; a new tool needs a ruling in `capsid/decisions.md` first.
2. **Public repo.** Never commit `wrangler.jsonc`, `.dev.vars`, `.env`, a key or real vault content; fixtures use fake data (example.com, namespace "sample"). Never print a token.
3. **Snapshot.** Every overwrite and delete snapshots to `document_versions` and writes `audit_log`.
4. **One enforcement point.** `checkScope` is the only grant check; every repo mutation goes through `guardedWrite`.
5. **Path mutation.** Paths change only through `pathMutation()`.
6. **Improve loop.** Off unless Dustin turns it on; only `src/improve-scorer.ts` names `HOLDOUT`.
7. **No AI trailer** on any commit or pull request.
8. **Health probe.** `capsid/conventions.md` must keep the word "conventions".
9. **Verify a deploy directly** on `/ops/mcp` with this project's driver key (in a cloud session the network secret adds it; the committed `.mcp.json` carries none): `initialize`, `notifications/initialized`, `tools/list`, a read tool, never a cached client; admin tools are the seat's. Never read `~/.claude/.credentials.json`.
