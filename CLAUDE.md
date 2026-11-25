# CLAUDE.md - capsid

A Cloudflare Worker, run by its owner and the co-owners in `CO_OWNER_EMAILS`, serving the portfolio's knowledge base (D1, R2) over MCP, reaching GitHub through an App. Live: https://mcp.dustinedwards.info/mcp; Portal https://portal.dustinedwards.info. Public MIT repo.

## Rules every repo shares

- **Tests.** Keep the minimal set: a few browser tests for flows that must never break, one integration test per real behavior, unit tests only for tricky logic, shared code tested once where it lives. Remove a test that pins design, repeats coverage or never caught a mistake, unless it guards a harm that cannot be undone.
- **UI copy.** Let the layout explain: no eyebrows, restating subtitles, "this page lets you" intros, hints a label already gives or empty-state essays. Labels, accessible names, errors, one-way warnings and legal text stay (Dustin, 2026-11-18; capsid/conventions.md).
- **Shared code.** Before writing anything another site might have, check https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md. Change shared code in place and delete what the change replaces in the same PR.
- **Browser support.** devkit's docs/browser-support.md: Baseline Widely available freely, Newly available with a small fallback, Limited only feature-detected, no polyfills.
- **Secrets.** Never commit or print a key, token, `.dev.vars` or `.env`.
- **Reproduce first.** Reproduce a reported failure before fixing it; report red before and green after.
- **Deploys.** A merge to the default branch deploys; never deploy from a session.
- **D1.** Never hand-run production DDL; CI applies additive migrations and refuses the rest. Back up and restore with d1-dump, never `wrangler d1 export` (it fails on FTS5 tables).

## Rules for this repo

Code comments cite these by name ("CLAUDE.md, public repo rule").

1. **Tool surface.** A new served tool needs Dustin's yes first (TOOL_GRANTS and `src/tools/surface.ts` list them).
2. **Public repo.** Never commit `wrangler.jsonc` or real vault content; fixtures use fake data (example.com, namespace "sample").

## Commands

- CI also runs `npm run test:integration` and `npm run test:browser`; run them locally only when needed, one heavy session at a time.
- Read `.claude/rules/deploy.md` before verifying a deploy and `.claude/rules/restore.md` before any D1 restore.
