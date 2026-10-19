// The namespaces Capsid looks after by name. The five app repos are the ones the watcher
// and the trends read CI for and whose deploys are compared (APP_ROSTER); carrel and
// capsomer joined later for auto-merge and the maintenance pass only (Dustin,
// 2026-10-07).
export const APP_ROSTER = ["capsid", "dustinedwards", "foxhound", "foxing", "germomics"] as const;

const MERGE_ONLY_ROSTER = ["carrel", "capsomer"] as const;

export const ROSTER = [...APP_ROSTER, ...MERGE_ONLY_ROSTER] as const;

export function onRoster(namespace: string): boolean {
  return (ROSTER as readonly string[]).includes(namespace);
}
