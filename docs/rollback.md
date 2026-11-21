# Rollback

Restore is about data. Rollback is about code: a deploy shipped a bad Worker and the fix is to serve the previous version now.

```
npx wrangler deployments list
npx wrangler rollback [<version-id>]
```

With no id it reverts to the immediately previous deployment. Pass a version id to go further back. It swaps the Worker script and that version's bindings and vars only. It does not touch D1, R2 or KV data, and it does not change `master`: the next push redeploys `HEAD` through CI and supersedes the rollback. Afterwards `/health` reports the rolled-back sha, so the scheduled live gate (which asserts `/health` sha equals master head) goes red until the fix ships. That red is correct. Production is behind master on purpose.

## The automatic rollback in CI

Most rollbacks never need the command above: CI does it. Every push to `master` deploys through devkit's shared `worker-deploy.yml` (the `deploy` job in `.github/workflows/ci.yml`), as every other site does; devkit's README, "The shared deploy", is the reference.

- **Gradually.** The new version takes 10% of traffic beside the live one. Its `live gate` job reads `/health` until it reports this run's commit, waits 10 minutes, runs `scripts/verify-live.mjs` with `EXPECT_SHA` (every request carries `Cloudflare-Workers-Version-Overrides`, so each gate judges the new version), compares both versions' error rates, then gives the new version all traffic.
- **Exit 1 is a refusal.** A gate answered and said no, or the new version's error rate is clearly worse: "Roll back the deploy this run shipped" sends traffic back to the version it shared with.
- **Exit 3 is "could not run".** No gate got an answer (a reset connection, a timeout). Nothing refused the deploy, so nothing is rolled back; the job fails, the split stays as it is, and the run summary has the command that sends everything back. One ECONNRESET rolled back a good deploy on 2026-09-18 before this split.
- **Only what this run put live**, checked by devkit's rollback guard against `/health`, so a rerun never rolls back a deploy that is no longer live, and the sha is read back afterwards rather than assumed.
- **A Durable Object migration** (a new `migrations` entry in `wrangler.jsonc.example`) cannot go out gradually: Cloudflare applies it only with `wrangler deploy` and refuses a version upload carrying one. That pull request sets `gradual-percent: 0` for its deploy.
- **master is not changed.** The bad commit stays on `master`. Land a fix or revert it; the next push deploys again through the same gate.

The six-hourly `scheduled live check` job runs the same script against master head with what the deploy's gate leaves out: gate 2b's read of the OAuth KV canary (the deploy's verify command gets no Cloudflare secret) and gate 1c's backup freshness. It never deploys or rolls back.

Capsid remembers each one. The watcher reads the live gate job (named "live gate", or "<caller job> / live gate" when the gate runs in a called workflow such as devkit's worker-deploy.yml) of each new push run, for every repo on `DEPLOY_ROSTER` (`src/deploy-outcomes.ts`: the five app repos plus carrel, julieedwards, txasm, bsw, capsomer, enarratio and prelum), and records it in `deploy_outcomes` (`verified`, `rolled_back`, `rollback_failed`, `rollback_skipped` or `unverified`), with a rollback's time to restore. The Portal's CI page turns the rows into DORA's measures per repo: deploys per week, change failure rate and median time to restore. A rollback, or one that did not take effect, opens a watcher finding. GitHub does not serve the step summary through its API, so the watcher reads the step's `::error::` annotations instead: their wording ("rolled back: was ...", "not rolling back", "the rollback did not take effect") is what `src/deploy-outcomes.ts` matches, and changing it in devkit means changing it there (docs/autonomy.md, "Deploys").

## The MCP call (gate 8)

Every other gate stops before the MCP connection: OAuth metadata, `/register`, the consent page, the Access redirect, headers, and a 401 from `/ops/mcp` with no key. A deploy whose sign-in works and whose tool calls are broken passed all of them (job_bb06c9be24c4). Gate 8 makes the calls a client makes, through `/ops/mcp` with the `live-probe` agent's key, in both protocol eras Capsid serves (`scripts/mcp-probe-lib.mjs`):

- 2025-11-25: `initialize`, `notifications/initialized`, `tools/list`, then `read` of `capsid/conventions.md`;
- 2026-07-28: `server/discover`, `tools/list` (which must also carry `ttlMs` and `cacheScope`), then the same `read`.

`tools/list` must return the served tool count (a test holds the script's number to `TOOL_GRANTS`), and the read must return the document with the word "conventions" in it. Any other answer, a 401 included, is a refusal: exit 1, and the step above rolls the deploy back. A 401 can also mean the key was revoked or mistyped, and the gate's message says so; rolling back is still the safe answer, because a deploy that broke key resolution looks the same. No answer at all is could-not-run (exit 3), as for every gate. The gate polls like gate 6, since the first reads after a deploy can reach the previous version.

`test/live-gate-mcp.test.ts` runs the real script against the real handler (`src/mcp-handler.ts`, `buildServer`) and plants five broken deploys: a handler answering 500, a store that lost the document, the legacy shim deleted, a tool dropped, and a key that no longer resolves. Each exits 1 with gate 8 the only failure. Production's rollback itself is the wrangler step above, unchanged.

**Seat steps, once.** Until both are done the gate skips, says so, and puts a warning on the run:

1. Mint the probe agent as the admin with `capsid_admin_manage_agents` action `mint`, using the `live-probe` row of `ROLES` in `scripts/roles.ts` (read grant on `capsid`, the `capsid_read_doc` tool only, no repos, no flags). Save the key it returns once to `~/.capsid/agent-live-probe.key`.

2. Set it as the repo secret the deploy passes to its live gate (`VERIFY_TOKEN`) and the scheduled check reads, from the file, so it never reaches the terminal:

   ```
   gh secret set CAPSID_LIVE_PROBE_KEY --repo DrDustinEdwards/capsid < ~/.capsid/agent-live-probe.key
   ```

Then rerun the scheduled live check (Run workflow on CI) and look for `PASS  8 MCP call through /ops/mcp`. A lost key is replaced as any agent's is: revoke `live-probe` with the `capsid_admin_manage_agents` tool, mint under a new name, set the secret again.

The rollback swaps code and bindings only, as above. It never undoes a D1 migration: the deploy records the D1 Time Travel bookmark before it migrates, and the run summary has the restore command. The guard's cases are tested in devkit.
