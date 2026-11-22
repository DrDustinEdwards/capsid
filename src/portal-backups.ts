import { jsonResponse } from "@dustinedwards/site-runtime/http";
import { behindGate } from "./portal-auth";
import { readSiteBackups } from "./site-backup";

// The Portal's site backups: GET /portal/api/backups, Health's Backups tab. Every site that
// sets backup: true, its backup_status read live through its operator API, beside its
// Amazon copy (src/site-backup.ts readSiteBackups, the reader behind capsid_admin_read_ops
// action backups). Back up now is the site_backup control, never this route. A route, not
// a tool, so no grant is checked here (one enforcement point, test/route-gates.test.ts): it
// answers to portalGate, and src/scope.ts lists it among the routes gated some other way.

export const PORTAL_BACKUPS_PATH = "/portal/api/backups";

export const handlePortalBackups = behindGate(async (_request, env) => {
  return jsonResponse(await readSiteBackups(env));
});
