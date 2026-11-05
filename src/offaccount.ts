// The sites whose d1-dump runs the private capsid-backups repo copies off the Cloudflare
// account (capsid/rulings/backups-offaccount-2026-10-10.md). /backup/credential mints a
// read credential only for a bucket named here, so the bucket comes from this pinned
// table and never from the request or from an editable row such as ops_sites.
//
// Each site dumps into its own bucket under d1-dump's prefix, BACKUP_DUMP_PREFIX in
// src/signed-requests.ts. txasm dumps into its books bucket rather than a backups one.
// dustinedwards joined 2026-10-15, after its nightly dump (dustinedwards-info #439, on the
// watchdog Worker) completed and passed its first drill (job_e40ec706c10a).
//
// database is the D1 database the site's dump covers. The watcher compares these with every
// D1 database a Worker binds (the nightly resources model), so a database with no Amazon
// copy is a finding (the ruling's "flag any site with no Amazon copy").
export const OFFACCOUNT_SOURCES = {
  capsid: { bucket: "capsid-media", database: "capsid" },
  germomics: { bucket: "germomics-backups", database: "germomics" },
  txasm: { bucket: "txasm-books", database: "txasm" },
  foxing: { bucket: "foxing-backups", database: "foxing" },
  foxhound: { bucket: "foxhound-backups", database: "foxhound" },
  dustinedwards: { bucket: "dustinedwards-backups", database: "dustinedwards" },
  julieedwards: { bucket: "julieedwards-backups", database: "julieedwards" },
  carrel: { bucket: "carrel-backups", database: "carrel" },
  bsw: { bucket: "bsw-backups", database: "bsw" },
} as const satisfies Record<string, { bucket: string; database: string }>;

export type OffaccountSite = keyof typeof OFFACCOUNT_SOURCES;

// keeps working.
// send none, keep working through the cutover.
export const OFFACCOUNT_DEFAULT_SITE: OffaccountSite = "capsid";

export const OFFACCOUNT_SITES = Object.keys(OFFACCOUNT_SOURCES) as OffaccountSite[];

// Own keys only, so "constructor" or "__proto__" is an unknown site like any other.
export function isOffaccountSite(site: string): site is OffaccountSite {
  return Object.hasOwn(OFFACCOUNT_SOURCES, site);
}

// The Amazon copy's report (job_51bf55f7b42c step 4). capsid-backups' watch.yml lists the
// Object Lock bucket every 6 hours with a list-only role and POSTs, signed with the backup
// key, the newest complete run id under daily/<site>/ for every site. The Worker holds no
// AWS key: the bucket's state reaches it only this way. The watcher reads the stored
// report (src/watcher-detect.ts offaccountFindings); APP_KV is enough, since a lost report
// is rewritten by the next run and its absence is itself a finding.
export const OFFACCOUNT_REPORT_PATH = "/backup/offaccount-report";
export const OFFACCOUNT_REPORT_KEY = "offaccount:report";

const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

// One site's line of the report: the newest complete daily copy and its size in bytes,
// the sizes of the recent complete daily copies (newest first, at most 14, the newest
// included), and the newest complete weekly and monthly copies.
export interface OffaccountSiteReport {
  newest: string | null;
  bytes: number | null;
  recent_bytes: number[];
  weekly: string | null;
  monthly: string | null;
}

const runOrNull = (v: unknown): v is string | null => v === null || (typeof v === "string" && RUN_ID.test(v));
const size = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function siteLine(v: unknown): OffaccountSiteReport | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const { newest, bytes, recent_bytes, weekly, monthly } = v as Record<string, unknown>;
  if (!runOrNull(newest) || !runOrNull(weekly) || !runOrNull(monthly)) return null;
  if (!(bytes === null || size(bytes)) || (newest === null) !== (bytes === null)) return null;
  if (!Array.isArray(recent_bytes) || recent_bytes.length > 14 || !recent_bytes.every(size)) return null;
  return { newest, bytes, recent_bytes, weekly, monthly };
}

// A jti and a line for every site. Every site is required, so a report that forgot one
// cannot read as that site being fine; a site this Worker does not know is refused, so
// the two lists cannot drift apart silently.
export function parseOffaccountReport(
  body: string
): { ok: true; jti: string; sites: Record<OffaccountSite, OffaccountSiteReport> } | { ok: false; refusal: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, refusal: "the report body is not JSON" };
  }
  const { jti, sites } = (parsed ?? {}) as { jti?: unknown; sites?: unknown };
  if (typeof jti !== "string" || jti.length < 8 || jti.length > 128) return { ok: false, refusal: "the report must carry a jti of 8 to 128 characters" };
  if (typeof sites !== "object" || sites === null || Array.isArray(sites)) return { ok: false, refusal: "the report must carry a sites object" };
  const named = Object.keys(sites);
  const unknown = named.filter((s) => !isOffaccountSite(s));
  if (unknown.length) return { ok: false, refusal: `the report names unknown sites: ${unknown.join(", ")}` };
  const missing = OFFACCOUNT_SITES.filter((s) => !named.includes(s));
  if (missing.length) return { ok: false, refusal: `the report leaves out: ${missing.join(", ")}` };
  const out = {} as Record<OffaccountSite, OffaccountSiteReport>;
  for (const site of OFFACCOUNT_SITES) {
    const line = siteLine((sites as Record<string, unknown>)[site]);
    if (!line) return { ok: false, refusal: `${site}: expected {newest, bytes, recent_bytes, weekly, monthly}, each run a run id or null` };
    out[site] = line;
  }
  return { ok: true, jti, sites: out };
}
