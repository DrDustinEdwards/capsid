const WORDS: Record<string, string> = {
  write: "Wrote a document",
  read: "Read a document",
  delete: "Deleted a document",
  "portal-ops-refresh": "Asked for a fresh read",
  "ops-site-added": "Added a site",
  "ops-site-edited": "Changed a site",
  "ops-site-removed": "Removed a site",
  "ops-package-added": "Added a package",
  "ops-package-edited": "Changed a package",
  "ops-package-removed": "Removed a package",
  "site-repair": "Ran a site repair",
};

export function actionWords(code: string | null): string | null {
  return code && Object.hasOwn(WORDS, code) ? WORDS[code]! : null;
}
