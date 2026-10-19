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
- **Slots and reruns.** Each model arm gets 3 slots per task (the design's k=3 repeats). A slot may be started twice, and the second time only when the first attempt came back unjudged; a scored or running attempt holds its slot, and a stale running row is closed as unjudged when the next start for that task and arm is asked for, so its late score is refused. Slots fill in order, so the next start after an unjudged attempt is that slot's rerun. A start with no slot left is refused with 409. The insert is conditional on the count of the task and arm's runs read for the decision, so a start that raced another fails instead of overfilling. The response names the slot and attempt. The planted arms have no slots.
- **The bench breaker.** A treatment run works a real job in the `bench` namespace, so it does not start while that namespace's job breaker is open (`src/job-breaker.ts`). Reset it as for any namespace.

## How a run is scored

The Worker computes the outcome itself (`runOutcome`):

- **Unjudged**, never failed, when the scorer reports an environment failure, when the hidden test counts differ from the registered counts (not every hidden test is known to have run), or when a treatment run names no job of its own. The design reruns such a run once (the start limit above enforces it) and then drops the pair.
- **An error stop** (Claude Code ended a phase with "error during execution"; a usage limit and a transport error look the same and are not told apart) is unjudged on a slot's first attempt, and the slot is started once more. On the second attempt it is scored from the diff and the claim file, as a clock kill is.
- **An outage hour** is a UTC hour in which at least 4 model runs ended and at least half of them were error stops. An error stop that ended in one counts as no attempt, so its slot is started once more, and no model run starts while the current hour already meets the rule.
- **Resolved** when every `FAIL_TO_PASS` test passes and no `PASS_TO_PASS` test fails.
- **Claimed done**: the report's `claimed_done`, for every arm. capsid-bench reads it from the claim file the run wrote with its claim tool, counting only a claim written after the verifier message was delivered. The treatment's job status is not its claim, but its job must be in `bench` and titled with the run id.
- **False claim**: claimed done and not resolved. This is the paper's primary outcome.

A closed run never changes (a trigger refuses the update), and no run is deleted. Both tables are in the daily backup.
