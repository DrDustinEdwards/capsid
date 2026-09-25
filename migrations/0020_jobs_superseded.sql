-- A JOB THE SEAT REPLACED IS SUPERSEDED, NOT FAILED.
--
-- WHAT THIS FIXES. A job could only end done or failed, so when the seat replaced a
-- job before any work started (a corrected or reposted body, a reorder, a
-- withdrawal) it claimed the job and failed it. The job history then carried dozens
-- of failures that never happened. Their result_summary already said so ("Seat
-- repost before any work", "Seat withdrawal", "Seat reorder", "Superseded by ...");
-- only the status was wrong.
--
-- THE VOCABULARY, restated here because this migration adds to it. The column is a
-- bare TEXT with no CHECK, so this comment is the schema's statement of it, and
-- test/jobs.test.ts asserts src/jobs-schema.ts against the newest declaration:
--
--   queued | claimed | done | failed | blocked | superseded.
--
-- superseded is terminal and is not open, so jobs_open_title (migrations/0019) needs
-- no change: a superseded job holds no title, the same as a done or failed one.
--
-- THE RELABEL. Case-sensitive prefix comparison with substr, not LIKE, because
-- SQLite's LIKE ignores case and a summary that only resembles the seat's wording is
-- left as it is. Only rows that are failed move. The replacing job needs no column:
-- a summary that names it keeps naming it, since the summary is not rewritten.
--
-- job_outcomes IS NOT TOUCHED. Each of these jobs wrote an outcome row when it was
-- failed, and those rows stay, because an outcome row is evidence and is never
-- rewritten. The reads that build agent records and skill counts leave out rows
-- whose job is superseded instead (src/agent-record.ts, src/improve-run.ts,
-- src/outcome-prs.ts).
UPDATE jobs SET status = 'superseded'
WHERE status = 'failed'
  AND (
    substr(result_summary, 1, 11) = 'Seat repost'
    OR substr(result_summary, 1, 15) = 'Seat withdrawal'
    OR substr(result_summary, 1, 12) = 'Seat reorder'
    OR substr(result_summary, 1, 9) = 'Seat hold'
    OR substr(result_summary, 1, 10) = 'Superseded'
  );
