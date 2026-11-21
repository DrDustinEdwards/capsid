# CLAUDE.md - capsid

A Cloudflare Worker, run by its owner and the co-owners in `CO_OWNER_EMAILS`, serving the portfolio's knowledge base (D1, R2) over MCP, reaching GitHub through an App. Live: https://mcp.dustinedwards.info/mcp; Portal https://portal.dustinedwards.info. Public MIT repo. Read `capsid/core.md` in Capsid before acting. Rule detail loads from `.claude/rules/` when you touch its files.

## Rules every repo shares

- **Tests.** Keep the minimal set (a few browser tests for flows that must never break, one integration test per real behavior, unit tests only for tricky logic, shared code tested once where it lives), and remove any test that pins design, repeats coverage or has never caught a real mistake, unless it guards a harm that cannot be undone.
- **UI copy.** Let the layout explain. No eyebrows, restating subtitles, "this page lets you" intros, descriptions under obvious buttons, hints a label already gives, repeated captions or empty-state essays; labels, accessible names, errors, one-way warnings and legal text stay (Dustin, 2026-11-18; Capsid capsid/conventions.md).
- **Shared code.** Before writing anything another site might have, read https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md (CI's shared-code check fails on a copy). Change shared code in place and delete what a change replaces in the same PR.
- **Browser support.** devkit's docs/browser-support.md (Baseline Widely available freely; Newly available with a small fallback; Limited only feature-detected; no polyfills).
- **Secrets.** Never commit or print a key, token, `.dev.vars` or `.env`.
- **Reproduce first.** A report that something is broken names a cause; reproduce the failure before fixing it, and report red before and green after.
- **Deploys.** A merge to the default branch deploys (CI's deploy job); never deploy from a session.
- **D1.** Migrations are additive: CI applies the ones that only add and refuses a drop, rename or row delete for a hand run; never hand-run production DDL. `wrangler d1 export` fails on FTS5 tables, so back up and restore with d1-dump (its README); never export an `*_fts` table. Checking backups, backing up now and running a scheduled job now are Capsid Admin's, for every site (`/api/operator`, site-runtime `./operator`).

## Rules for this repo

Code comments cite these by name ("CLAUDE.md, public repo rule").

1. **Tool surface.** Every served tool is in `TOOL_GRANTS` and `src/tools/surface.ts`; a new tool needs Dustin's yes first.
2. **Public repo.** Never commit `wrangler.jsonc` or real vault content; fixtures use fake data (example.com, namespace "sample").

## Commands

- CI also runs `npm run test:integration` and `npm run test:browser`; run them locally only when needed, one heavy session at a time.
- Read `.claude/rules/deploy.md` before a deploy or its verification and `.claude/rules/restore.md` before any D1 restore or export; refused paths wait for the seat (docs/autonomy.md).
