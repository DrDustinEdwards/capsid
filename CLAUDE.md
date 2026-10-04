# CLAUDE.md - capsid

Capsid is a single-user Cloudflare Worker that serves the portfolio's knowledge base (D1, R2) over MCP and reaches GitHub through an App. Live: https://mcp.dustinedwards.info/mcp; the Portal at https://portal.dustinedwards.info. This is a public MIT repo.

Read `capsid/conventions.md` (the portfolio rules) and `capsid/core.md` in Capsid before acting. They outrank this file. The tests enforce the code's invariants. This file lists what is true of this repo alone: what a test cannot catch, or what goes wrong before a test runs.

## Commands

- Quick checks before a push: `npm run check`, `npm run check:test`, `npm run lint`, `npm test`. Add `npm run check:dashboard` and `npm run build:dashboard` (it enforces the size budget) when `dashboard/` changed, and `npm run check:scripts` when `scripts/` changed.
- CI runs everything, including `npm run test:integration` (the Worker in workerd) and `npm run test:browser` (the built Portal in Chromium). Run those two locally only when the change needs them, one heavy session at a time.
- A Claude Code cloud session starts on Node 22 and npm 10, which cannot `npm ci` this lockfile. `.claude/hooks/session-start.sh` (a SessionStart hook) installs the Node in `.nvmrc` from nodejs.org, checks its SHA-256, puts it on PATH and runs `npm ci`. It does nothing locally. Fix a cloud failure there, not in package.json.
- `npm ci --prefix dashboard` once before the dashboard checks. `npm --prefix dashboard run dev` serves the Portal with fake sample data.
- Deploy: `npm run deploy` (builds the dashboard first and stops if the build or its size budget fails), then `EXPECT_SHA=<sha> npm run verify:live`.
- Secrets: `npx wrangler secret put KEY`.
- capsid pull requests are merged by the seat, never auto-merged (docs/policy/auto-merge.md). A merge to master is a production deploy, docs included.

## Rules

Code comments cite these by name ("CLAUDE.md, snapshot rule"), not by number.

1. **Tool surface.** Every served tool has an entry in `TOOL_GRANTS` in `src/scope.ts`, and `src/counts.ts` derives the count from it. Adding a tool needs a ruling in `capsid/decisions.md` first.
2. **Public repo.** Never commit `wrangler.jsonc`, `.dev.vars`, `.env`, a key, or real vault content. Fixtures use fake data (example.com, namespace "sample"). Never print a token.
3. **Snapshot.** Every overwrite and delete snapshots to `document_versions` and writes `audit_log`. Lint finalize archives and never deletes. (test/invariants.test.ts, test/write-invariants.test.ts)
4. **One enforcement point.** `checkScope` in `src/scope.ts` is the only grant check. Every served tool refuses a caller without that tool, and every write refuses a read-only caller, with `checkScope`'s refusal and before its handler runs (test/scope.test.ts, the two SWEEP tests). Every repo mutation goes through `guardedWrite` (test/blast-radius.test.ts).
5. **Path mutation.** Paths change only through `pathMutation()`. State moves are `UPDATE ... WHERE status = ? RETURNING id`. (test/path-mutation.test.ts)
6. **Improve loop.** The improve loop stays off unless Dustin turns it on. Only `src/improve-scorer.ts` names `HOLDOUT`. (test/improve-holdout.test.ts)
7. **No AI trailer.** No commit or pull request carries an AI trailer or footer. `.claude/settings.json` turns attribution off, and CI's `scripts/check-commit-trailers.mjs` refuses a commit that carries one (test/commit-trailers.test.ts).
8. **Health probe.** `/health` and the backup preflight search `capsid/conventions.md` for the word "conventions" (`src/store-probe.ts`). That document must keep the word, or Capsid reports itself degraded and the backup refuses to prune.
9. **Verify a deploy directly.** MCP clients cache the tool list when they connect. To verify a deploy, call the Worker directly: `initialize`, `notifications/initialized`, `tools/call`. The token is under `mcpOAuth` in `~/.claude/.credentials.json`. Never print it.

The other portfolio rules that used to be restated here (a check trusted only after it fails, no swallowed error, D1 `meta.changes`) are in `capsid/conventions.md`.

## Restore

`wrangler d1 export` fails on this database because of FTS5. Follow the per-table procedure in `docs/backups.md`: import `documents` first, and never export `documents_fts`.
