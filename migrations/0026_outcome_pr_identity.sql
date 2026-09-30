-- A PULL REQUEST'S IDENTITY, PINNED ON ITS FIRST READ (job_6092edef11e1).
--
-- THE DEFECT. job_outcome_prs names a pull request by URL, and a URL names a number.
-- A repository that is deleted and recreated, or transferred, hands its numbers out
-- again from #1. The re-verification sweep reads each row by URL, so once the new
-- repository reached the old number it would read an UNRELATED pull request and write
-- that one's merge state onto an outcome it never belonged to. Observed 2026-09-29:
-- claude-skills was recreated with rewritten history, and two rows (pull/8 and pull/17)
-- were still unread.
--
-- THE FIX. The first read stores GitHub's node id for the pull request and when it was
-- opened. Every later read compares the node id, and a pull request whose id differs is
-- not counted: the row is marked unverifiable with a reason and never read by URL again.
-- A row recorded before this column existed is pinned on its next read, unless its
-- repository was created after the outcome named it, or the pull request answering at
-- that number was opened after it; either way it cannot be the one the outcome named.
--
-- Additive only: NULL in every existing row means "not pinned yet", which is the
-- backfill path, not a claim about the pull request.

-- GitHub's global id for the pull request the row named (PR_kw...). NULL until read.
ALTER TABLE job_outcome_prs ADD COLUMN pr_node_id TEXT;

-- When that pull request was opened, as GitHub reports it. NULL until read.
ALTER TABLE job_outcome_prs ADD COLUMN pr_created_at TEXT;

-- NULL while the row can be verified. Otherwise why it cannot: 'identity-changed' (the
-- number now belongs to a different pull request) or 'repo-recreated' (the repository
-- was created after the outcome named the pull request). A marked row is left out of
-- the sweep and out of every count, and is never read by URL again.
ALTER TABLE job_outcome_prs ADD COLUMN unverifiable TEXT;

-- The reason in words, with the ids and times it was decided on, and when.
ALTER TABLE job_outcome_prs ADD COLUMN unverifiable_note TEXT;
ALTER TABLE job_outcome_prs ADD COLUMN unverifiable_at TEXT;
