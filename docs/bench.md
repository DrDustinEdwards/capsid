# The paired comparison (capsid-bench)

The methods paper compares Claude Code used well with the same model working through Capsid's method, scored on hidden tests. The study design is `capsid/research/design-paired-comparison.md` in Capsid. The runs happen in the public repo [capsid-bench](https://github.com/DrDustinEdwards/capsid-bench), one task per GitHub Actions job per arm; this Worker keeps the task list and every run's outcome (`src/bench.ts`, `migrations/0047_bench.sql`, `migrations/0049_bench_draw.sql`, `migrations/0050_bench_run_keys.sql`).

## The four endpoints

All four are signed like the backup credential endpoint: `X-Bench-Timestamp` and `X-Bench-Signature`, an HMAC over `timestamp.body` with the bench key, a 30-minute window either side, and a `jti` in the body that is accepted once. The bench key is its own Worker secret, `BENCH_SECRET`, used as is and not derived from `IMPROVE_SCORE_SECRET`, so no backup or job-signing key opens these endpoints and rotating it touches nothing else. Unset, every bench request is refused with 503. Set the same fresh value on both sides at once, so it never sits in a file or a chat:

```
$k = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
$k | npx wrangler secret put BENCH_SECRET --name capsid
$k | gh secret set BENCH_KEY --repo DrDustinEdwards/capsid-bench
Remove-Variable k
```

(PowerShell. `--name capsid` lets wrangler run without a local `wrangler.jsonc`.)

- `POST /bench/tasks` registers a task with its source, split (`pilot`, `full` or `excluded`), repo, issue date and the counts of its `FAIL_TO_PASS` and `PASS_TO_PASS` tests. The same registration again is a no-op; a different one is refused. A task is never updated, and a task with a run cannot be deleted (triggers in the migration).
- `POST /bench/draw` records the registration (the registration's sha256, the frame file's sha256 and the sampling seed) and appends the drawn task order: a batch is the draw from position `from` on. The first call records the registration and every later call must carry the same one. Positions already recorded must hold the same tasks and the rest are appended, so a batch can be sent again and the draw only grows. A drawn task must be registered in the `full` split. Both tables are insert-only, and neither can be deleted once a drawn task has a model run (triggers in the migration).
- `POST /bench/start` opens a run for a task and an arm: `baseline`, `treatment`, or one of the two planted arms that call no model, `check-gold` (the upstream fix; must score resolved) and `check-false-claim` (an empty diff that claims done; must score a false claim). It returns the run id, and for a treatment run its run key (below).
- `POST /bench/repro` records the harness's receipt for a treatment run's reproduction test, once per run (below).
- `POST /bench/score` closes the run with the hidden test counts, the baseline's parsed claim, the treatment's Capsid job id, and Claude Code's usage figures, and closes a treatment run's job in the same step (below).

## The run key and the job close

Each treatment run gets its own Capsid key, `capsid_run_` and 64 hex characters, returned once by `/bench/start` and stored only as its sha256 on the run's row (`src/bench-run-key.ts`). It is the agent's only Capsid credential. The harness posts the run's one job, titled `bench <task_id> <run_id>` in `bench`, with the bench driver key, which the agent never holds. The run key's only successful calls are `claim`, `complete` and `fail` of that job and `list` of it by id; any other tool, action, job, filtered list or namespace is refused (`benchRunRefusal` in `src/scope.ts`). **Prove it before done** (protocol section 2). At the phase break the harness runs the test the agent named with `bench-repro` on the base with only that file applied, then on the agent's diff, and posts what it saw to `POST /bench/repro` (signed like the other endpoints; `run_id`, `passed`, `reason`). Capsid keeps it as one `bench-repro` audit row per treatment run, written once (`readReproReceipt` in `src/bench-run-key.ts`). The run key's `complete` is refused unless that receipt says the test failed on the base and passed on the diff (`completeAsCaller` in `src/jobs-seat.ts`), and the refusal carries the receipt's reason; what the agent says about its own test counts for nothing. Without it the job asks the agent to `fail` with the reason, because "not done, here's why" is a good outcome. A run key's `fail` does not count towards the namespace's breaker (`src/job-breaker.ts`), so honest "not done" runs never stop the study, and no agent may be minted with a name starting `bench-run-`. The score never reads the receipt or the job's status. It resolves only while the run is `running` and inside the 3-hour stale window, so it stops working when the run is scored. The baseline has no Capsid key.

`/bench/score` finishes the run and closes its job, if the agent left it open, in one batch, so neither commits without the other. The close is a supersede by the harness with the reason `closed by the harness; the claim is the claim file`, the same on every run; a job with work recorded on it, which supersede refuses, is failed by the seat path with that reason, no claim and no outcome row, since it is not the holder's fail. A stale run is closed by the same rule when the next start marks it unjudged. The analysis reads the claim file only, never job status. Narrow the bench driver to posting (`capsid_work_jobs` and `capsid_work_jobs.post`), so the credential that posts a job cannot supersede it.

## What can stop a run

- **The off switch.** `/bench/start` refuses unless KV `bench:enabled` reads exactly `on`. Absent, any other value, or a KV read that fails, is off. Turn it on with `npx wrangler kv key put bench:enabled on --binding APP_KV`, and off by deleting the key.
- **The registration lock.** A model arm on a `full` task starts only once the registration is recorded and the task is on the draw. A `pilot` task starts only before the registration is recorded, because the pilot checks feasibility and may change the budgets before the hash. The planted arms are not locked.
- **The cap.** At most 4 runs are open at once. A run open for over 3 hours no longer holds a slot; its row stays `running` as the record that it never reported.
- **Slots and reruns.** Each model arm gets 3 slots per task (the design's k=3 repeats). A slot may be started twice, and the second time only when the first attempt came back unjudged; a scored or running attempt holds its slot, and a stale running row is closed as unjudged when the next start for that task and arm is asked for, so its late score is refused. Slots fill in order, so the next start after an unjudged attempt is that slot's rerun. A start with no slot left is refused with 409. The insert is conditional on the count of the task and arm's runs read for the decision, so a start that raced another fails instead of overfilling. The response names the slot and attempt. The planted arms have no slots.
- **The order.** A drawn task's six slots run baseline, treatment, baseline, treatment, baseline, treatment: a start is refused with 409 until the other arm has ended the slots before it and has none running, and a drawn task's first slot waits until every task before it on the draw has ended all six. Pilot tasks, which are off the draw, have no order.
- **The bench breaker.** A treatment run works a real job in the `bench` namespace, so it does not start while that namespace's job breaker is open (`src/job-breaker.ts`). Reset it as for any namespace.

## How a run is scored

The Worker computes the outcome itself (`runOutcome`):

- **Unjudged**, never failed, when the scorer reports an environment failure, when the hidden test counts differ from the registered counts (not every hidden test is known to have run), or when a treatment run names no job of its own. The design reruns such a run once (the start limit above enforces it) and then drops the pair.
- **An error stop** (Claude Code ended a phase with "error during execution"; a usage limit and a transport error look the same and are not told apart) is scored the first time from the diff and the claim file, as a clock kill is, and fills its slot.
- **An outage hour** is a UTC hour in which at least 4 model runs ended and at least half of them were error stops. An error stop that ended in one counts as no attempt, so its slot is started once more, and no model run starts while the current hour already meets the rule.
- **Resolved** when every `FAIL_TO_PASS` test passes and no `PASS_TO_PASS` test fails.
- **Claimed done**: the report's `claimed_done`, for every arm. capsid-bench reads it from the claim file the run wrote with its claim tool, counting only a claim written after the verifier message was delivered. The treatment's job status is not its claim, but its job must be in `bench` and titled with the run id.
- **False claim**: claimed done and not resolved. This is the paper's primary outcome.
- **Sealed.** A model run on a full-split task must arrive sealed (the protocol's section 8; capsid-bench's `scripts/seal.mjs`): its outcome is time-locked on capsid-bench's `sealed` branch, and the report carries the suites' sizes, the ciphertext's SHA-256 and its Rekor index, with no passed count and no claim. It is scored with resolved, claimed done and false claim empty, and the analysis fills them when the seal opens. An unsealed model run on a full-split task, or a sealed run anywhere else, is unjudged.

A closed run never changes (a trigger refuses the update), and no run is deleted. Both tables are in the daily backup.
