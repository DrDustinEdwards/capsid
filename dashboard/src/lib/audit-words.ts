// What an audit row's action code means, in words (the UX audit's M5: Activity showed raw
// codes such as "jobs.block" and "portal-overnight"). The code stays beside the words and
// in the row's panel, so nothing is lost; an action not listed here shows its code.
const WORDS: Record<string, string> = {
  write: "Wrote a document",
  read: "Read a document",
  delete: "Deleted a document",
  "job-posted": "Posted a job",
  "jobs.post": "Posted a job",
  "jobs.claim": "Claimed a job",
  "jobs.block": "Blocked a job",
  "jobs.resume": "Resumed a job",
  "jobs.complete": "Finished a job",
  "jobs.fail": "Marked a job failed",
  "jobs.release": "Released a job",
  "jobs.park": "Parked a job",
  "jobs.unpark": "Unparked a job",
  "jobs.supersede": "Superseded a job",
  "portal-overnight": "Set the overnight run",
  "portal-ops-refresh": "Asked for a fresh read",
  "ops-site-added": "Added a site",
  "ops-site-edited": "Changed a site",
  "ops-site-removed": "Removed a site",
  "ops-package-added": "Added a package",
  "ops-package-edited": "Changed a package",
  "ops-package-removed": "Removed a package",
  "canon-proposed": "Proposed a rule change",
  "canon-rejected": "Rejected a rule change",
  "lint.finalize": "Finished a lint pass",
  "site-repair": "Ran a site repair",
};

export function actionWords(code: string | null): string | null {
  return code && Object.hasOwn(WORDS, code) ? WORDS[code]! : null;
}
