# Comment share: src, test, scripts

Measured 2026-09-16 against `feb4ebfc60f248b2aad6ced3bf26e2531d28560f`
(`List jobs without bodies, page auto-merge reads, and refuse corrupt job requirements (#58)`).
Blobs from git HEAD, not the working tree. The clone had uncommitted edits under
`src/jobs.ts`, `src/job-outcomes.ts`, `src/tools/jobs.ts`, `test/gate-policy.test.ts`,
and `test/retry-cap.test.ts`; those are not in these numbers.

This file is a measurement. It is not a ruling.

## Scope

| Glob | Files | Notes |
|---|---:|---|
| `src/**/*.ts` | 73 | includes `src/github/`, `src/improve/`, `src/tools/` |
| `test/**/*.ts` | 122 | includes `test/adversarial/corpus.ts`; not `test-integration/` |
| `scripts/**/*.mjs` | 17 | not `scripts/*.d.mts` |
| **Total** | **212** | |

## Method

TypeScript `createScanner` (`skipTrivia=false`), `ScriptTarget.Latest`.

- Comment tokens: `SingleLineCommentTrivia` and `MultiLineCommentTrivia` (`//`, `/* */`, JSDoc). `ShebangTrivia` is excluded.
- Comment bytes: UTF-8 byte length of those tokens, including the `//` and `/* */` delimiters. The newline after a `//` line is not in the token.
- Comment line: a non-blank line whose every non-whitespace character falls inside a comment token.
- Mixed line (code plus a trailing or inline comment): counted as a code line. Its comment characters still count as comment bytes. There are 28 mixed lines in the whole corpus, so they do not move the totals.
- Line share: comment lines / non-blank lines.
- Byte share: comment bytes / total bytes.
- Line norm used for comparison: 20% of non-blank lines. That number is not stated in `capsid/conventions.md` or `CLAUDE.md`.

Strings, template literals, and regexes are not comments because they are not comment tokens.

## Totals and trees

| Tree | Files | Bytes | Comment bytes | Byte share | Non-blank | Comment lines | Line share | Files > 20% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| src | 73 | 957,808 | 120,954 | 12.6% | 19,057 | 1,793 | 9.4% | 18 |
| test | 122 | 1,321,906 | 143,939 | 10.9% | 24,829 | 2,162 | 8.7% | 11 |
| scripts | 17 | 159,942 | 39,062 | 24.4% | 3,129 | 608 | 19.4% | 11 |
| **TOTAL** | **212** | **2,439,656** | **303,955** | **12.5%** | **47,015** | **4,563** | **9.7%** | **40** |

40 of 212 files (18.9%) are above the 20% line norm. 172 are at or under it.

## Per directory

`src/` here is the 59 files at the top of `src/`, not the whole tree. Same for `test/` versus `test/adversarial/`.

| Directory | Files | Bytes | Comment bytes | Byte share | Non-blank | Comment lines | Line share | vs 20% lines | Files > 20% |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|
| scripts/ | 17 | 159,942 | 39,062 | 24.4% | 3,129 | 608 | 19.4% | 0.6pp under | 11 |
| src/ | 59 | 641,597 | 100,842 | 15.7% | 13,159 | 1,491 | 11.3% | under | 18 |
| src/github/ | 4 | 89,994 | 5,232 | 5.8% | 1,823 | 78 | 4.3% | under | 0 |
| src/improve/ | 4 | 75,581 | 3,563 | 4.7% | 1,629 | 53 | 3.3% | under | 0 |
| src/tools/ | 6 | 150,636 | 11,317 | 7.5% | 2,446 | 171 | 7.0% | under | 0 |
| test/ | 121 | 1,316,523 | 141,760 | 10.8% | 24,715 | 2,125 | 8.6% | under | 10 |
| test/adversarial/ | 1 | 5,383 | 2,179 | 40.5% | 114 | 37 | 32.5% | 12.5pp over | 1 |

## Against the 20% line norm

- **Total line share is 9.7%, under the norm by 10.3 percentage points.** Byte share is 12.5%, also under 20%.
- **src** 9.4% lines, **test** 8.7% lines: both well under. Nested `src/github/`, `src/improve/`, and `src/tools/` are 3.3% to 7.0%.
- **scripts** 19.4% lines, 0.6pp under the norm, but 24.4% of bytes, and 11 of 17 files over 20% lines. The tree average is one large-code file away from crossing; the file count is already over.
- **test/adversarial/** is one file at 32.5% lines.
- Byte share runs a few points above line share in every tree. Comments here are long prose lines; code lines are often short.

The 20% line norm is a ceiling on density, not a target. A tree can sit under it while individual files sit far above it. That is the pattern: 9.7% overall, 40 files over 20%, and the top of the list at 95%.

## Ten files, highest comment line share

| Rank | Line share | Comment bytes | Non-blank | File |
|---:|---:|---:|---:|---|
| 1 | 95.2% | 1,300 | 21 | test/seed-scores.ts |
| 2 | 87.2% | 5,331 | 94 | scripts/bindings.mjs |
| 3 | 48.9% | 3,070 | 88 | scripts/reap-probe-clients.mjs |
| 4 | 48.6% | 3,314 | 111 | scripts/sql-statements.mjs |
| 5 | 47.8% | 1,534 | 46 | src/scorer-identity.ts |
| 6 | 45.2% | 912 | 31 | test/glob-canary.test.ts |
| 7 | 43.2% | 12,543 | 435 | src/scope.ts |
| 8 | 39.7% | 1,554 | 73 | scripts/improve-derive-key.mjs |
| 9 | 39.7% | 1,698 | 68 | scripts/freshness-lib.mjs |
| 10 | 37.5% | 226 | 8 | src/approval.ts |

`test/seed-scores.ts` is 20 comment lines and one `export { seedScoresDoc }` re-export.
`scripts/bindings.mjs` is 82 comment lines and 12 code lines.
`src/approval.ts` is a small file (8 non-blank lines); three comment lines put it on this list.

## Ten files, most comment bytes

| Rank | Comment bytes | Line share | File bytes | File |
|---:|---:|---:|---:|---|
| 1 | 12,543 | 43.2% | 25,946 | src/scope.ts |
| 2 | 9,463 | 18.6% | 38,174 | test/fakes.ts |
| 3 | 5,331 | 87.2% | 6,085 | scripts/bindings.mjs |
| 4 | 4,777 | 34.2% | 10,881 | src/outcome-prs.ts |
| 5 | 4,574 | 37.0% | 9,570 | src/agent-record.ts |
| 6 | 4,550 | 26.1% | 13,532 | src/review.ts |
| 7 | 4,439 | 31.2% | 9,811 | src/improve-anthropic.ts |
| 8 | 4,396 | 29.8% | 11,198 | src/agents-schema.ts |
| 9 | 4,304 | 17.3% | 16,140 | src/job-outcomes.ts |
| 10 | 4,086 | 23.3% | 12,653 | src/agents-admin.ts |

`src/scope.ts` is on both lists: 188 of 435 non-blank lines are comments, 12.5 KB of comment of 26 KB in the file. That is 4.1% of all comment bytes in the 212-file corpus.

`test/fakes.ts` is second on bytes and under the line norm (18.6%). The comments are a long preamble plus per-capability notes on a large fake.

## What those comments contain

Read at HEAD, not sampled at random:

- `src/scope.ts` opens with what the one enforcement point replaces, three failure modes of the old `mayWrite` boolean, where the registrar versus the handler must run, and a dated note that two tools gated admin inside their handlers until 2026-09-16, citing CLAUDE.md rule 6.
- `scripts/bindings.mjs` records why the OAuth KV id must not be copied, a 2026-09-07 CPU-limit resize with measured `cpuTimeMs` 1390, a table-size projection, and the 2026-08-15 KV split.
- `test/seed-scores.ts` records a move on 2026-09-07, a move back the next day, a 28/30 versus 30/30 holdout result, and a pointer to `capsid/improve/TASK-wire-the-metrics.md`.
- `src/jobs.ts` (not on either top-ten list; still the house shape) states the work-queue ruling, the keyed-UPDATE rule, and why `meta.changes` cannot count a batch.

The repeated shape is: a module-top essay of incident, measurement, and why-not-the-other-way, then the code.

## The rule about where reasoning lives

Read from live Capsid `conventions.md` (and the layer-2 siblings it points at) and from repo `CLAUDE.md`. Neither file states a 20% comment budget.

**CLAUDE.md (this repo, layer 8).** The precedence model "bans a repo file from restating canon". This file was cut on 2026-08-14 because it had become a second canon store. Hard rule 12 puts comments in the no-mannered-prose rule and says: if a sentence can be cut without losing a fact, cut it.

**capsid/repo-structure.md.** Layer 2 (`conventions.md`): one copy, nowhere restated. Layer 3 (`decisions.md`): why the rules are what they are. Duplication rule: a fact lives in exactly one document; everything else points. "canon lives in D1, never in a repo."

**capsid/conventions-capsid.md** (split from conventions.md 2026-09-16, same authority). Three classes: current state the repo also knows never lives in Capsid; reversals and bindings always do. A reversal is a ruling plus the measurement that forced it. A binding is a decision that changes what the code does.

Taken together: the why of a ruling lives in Capsid decisions. A repo file, comments included, does not restate that why. A comment that remains is a local, non-obvious constraint the next editor of that line needs, not the history of how the constraint was reached.

## Does the measured share follow from that rule?

The **corpus average does sit where a "keep comments modest" reading would put it**: 9.7% of non-blank lines, 12.5% of bytes, both under 20%. Nested implementation directories (`src/github/`, `src/improve/`, `src/tools/`) at 3% to 7% are the closest match to "comments only for a non-obvious constraint".

The **average does not follow from putting reasoning in Capsid**. The comments that exist are, in the files that dominate the share, that reasoning: dated incidents, measurements, what a rewrite replaced, citations of CLAUDE.md rule 6. Those are reversals and bindings. The layer model says they live in `capsid/decisions.md`. They are also written into source, where nothing gates them.

So:

1. Total line share is under the 20% norm. That is a density fact, not evidence that reasoning has moved to Capsid.
2. 40 files are over 20% lines. Four of the ten highest-share files are under `scripts/`. `scripts/` as a tree is 19.4% lines and 24.4% bytes, with 11 of 17 files over the line norm.
3. The bytes ranking is led by `src/scope.ts` (12.5 KB of comments, 43.2% lines), then `test/fakes.ts`, then `scripts/bindings.mjs`. Those three are essays of why, not one-line constraints.
4. If the rule were the cause of the share, the high-share files would be the ones that only name a local constraint. They are the ones that restate canon and incident. The share is produced by a house comment style that fights the layer model, averaged down by a larger set of low-comment modules.

No change is proposed here.
