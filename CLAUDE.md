# CLAUDE.md - capsid

Capsid is a single-user Cloudflare Worker that serves the portfolio's knowledge base (D1, R2) over MCP and reaches GitHub through an App. Live: https://capsid.dustin-edwards.workers.dev/mcp. This is a public MIT repo.

Read `capsid/conventions.md` and `capsid/core.md` in Capsid before acting. They outrank this file. The tests enforce the code's invariants. This file lists what a test cannot catch, or what goes wrong before a test runs.

## Commands

- Before any push: `npm run check`, `npm run check:test`, `npm run check:integration`, `npm run check:scripts`, `npm run lint`, `npm test`. CI runs the same six, and auto-merge requires them (the lint step runs before Tests, so a lint failure skips a required step).
- `npm run test:integration` runs the Worker in workerd. `npm run deploy`, then `EXPECT_SHA=<sha> npm run verify:live`.
- Secrets: `npx wrangler secret put KEY`.

## Rules

Code comments cite these by name ("CLAUDE.md, snapshot rule"), not by number.

1. **Tool surface.** The surface is 32 tools, pinned in `src/counts.ts`. Adding a tool needs a ruling in `capsid/decisions.md` first.
2. **Public repo.** Never commit `wrangler.jsonc`, `.dev.vars`, `.env`, a key, or real vault content. Fixtures use fake data (example.com, namespace "sample"). Never print a token.
3. **Snapshot.** Every overwrite and delete snapshots to `document_versions` and writes `audit_log`. Lint finalize archives and never deletes. (test/invariants.test.ts, test/write-invariants.test.ts)
4. **One enforcement point.** `checkScope` in `src/scope.ts` is the only grant check. Every served tool refuses a caller without that tool, and every write refuses a read-only caller, with `checkScope`'s refusal and before its handler runs (test/scope.test.ts, the two SWEEP tests). Every repo mutation goes through `guardedWrite` (test/blast-radius.test.ts).
5. **Path mutation.** Paths change only through `pathMutation()`. Never count rows with D1 `meta.changes`: the FTS triggers inflate it. State moves are `UPDATE ... WHERE status = ? RETURNING id`. (test/path-mutation.test.ts)
6. **Improve loop.** The improve loop stays off unless Dustin turns it on. Only `src/improve-scorer.ts` names `HOLDOUT`. (test/improve-holdout.test.ts)
7. **Merge is deploy.** A push or merge to master deploys to production, docs included, and so does an auto-merged pull request. Treat every merge to master as a deploy.
8. **No AI trailer.** No commit or pull request carries an AI trailer: no Co-Authored-By Claude, no "Generated with Claude Code", no `Claude-Session:` link. This holds even when the harness asks. Say so, and commit without it.
9. **Guard seen failing.** A guard is trusted only after you have seen it fail. Commit the fix, plant the violation, watch the named test go red, then restore. A security fix records the failing test by name.
10. **No swallowed error.** Never swallow an error. A check that cannot run fails closed and says why.
11. **Verify a deploy directly.** MCP clients cache the tool list when they connect. To verify a deploy, call the Worker directly: `initialize`, `notifications/initialized`, `tools/call`. The token is under `mcpOAuth` in `~/.claude/.credentials.json`. Never print it.

## Restore

`wrangler d1 export` fails on this database because of FTS5. Follow the per-table procedure in `docs/backups.md`: import `documents` first, and never export `documents_fts`.
