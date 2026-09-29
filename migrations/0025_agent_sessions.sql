-- LIVE SESSIONS, HOOK EVENTS AND TELEMETRY SUMMARIES (job queue: hook and OTLP receivers).
--
-- WHAT WAS MISSING. Nothing told Capsid that a session was waiting on a person, had
-- finished, or had stopped on a rate limit or a billing error, so Dustin relayed
-- between tabs and the seat by hand; and nothing recorded what a job cost.
--
-- Claude Code sends hook events (POST /ops/hooks) and OpenTelemetry metrics
-- (POST /ops/otlp/v1/metrics). Both authenticate with the session's own driver or
-- runner key. Only SUMMARIES are kept: never a prompt, a response, tool input or
-- output, or a transcript path's contents.
--
-- Additive: three new tables, their indexes, and six nullable columns on
-- job_outcomes (NULL means no telemetry reached Capsid for that job, never 0).
-- ALTER TABLE ADD COLUMN is not idempotent; wrangler runs each file once.

-- One row per Claude Code session Capsid has heard from.
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  -- The key that sent it (actor string) and the job it was working, bound at the
  -- first event from the caller's claimed job or runner-key binding.
  agent TEXT NOT NULL,
  job_id TEXT,
  namespace TEXT,
  -- From SessionStart: startup | resume | clear | compact | fork, and the model.
  source TEXT,
  model TEXT,
  permission_mode TEXT,
  started_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  last_event TEXT NOT NULL,
  -- The newest Notification's notification_type, and whether the session is waiting
  -- on a person (agent_needs_input, permission_prompt, idle_prompt, an elicitation
  -- dialog) until a later event says otherwise.
  last_notification_type TEXT,
  needs_input INTEGER NOT NULL DEFAULT 0 CHECK (needs_input IN (0, 1)),
  -- StopFailure's error (rate_limit, billing_error, ...), newest.
  last_failure TEXT,
  -- SessionEnd's reason, and when.
  ended_at TEXT,
  end_reason TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_sessions_job ON agent_sessions (job_id);
CREATE INDEX IF NOT EXISTS agent_sessions_live ON agent_sessions (ended_at, last_event_at);

-- Every hook event received, trimmed to metadata. Pruned by age in code.
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  job_id TEXT,
  agent TEXT NOT NULL,
  -- hook_event_name, and its type: notification_type, StopFailure's error,
  -- ConfigChange's source, SessionStart's source or SessionEnd's reason.
  event TEXT NOT NULL,
  subtype TEXT,
  -- JSON of the allowlisted, length-capped fields (a notification's title and message,
  -- a config file path). Never a prompt, a response or tool content.
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_events_session ON session_events (session_id, id);
CREATE INDEX IF NOT EXISTS session_events_job ON session_events (job_id, id);

-- Telemetry totals per session, metric and attribute. Delta points are added;
-- cumulative points replace (the receiver reads aggregationTemporality).
CREATE TABLE IF NOT EXISTS session_usage (
  session_id TEXT NOT NULL,
  job_id TEXT,
  -- e.g. claude_code.cost.usage, claude_code.token.usage, claude_code.active_time.total,
  -- claude_code.commit.count, claude_code.pull_request.count, claude_code.lines_of_code.count
  metric TEXT NOT NULL,
  -- The metric's type attribute (input, output, cacheRead, cacheCreation, user, cli,
  -- added, removed) or '' when it has none; and the model or ''.
  kind TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  value REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, metric, kind, model)
);
CREATE INDEX IF NOT EXISTS session_usage_job ON session_usage (job_id, metric);

-- Per-job cost and time, summed from session_usage over the job's sessions when the
-- outcome row is written. NULL when no telemetry reached Capsid for the job.
ALTER TABLE job_outcomes ADD COLUMN cost_usd REAL;
ALTER TABLE job_outcomes ADD COLUMN tokens_input INTEGER;
ALTER TABLE job_outcomes ADD COLUMN tokens_output INTEGER;
ALTER TABLE job_outcomes ADD COLUMN tokens_cache_read INTEGER;
ALTER TABLE job_outcomes ADD COLUMN tokens_cache_creation INTEGER;
ALTER TABLE job_outcomes ADD COLUMN active_seconds REAL;
