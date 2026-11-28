# Rollback

Restore is about data. Rollback is about code: a deploy shipped a bad Worker and the fix is to serve the previous version now.

```
npx wrangler deployments list
npx wrangler rollback [<version-id>]
```

With no id it reverts to the previous deployment. It swaps the Worker script and that version's bindings and vars only: it does not touch D1, R2 or KV data and does not change `master`, so the next push redeploys `HEAD`. Afterwards `/health` reports the rolled-back sha, so the scheduled live gate (which asserts `/health` sha equals master head) goes red until the fix ships. That red is correct.

## The automatic rollback in CI

Every push to `master` deploys through devkit's shared `worker-deploy.yml` (the `deploy` job in `.github/workflows/ci.yml`); devkit's README, "The shared deploy", is the reference.

- **Gradually.** The new version takes 10% of traffic beside the live one. Its `live gate` job reads `/health` until it reports this run's commit, waits 10 minutes, runs `scripts/verify-live.mjs` with `EXPECT_SHA` (every request carries `Cloudflare-Workers-Version-Overrides`, so each gate judges the new version), compares both versions' error rates, then gives the new version all traffic.
- **Exit 1 is a refusal.** A gate answered and said no, or the new version's error rate is clearly worse: traffic goes back to the version it shared with.
- **Exit 3 is "could not run".** No gate got an answer (a reset connection, a timeout). Nothing refused the deploy, so nothing is rolled back; the job fails, the split stays, and the run summary has the command that sends everything back.
- **Only what this run put live** is rolled back, checked by devkit's guard against `/health`, and the sha is read back afterwards.
- **A Durable Object migration** (a new `migrations` entry in `wrangler.jsonc.example`) cannot go out gradually: Cloudflare applies it only with `wrangler deploy`. That pull request sets `gradual-percent: 0`.
- The bad commit stays on `master`. Land a fix or revert it.

The six-hourly `scheduled live check` runs the same script against master head with what the deploy's gate leaves out: gate 2b's read of the OAuth KV canary (the deploy's verify command gets no Cloudflare secret) and gate 1c's backup freshness. It never deploys or rolls back.

The watcher records each deploy in `deploy_outcomes` ([autonomy.md](autonomy.md), "Deploys"). The Portal's CI page turns the rows into per-repo deploys per week, change failure rate and median time to restore. The watcher matches the rollback step's `::error::` annotations ("rolled back: was ...", "not rolling back", "the rollback did not take effect"), so changing that wording in devkit means changing `src/deploy-outcomes.ts`.

## The MCP call (gate 8)

Every other gate stops before the MCP connection, so a deploy whose sign-in works and whose tool calls are broken passes them. Gate 8 makes the calls a client makes, through `/ops/mcp` with the `live-probe` agent's key, in both protocol eras (`scripts/mcp-probe-lib.mjs`):

- 2025-11-25: `initialize`, `notifications/initialized`, `tools/list`, then `read` of `capsid/conventions.md`;
- 2026-07-28: `server/discover`, `tools/list` (which must carry `ttlMs` and `cacheScope`), then the same `read`.

`tools/list` must return the served tool count (a test holds the script's number to `TOOL_GRANTS`), and the read must return the document with the word "conventions" in it. Any other answer, a 401 included, is a refusal (exit 1) and the deploy rolls back; a 401 can mean the key was revoked, but a deploy that broke key resolution looks the same. No answer is could-not-run (exit 3). `test/live-gate-mcp.test.ts` runs the script against the real handler with five planted broken deploys.

**Setup.** Until both steps are done the gate skips and warns on the run.

1. Mint the probe agent with `capsid_admin_manage_agents` action `mint`, using the `live-probe` row of `ROLES` in `scripts/roles.ts`, and save the key to `~/.capsid/agent-live-probe.key`.
2. Set it as the repo secret, from the file so it never reaches the terminal:

   ```
   gh secret set CAPSID_LIVE_PROBE_KEY --repo DrDustinEdwards/capsid < ~/.capsid/agent-live-probe.key
   ```

Rerun the scheduled live check and look for `PASS  8 MCP call through /ops/mcp`. A lost key is replaced by revoking `live-probe` and minting under a new name.

Rollback never undoes a D1 migration: the deploy records the D1 Time Travel bookmark before it migrates, and the run summary has the restore command.
