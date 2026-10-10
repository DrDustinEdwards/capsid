# Rollback

Restore is about data. Rollback is about code: a deploy shipped a bad Worker and the fix is to serve the previous version now.

```
npx wrangler deployments list
npx wrangler rollback [<version-id>]
```

With no id it reverts to the immediately previous deployment. Pass a version id to go further back. It swaps the Worker script and that version's bindings and vars only. It does not touch D1, R2 or KV data, and it does not change `master`: the next push redeploys `HEAD` through CI and supersedes the rollback. Afterwards `/health` reports the rolled-back sha, so the scheduled live gate (which asserts `/health` sha equals master head) goes red until the fix ships. That red is correct. Production is behind master on purpose.

## The automatic rollback in CI

Most rollbacks never need the command above: CI does it. Every push to `master` deploys (`deploy` job in `.github/workflows/ci.yml`), then the `live gate` job runs `npm run verify:live` against `EXPECT_SHA`, the commit that run deployed.

- **Exit 1 is a refusal.** A gate answered and said no. The step "Roll back the deploy this run shipped" runs only when the deploy in this run succeeded and the gate exited 1.
- **Exit 3 is "could not run".** No gate got an answer (a reset connection, a timeout). Nothing refused the deploy, so nothing is rolled back; the job fails and says to rerun it. One ECONNRESET rolled back a good deploy on 2026-09-18 before this split.
- **Only what this run put live.** Before rolling back, the step reads `/health` and asks `scripts/rollback-guard.mjs` whether the live sha is still this run's commit. A rerun of just the live job keeps the first attempt's deploy result, and without the guard a second rollback can move production onto the refused commit (2026-09-18). When `/health` cannot say, the guard rolls back only if the deploy ran in this attempt. A skip is written to the step summary as `rollback_skipped: live=<sha> this_run=<sha>`.
- **Read back, not assumed.** After `wrangler rollback --name capsid`, the step polls `/health` up to 20 times, 3 seconds apart, until a readable sha other than this run's is live (`rollback-guard.mjs --after`). On success the summary carries `rollback_from=<sha> rollback_to=<sha>`; if the sha never moves it carries `rollback_did_not_take_effect` and the job fails, because production may still serve the refused deploy and a human decides.
- **master is not changed.** The bad commit stays on `master`. Land a fix or revert it; the next push deploys again through the same gate.

## The MCP call (gate 8)

Every other gate stops before the MCP connection: OAuth metadata, `/register`, the consent page, the Access redirect, headers, and a 401 from `/ops/mcp` with no key. A deploy whose sign-in works and whose tool calls are broken passed all of them (job_bb06c9be24c4). Gate 8 makes the calls a client makes, through `/ops/mcp` with the `live-probe` agent's key, in both protocol eras Capsid serves (`scripts/mcp-probe-lib.mjs`):

- 2025-11-25: `initialize`, `notifications/initialized`, `tools/list`, then `read` of `capsid/conventions.md`;
- 2026-07-28: `server/discover`, `tools/list` (which must also carry `ttlMs` and `cacheScope`), then the same `read`.

`tools/list` must return the served tool count (a test holds the script's number to `TOOL_GRANTS`), and the read must return the document with the word "conventions" in it. Any other answer, a 401 included, is a refusal: exit 1, and the step above rolls the deploy back. A 401 can also mean the key was revoked or mistyped, and the gate's message says so; rolling back is still the safe answer, because a deploy that broke key resolution looks the same. No answer at all is could-not-run (exit 3), as for every gate. The gate polls like gate 6, since the first reads after a deploy can reach the previous version.

`test/live-gate-mcp.test.ts` runs the real script against the real handler (`src/mcp-handler.ts`, `buildServer`) and plants five broken deploys: a handler answering 500, a store that lost the document, the legacy shim deleted, a tool dropped, and a key that no longer resolves. Each exits 1 with gate 8 the only failure. Production's rollback itself is the wrangler step above, unchanged.

**Seat steps, once.** Until both are done the gate skips, says so, and puts a warning on the run:

1. Mint the probe agent (read grant on `capsid`, the `read` tool only, no repos, no flags). The key goes to `~/.capsid/agent-live-probe.key` and is printed nowhere:

   ```
   CAPSID_OPERATOR_KEY=$CAPSID_OPERATOR_KEY node scripts/mint-agents.mjs --role live-probe --apply
   ```

2. Set it as the repo secret the live job reads, from the file, so it never reaches the terminal:

   ```
   gh secret set CAPSID_LIVE_PROBE_KEY --repo DrDustinEdwards/capsid < ~/.capsid/agent-live-probe.key
   ```

Then rerun the live job of the latest master run and look for `PASS  8 MCP call through /ops/mcp`. A lost key is replaced as any agent's is: revoke `live-probe` with the `agents` tool, mint under a new name, set the secret again.

The rollback swaps code and bindings only, as above. It never undoes a D1 migration, which is why a migration is the seat's step. The guard's cases are tested in `test/deploy-pipeline.test.ts` and `test/rollback-guard.test.ts`.
