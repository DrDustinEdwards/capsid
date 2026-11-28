// The namespaces Capsid looks after by name. The watcher and the trends read CI for the app repos
// and compare their deploys; carrel and capsomer are for the maintenance pass only.
export const APP_ROSTER = ["capsid", "dustinedwards", "foxhound", "foxing", "germomics"] as const;

const MAINTENANCE_ONLY_ROSTER = ["carrel", "capsomer"] as const;

export const ROSTER = [...APP_ROSTER, ...MAINTENANCE_ONLY_ROSTER] as const;

export function onRoster(namespace: string): boolean {
  return (ROSTER as readonly string[]).includes(namespace);
}
