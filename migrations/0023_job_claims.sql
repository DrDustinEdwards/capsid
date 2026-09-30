-- CLAIMS APART FROM VERIFIED OUTCOMES (roadmap P0, the methods paper's core dataset).
-- Ruling: capsid/decisions.md, 2026-09-29, "Capsid MCP roadmap, build or don't build".
--
-- WHAT WAS MISSING. job_outcomes (0011) stores one value per field: where the Worker
-- could ask GitHub it stores GitHub's number IN PLACE OF the driver's, so the thing
-- the paper measures, how often an agent's own account of its work is wrong, was
-- overwritten at the moment it was recorded. Only tests_added and the free-text
-- result_summary survived as claims.
--
-- THREE TABLES, ALL APPEND-ONLY, each enforced by triggers rather than by the code
-- that writes it. A record that can be rewritten after the fact is not evidence.
--   job_claims       what the agent said, captured before any verification runs
--   job_evaluations  one row per check, in the shape of the OpenTelemetry
--                    gen_ai.evaluation.result event, the claim and the verified value
--                    side by side
--   job_touches      every time a human (or a policy acting for one) touched a job:
--                    gates, resumes, approvals, notes, corrections, releases
--
-- NULL IS NOT FALSE, on 0011's reasoning: a field the agent did not state is NULL,
-- never 0 and never false. "Nobody said" and "said none" are different facts.
--
-- Times are ISO 8601 with milliseconds, like jobs.updated_at, not audit_log's
-- second-precision datetime('now'): a human-touch wait is a difference of two times.
--
-- Additive: three new tables, their indexes and triggers. Nothing existing changes.

-- WHAT THE AGENT SAID, one row per complete, fail or block call that reached the
-- transition. A job blocked three times and then completed has four rows.
CREATE TABLE IF NOT EXISTS job_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('complete', 'fail', 'block')),
  -- The caller that made the claim, and the job's namespace, copied at the time.
  agent TEXT NOT NULL,
  namespace TEXT NOT NULL,
  -- The claim-bearing arguments exactly as sent: evidence, claim, result_summary or
  -- reason, result_ref, command. JSON. Kept whole so a later reading of the
  -- structured columns below can always be checked against what was actually said.
  raw TEXT NOT NULL,
  -- Pull requests the agent says it opened and says are merged: JSON arrays of URLs,
  -- and their lengths. From claim.prs_opened / claim.prs_merged, else evidence.prs
  -- for opened.
  prs_opened_urls TEXT,
  prs_merged_urls TEXT,
  prs_opened INTEGER,
  prs_merged INTEGER,
  -- Counts the agent reported (evidence.commits, files_changed, tests_added).
  commits INTEGER,
  files_changed INTEGER,
  tests_added INTEGER,
  -- Tests the agent says it ran, and their result.
  tests_run INTEGER,
  tests_passed INTEGER,
  tests_failed INTEGER,
  tests_result TEXT CHECK (tests_result IS NULL OR tests_result IN ('pass', 'fail', 'partial', 'not_run')),
  -- What the agent says about deployment.
  deploy_state TEXT CHECK (deploy_state IS NULL OR deploy_state IN ('none', 'pending', 'deployed', 'verified', 'failed')),
  -- Files the agent says it touched: a JSON array of repo-relative paths.
  files_touched TEXT,
  -- SELF-REPORTED versions, recorded and never used to authorize anything (the same
  -- ruling refuses authorization on clientInfo or User-Agent): the model id, the
  -- client (e.g. claude-code) and its version, and the permission mode.
  model_id TEXT,
  client_name TEXT,
  client_version TEXT,
  permission_mode TEXT,
  -- The Worker's own deployed commit (env.BUILD_SHA) when the claim was recorded.
  -- Not from the agent.
  capsid_sha TEXT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS job_claims_job ON job_claims (job_id, id);
CREATE INDEX IF NOT EXISTS job_claims_agent ON job_claims (agent, namespace);

-- ONE ROW PER CHECK. Named for OpenTelemetry's gen_ai.evaluation.result event:
-- name is gen_ai.evaluation.name, score_value and score_label are
-- gen_ai.evaluation.score.value and .label, explanation is .explanation.
CREATE TABLE IF NOT EXISTS job_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  -- The claim this evaluates, when there is one.
  claim_id INTEGER,
  name TEXT NOT NULL CHECK (name IN ('pr_merged', 'prs_opened', 'commits', 'files_changed', 'ci_green', 'hidden_tests', 'scope_respected')),
  -- The verified value as a number (1 or 0 for a yes/no check, a count otherwise),
  -- and its label: pass | fail | unknown. NULL value with label unknown means the
  -- check could not run.
  score_value REAL,
  score_label TEXT NOT NULL CHECK (score_label IN ('pass', 'fail', 'unknown')),
  -- The claim and the verified value side by side, each JSON, each NULL when absent.
  claimed TEXT,
  verified TEXT,
  -- agree | disagree | unclaimed (the agent said nothing) | unchecked (no verified
  -- value). Computed once at write time from the two columns above.
  agreement TEXT NOT NULL CHECK (agreement IN ('agree', 'disagree', 'unclaimed', 'unchecked')),
  -- worker (this Worker, against GitHub) | model (a second model) | human.
  evaluator TEXT NOT NULL CHECK (evaluator IN ('worker', 'model', 'human')),
  -- Which one: 'capsid@<sha>' for the worker, the actor string otherwise.
  evaluator_id TEXT NOT NULL,
  explanation TEXT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS job_evaluations_job ON job_evaluations (job_id, id);
CREATE INDEX IF NOT EXISTS job_evaluations_name ON job_evaluations (name, agreement);

-- THE HUMAN-TOUCH LOG. Without it, human effort confounds any comparison of agents:
-- a job that needed four rescues and one that needed none both end "merged".
CREATE TABLE IF NOT EXISTS job_touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  -- gate: the job blocked on a command for someone else. resume: it was sent back.
  -- approval: a resume that approved a gated command. correction: a resume that spent
  -- a correction. note: a resume note longer than its reason. release, supersede,
  -- admin_fail: the seat ended or freed the job. review: a REVIEW verdict acted on.
  kind TEXT NOT NULL CHECK (kind IN ('gate', 'resume', 'approval', 'correction', 'note', 'release', 'supersede', 'admin_fail', 'review')),
  actor TEXT NOT NULL,
  -- human (access:, github:) | seat | driver | policy (a driver's own resume under a
  -- signed gate policy) | reviewer | system. From the actor, at write time.
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'seat', 'driver', 'policy', 'reviewer', 'system')),
  -- For a touch that ends a wait (resume, approval, correction, release, supersede,
  -- admin_fail): milliseconds since the job's latest gate. NULL when there was none.
  waited_ms INTEGER,
  -- JSON: the reason, the command, the note, the policy class, as applicable.
  detail TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS job_touches_job ON job_touches (job_id, id);

-- APPEND-ONLY, enforced here. A DELETE on an empty table fires nothing, so a restore
-- that empties the table before importing (scripts/restore-rehearsal.mjs) still works.
CREATE TRIGGER IF NOT EXISTS job_claims_append_only_update BEFORE UPDATE ON job_claims
BEGIN SELECT RAISE(ABORT, 'job_claims is append-only'); END;
CREATE TRIGGER IF NOT EXISTS job_claims_append_only_delete BEFORE DELETE ON job_claims
BEGIN SELECT RAISE(ABORT, 'job_claims is append-only'); END;
CREATE TRIGGER IF NOT EXISTS job_evaluations_append_only_update BEFORE UPDATE ON job_evaluations
BEGIN SELECT RAISE(ABORT, 'job_evaluations is append-only'); END;
CREATE TRIGGER IF NOT EXISTS job_evaluations_append_only_delete BEFORE DELETE ON job_evaluations
BEGIN SELECT RAISE(ABORT, 'job_evaluations is append-only'); END;
CREATE TRIGGER IF NOT EXISTS job_touches_append_only_update BEFORE UPDATE ON job_touches
BEGIN SELECT RAISE(ABORT, 'job_touches is append-only'); END;
CREATE TRIGGER IF NOT EXISTS job_touches_append_only_delete BEFORE DELETE ON job_touches
BEGIN SELECT RAISE(ABORT, 'job_touches is append-only'); END;
