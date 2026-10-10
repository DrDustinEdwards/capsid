-- A SITE'S OPERATOR API (job_09e5f6cbf782; src/site-operator.ts). Capsid reads a site's
-- convergence (its operator API's sync_status beside its health checks), runs an
-- allowlisted repair from the Portal or the controls tool, and lets the watcher run the
-- repair a failing health check maps to. A site opts in by this column, not by code.
--
-- operator is NULL (the site has no operator API Capsid may call) or a JSON object:
--   path     the operator route on the site's origin, e.g. "/api/operator"
--   auth_var the name of the Capsid Worker secret holding the site's operator token; it
--            must end in _OPERATOR_TOKEN, so the column cannot point a token Capsid holds
--            for anything else at a site
--   repairs  health check name -> repair tool, in repair order
--   weekly   tools the watcher runs once a week (refresh_citations)
--   secrets  the names of the site Worker's secrets to report set or not (never values)
-- Every tool named must pass the Worker's ceiling (sync_* other than sync_status, or
-- refresh_citations; backup_media never), checked on every edit and again before every
-- call (src/site-operator.ts).
--
-- Additive: one nullable column, and the dustinedwards row opted in with the mapping of
-- dustinedwards-info's app/lib/health/repair.mjs at 873ab70, less media-backup-drift,
-- whose backup_media Capsid may not call, and the secret names of its app/lib/secrets.mjs at
-- 9f358d4. Until the secret is set, the Portal says so and nothing is called. Applying the
-- UPDATE twice changes nothing.

ALTER TABLE ops_sites ADD COLUMN operator TEXT;

UPDATE ops_sites SET operator = '{"path":"/api/operator","auth_var":"DUSTINEDWARDS_OPERATOR_TOKEN","repairs":{"content-drift":"sync_posts","procedures-drift":"sync_procedures","dictionary-drift":"sync_dictionary","roster-drift":"sync_roster","phage-drift":"sync_phages","registry-drift":"sync_registry","pages-drift":"sync_pages","publications-drift":"sync_publications","llms-drift":"sync_llms","cv-drift":"sync_cv","cv-pdf-drift":"sync_cv_pdf","ask-index-drift":"sync_ask","media-index-drift":"sync_media"},"weekly":["refresh_citations"],"secrets":["GITHUB_TOKEN","OPERATOR_TOKEN","CARREL_SITE_KEY","SMOKE_TOKEN","OPENALEX_API_KEY"]}'
  WHERE namespace = 'dustinedwards' AND origin IS NOT NULL AND operator IS NULL;
