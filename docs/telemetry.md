# Telemetry: what Claude Code sessions cost, per job

Claude Code can export OpenTelemetry metrics and events. Capsid receives them, keeps a
few totals per session, and writes each job's cost, tokens and active time onto the
job's outcome row when the job completes or fails. Nothing is on until the settings
below are set; the receiver is live either way and stores nothing it is not sent.

## What Capsid receives

| Route | What it keeps |
| --- | --- |
| `POST /ops/otlp/v1/metrics` | Per session, metric, type and model, in `session_usage`: `claude_code.cost.usage` (USD), `claude_code.token.usage` (input, output, cacheRead, cacheCreation), `claude_code.active_time.total` (user, cli; seconds), `claude_code.commit.count`, `claude_code.pull_request.count`, `claude_code.lines_of_code.count` (added, removed) |
| `POST /ops/otlp/v1/logs` | A count of `api_error` events per session and HTTP status, as the metric `claude_code.api_error`. Every other event is dropped |

- **Format.** OTLP/HTTP JSON only (`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`); protobuf is
  refused with 415. A gzip body is accepted. The cap is 1MB before and after
  decompression (413 above it).
- **Arithmetic.** Delta points (Claude Code's default temporality) are added to the
  stored total. A cumulative point replaces it. `asInt` sent as a decimal string is read
  as a number.
- **Answers.** 200 `{}` when every point was kept. 200 with
  `partialSuccess.rejectedDataPoints` when some could not be read (no `session.id`, a
  negative or non-numeric value, an unknown type attribute). Metrics Capsid does not
  keep are ignored, not rejected. 400 for a body that is not JSON; 503 when D1 could not
  be written, so the exporter retries.
- **Never stored.** A prompt, a response, tool input or output, a log record's body,
  `user.email`, organization or account ids, or any attribute not named above. The
  receiver reads an allowlist; a new attribute is ignored until the code names it
  (`test/ops-otlp.test.ts`, the PLANT test).

## Who may send, and which job it counts toward

The bearer is resolved like every other key (`resolveAgent`). No key, or one that
resolves to nobody, is 401 with `WWW-Authenticate: Bearer realm="capsid-hooks"`.
Accepted: a minted driver or the admin key, holding the write grant
(checked through `checkScope`). A read-only key or any other kind is 403.

The hook receiver (`/ops/hooks`, docs/hooks.md) uses the same caller check.

A session belongs to the key that first reported it, by hook or by telemetry. The
first export for a new session id writes its `agent_sessions` row (last event `otlp`)
in the same batch as the usage, and every usage write is conditional on that row
naming the caller. Points for a session another key reported first are not recorded:
they are counted in `partialSuccess.rejectedDataPoints`, and the `errorMessage` says
why.

The job a session's usage counts toward (`src/ops-session-auth.ts`):

1. A session already bound (its `agent_sessions` row) keeps that job.
2. Otherwise the single job a driver holds claimed. A driver
   holding none, or several, records the usage against no job.
3. The `capsid.job_id` resource attribute never picks a job. Where it disagrees with the
   binding, the point is recorded against the binding and the answer's `partialSuccess`
   says so.

A `session_usage` row keeps the first job it was written with.

## The outcome row

At `complete` and `fail` (and the seat's fail of a held job), the outcome row takes
`cost_usd`, `tokens_input`, `tokens_output`, `tokens_cache_read`,
`tokens_cache_creation` and `active_seconds`, summed over the job's `session_usage`
rows. A column whose metric never arrived is NULL, never 0: NULL means no telemetry
reached Capsid. Once tokens have arrived, a token type with no point is 0, because
Claude Code exports no point for a counter that did not move.

`job_outcomes` was NULL for every job through 2026-10-04 (347 rows, `session_usage` empty, measured through D1) because the exporter below was never turned on for the machines that run drivers. Until it is, an agent can state what its session used in `claim.usage` (docs/work-queue.md). The `capsid_admin_read_claims` aggregate reports the two sources side by side and never adds them: a job with both would count twice. Telemetry stays the measured one.

The row is written once. Claude Code exports on an interval (60 seconds by default), so
usage from the last interval before `complete` can arrive after it; it stays in
`session_usage` and is not added to the row.

## Turning it on for Dustin's machine

Project and local settings cannot set the exporter (Claude Code 2.1.282 and later):
user settings, managed settings or the shell only. So this goes in
`~/.claude/settings.json`, merged into any `env` block already there:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://mcp.dustinedwards.info/ops/otlp"
  }
}
```

The exporter appends `/v1/metrics` and `/v1/logs` to the endpoint. Leave
`OTEL_LOG_USER_PROMPTS` and `OTEL_LOG_TOOL_DETAILS` unset: the receiver drops that
content, and unset means it is never sent.

The key is not written into that file. Set the header in the shell Claude Code starts
from, from the driver key the machine's sessions already hold (named
`CAPSID_DRIVER_KEY` here; use whichever variable holds it):

```powershell
# PowerShell profile ($PROFILE)
$env:OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer $env:CAPSID_DRIVER_KEY"
```

```bash
# ~/.bashrc (Git Bash)
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${CAPSID_DRIVER_KEY}"
```

Then start a new session and check: after a minute of work,
`SELECT metric, kind, value FROM session_usage ORDER BY updated_at DESC LIMIT 5`
shows rows. A 401 or 403 from the exporter appears in Claude Code's debug log
(`claude --debug`).

Usage from an interactive session counts toward a job only while that driver key holds
exactly one claimed job.
