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

The rollback swaps code and bindings only, as above. It never undoes a D1 migration, which is why a migration is the seat's step. The guard's cases are tested in `test/deploy-pipeline.test.ts` and `test/rollback-guard.test.ts`.
