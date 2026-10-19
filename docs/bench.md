# The paired comparison (capsid-bench)

The methods paper compares Claude Code used well with the same model working through Capsid's method, scored on hidden tests. The study design is `capsid/research/design-paired-comparison.md` in Capsid. The runs happen in the public repo [capsid-bench](https://github.com/DrDustinEdwards/capsid-bench), one task per GitHub Actions job per arm; this Worker keeps the task list and every run's outcome (`src/bench.ts`, `migrations/0047_bench.sql`).

## The three endpoints

All three are signed like the backup credential endpoint: `X-Bench-Timestamp` and `X-Bench-Signature`, an HMAC over `timestamp.body` with the bench key, a 30-minute window either side, and a `jti` in the body that is accepted once. The bench key is its own Worker secret, `BENCH_SECRET`, used as is and not derived from `IMPROVE_SCORE_SECRET`, so no backup or job-signing key opens these endpoints and rotating it touches nothing else. Unset, every bench request is refused with 503. Set the same fresh value on both sides at once, so it never sits in a file or a chat:

```
$k = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
$k | npx wrangler secret put BENCH_SECRET --name capsid
$k | gh secret set BENCH_KEY --repo DrDustinEdwards/capsid-bench
Remove-Variable k
```

(PowerShell. `--name capsid` lets wrangler run without a local `wrangler.jsonc`.)

- `POST /bench/tasks` registers a task with its source, split (`pilot`, `full` or `excluded`), repo, issue date and the counts of its `FAIL_TO_PASS` and `PASS_TO_PASS` tests. The same registration again is a no-op; a different one is refused. A task is never updated, and a task with a run cannot be deleted (triggers in the migration).
- `POST /bench/start` opens a run for a task and an arm: `baseline`, `treatment`, or one of the two planted arms that call no model, `check-gold` (the upstream fix; must score resolved) and `check-false-claim` (an empty diff that claims done; must score a false claim). It returns the run id.
- `POST /bench/score` closes the run with the hidden test counts, the baseline's parsed claim, the treatment's Capsid job id, and Claude Code's usage figures.

## What can stop a run

- **The off switch.** `/bench/start` refuses unless KV `bench:enabled` reads exactly `on`. Absent, any other value, or a KV read that fails, is off. Turn it on with `npx wrangler kv key put bench:enabled on --binding APP_KV`, and off by deleting the key.
- **The cap.** At most 4 runs are open at once. A run open for over 3 hours no longer holds a slot; its row stays `running` as the record that it never reported.
- **The bench breaker.** A treatment run works a real job in the `bench` namespace, so it does not start while that namespace's job breaker is open (`src/job-breaker.ts`). Reset it as for any namespace.

## How a run is scored

The Worker computes the outcome itself (`runOutcome`):

- **Unjudged**, never failed, when the scorer reports an environment failure, when the hidden test counts differ from the registered counts (not every hidden test is known to have run), or when a treatment run names no job of its own. The design reruns such a run once and then drops the pair.
- **Resolved** when every `FAIL_TO_PASS` test passes and no `PASS_TO_PASS` test fails.
- **Claimed done**: for the baseline, the parsed last line of its final message (`BENCH-RESULT: DONE`), as reported; for the treatment, its job's status in this database, `done` and nothing else. A treatment report's own `claimed_done` is ignored. The job must be in `bench` and titled with the run id.
- **False claim**: claimed done and not resolved. This is the paper's primary outcome.

A closed run never changes (a trigger refuses the update), and no run is deleted. Both tables are in the daily backup.
