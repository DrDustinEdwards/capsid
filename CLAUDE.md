# CLAUDE.md - capsid

A Cloudflare Worker serving the portfolio's knowledge base (D1, R2) over MCP. Live: https://mcp.dustinedwards.info/mcp; Portal https://portal.dustinedwards.info. Public MIT repo.

## Rules every repo shares

- **Tests.** Reproduce a reported failure before fixing it: red before, green after.
- **UI copy.** No eyebrows, restating subtitles, intros or hints a label already gives (Dustin, 2026-11-18).
- **Shared code.** Check devkit's [SHARED.md](https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md) before writing anything another repo might have; change it in place.
- **Secrets.** Never commit or print a key or token. AI provider keys stay on the server.
- **Production.** Never deploy, tag, release or run production DDL from a session; a merge deploys. Back up and restore D1 only with d1-dump.

## Rules for this repo

- **Tool surface.** A new served tool needs Dustin's yes first (TOOL_GRANTS and `src/tools/surface.ts` list them).
- **Public repo.** Never commit `wrangler.jsonc` or real vault content; fixtures use fake data (example.com, namespace "sample").

## Commands

- `npm run check` locally; CI also runs `npm run test:integration` and `npm run test:browser`.
