// The sites whose d1-dump runs the private capsid-backups repo copies off the Cloudflare
// account (capsid/rulings/backups-offaccount-2026-10-10.md). /backup/credential mints a
// read credential only for a bucket named here, so the bucket comes from this pinned
// table and never from the request or from an editable row such as ops_sites.
//
// Each site dumps into its own bucket under d1-dump's prefix, BACKUP_DUMP_PREFIX in
// src/improve-scorer.ts. txasm dumps into its books bucket rather than a backups one.
// dustinedwards is not listed: it runs no d1-dump today, so it has no bucket to pin.
// It joins when its nightly dump exists, with a test naming its bucket.
export const OFFACCOUNT_SOURCES = {
  capsid: { bucket: "capsid-media" },
  germomics: { bucket: "germomics-backups" },
  txasm: { bucket: "txasm-books" },
  foxing: { bucket: "foxing-backups" },
  foxhound: { bucket: "foxhound-backups" },
} as const satisfies Record<string, { bucket: string }>;

export type OffaccountSite = keyof typeof OFFACCOUNT_SOURCES;

// A request with no site is capsid's, so mirror.yml and restore-rehearsal.yml, which
// send none, keep working through the cutover.
export const OFFACCOUNT_DEFAULT_SITE: OffaccountSite = "capsid";

export const OFFACCOUNT_SITES = Object.keys(OFFACCOUNT_SOURCES) as OffaccountSite[];

// Own keys only, so "constructor" or "__proto__" is an unknown site like any other.
export function isOffaccountSite(site: string): site is OffaccountSite {
  return Object.hasOwn(OFFACCOUNT_SOURCES, site);
}
