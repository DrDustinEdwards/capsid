-- CANON PROPOSALS (job_9e602b31888f item 2; Dustin's D3, 2026-10-03; src/canon.ts).
--
-- A driver could rewrite a canon document other agents trust (capsid/conventions*.md,
-- capsid/repo-structure.md, any namespace's core.md, decisions.md and its volumes) with
-- one write. Now a write to a canon path by a caller that is not the seat or the admin is
-- not applied. It is stored here as a proposal and the write answers pending_review. The
-- admin approves it (applied as an ordinary write, refused when the document moved past
-- base_sha) or rejects it, from the Portal or the controls tool, preview then perform.
--
-- directive_lines is a JSON array of the added lines that read as instructions addressed
-- to agents. They are highlighted for the reviewer and never auto-rejected.
--
-- Additive: one new table and its index, no change to an existing table, no backfill.

CREATE TABLE IF NOT EXISTS canon_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  path TEXT NOT NULL,
  -- The document as the write would have left it: title and assembled body, and the
  -- type, tags and status the write passed (NULL keeps the stored value, as write does).
  title TEXT,
  body TEXT NOT NULL,
  type TEXT,
  tags TEXT,
  status TEXT,
  mode TEXT NOT NULL,
  -- sha256 of the body the proposal was written against; NULL when the document did not
  -- exist, so approval then requires it still not to.
  base_sha TEXT,
  proposer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  directive_lines TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected')),
  decided_by TEXT,
  decided_at TEXT,
  decided_reason TEXT
);

CREATE INDEX IF NOT EXISTS canon_proposals_state ON canon_proposals (state, id);
