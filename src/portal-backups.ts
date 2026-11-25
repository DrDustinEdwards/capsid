import { jsonResponse } from "@dustinedwards/site-runtime/http";
import { behindGate } from "./portal-auth";
import { readSiteBackups } from "./site-backup";

// The Portal's site backups: GET /portal/api/backups, Health's Backups tab. Every site that sets
// backup: true, its backup_status read live through its operator API, beside its Amazon copy
// (src/site-backup.ts readSiteBackups, the reader behind capsid_admin_read_ops action backups).

export const PORTAL_BACKUPS_PATH = "/portal/api/backups";

export const handlePortalBackups = behindGate(async (_request, env) => {
  return jsonResponse(await readSiteBackups(env));
});
