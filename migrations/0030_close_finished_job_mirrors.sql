-- ONE-TIME BACKFILL (job_0ad440fbb381). A job's mirror document (jobs/<id>.md, type
-- task) is rewritten on every transition and closes on a finished job. The watcher's
-- clear (clearFinding) failed jobs without rewriting it, so about 60 mirrors of failed
-- watcher findings stayed "active" and brief, search and lint read them as open work.
-- clearFinding now goes through markJobFailed. This closes the ones already stranded.
--
-- Only documents.status changes. The body is left alone, so a stranded mirror still
-- reads "status: queued" in its text; the jobs table is the source of truth for status.
-- Each document is snapshotted to document_versions and gets one audit row first
-- (CLAUDE.md, snapshot rule), both selected by the same condition as the UPDATE, so the
-- count of 'job-mirror-closed' rows this writes is the count closed. Re-running finds
-- nothing. No schema change.

INSERT INTO document_versions (document_id, namespace, path, title, body)
SELECT d.id, d.namespace, d.path, d.title, d.body
FROM documents d JOIN jobs j ON j.namespace = d.namespace AND d.path = 'jobs/' || j.id || '.md'
WHERE d.type = 'task' AND d.status = 'active' AND j.status IN ('done', 'failed', 'superseded');

INSERT INTO audit_log (actor, action, namespace, path, params)
SELECT 'migration:0030', 'job-mirror-closed', d.namespace, d.path, json_object('job_id', j.id, 'job_status', j.status, 'was', 'active')
FROM documents d JOIN jobs j ON j.namespace = d.namespace AND d.path = 'jobs/' || j.id || '.md'
WHERE d.type = 'task' AND d.status = 'active' AND j.status IN ('done', 'failed', 'superseded');

UPDATE documents SET status = 'closed', updated_at = datetime('now')
WHERE type = 'task' AND status = 'active' AND EXISTS (
  SELECT 1 FROM jobs j WHERE j.namespace = documents.namespace AND documents.path = 'jobs/' || j.id || '.md'
    AND j.status IN ('done', 'failed', 'superseded'));
