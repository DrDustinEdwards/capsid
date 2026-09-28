// The sites the watcher probes for the operations dashboard
// (capsid/research/design-ops-console.md, approved 2026-09-28). One entry per
// namespace that serves a site. The hosts are public addresses; nothing here is a
// credential. Changing the map is a reviewed PR.
//
// The registered namespaces live in D1, not in code, so the map is compared against
// them on every watcher pass rather than in a test: siteMapDrift names a registered
// namespace the map neither covers nor excludes, and a map entry whose namespace is not
// registered. Either becomes a watcher finding (src/watcher.ts, "site map").

export interface OpsSite {
  namespace: string;
  name: string;
  origin: string;
  // The site's own health route, or null where it has none; the probe then reads the
  // root, which proves liveness and nothing more.
  healthPath: string | null;
  platform: "cloudflare" | "vercel";
  // The Worker script that serves the site, named here only where the host proves it:
  // a *.dustin-edwards.workers.dev host is served by the script its first label names.
  // Every other Cloudflare site is resolved on each pass from the account's Workers
  // custom domains (src/ops-cloudflare.ts), and one that resolves to nothing is shown
  // as unresolved rather than guessed.
  script?: string;
  // Probed in-process through healthReport() instead of over HTTP: a Worker fetching
  // its own workers.dev hostname is not a reliable probe of itself.
  self?: true;
}

export const OPS_SITES: readonly OpsSite[] = [
  { namespace: "capsid", name: "Capsid", origin: "https://capsid.dustin-edwards.workers.dev", healthPath: "/health", platform: "cloudflare", script: "capsid", self: true },
  { namespace: "dustinedwards", name: "dustinedwards.info", origin: "https://dustinedwards.info", healthPath: "/api/health", platform: "cloudflare" },
  { namespace: "germomics", name: "Germomics", origin: "https://germomics.com", healthPath: "/health", platform: "cloudflare" },
  { namespace: "foxing", name: "Foxing", origin: "https://foxing.app", healthPath: null, platform: "cloudflare" },
  { namespace: "foxhound", name: "Foxhound", origin: "https://foxhoundapp.com", healthPath: null, platform: "cloudflare" },
  { namespace: "txasm", name: "TXASM", origin: "https://txasm.org", healthPath: null, platform: "cloudflare" },
  { namespace: "bsw", name: "BSW", origin: "https://bsw.dustin-edwards.workers.dev", healthPath: null, platform: "cloudflare", script: "bsw" },
  { namespace: "julieedwards", name: "julieedwards.info", origin: "https://julieedwards.info", healthPath: null, platform: "vercel" },
];

// Registered namespaces that serve no site, named so their absence from the map is a
// decision rather than an omission.
export const NO_SITE_NAMESPACES: readonly string[] = ["claude-skills"];

// unmapped: registered, but neither mapped nor listed as having no site. unknown:
// mapped or listed, but not registered.
export type { SiteMapDrift } from "./ops-types";
import type { SiteMapDrift } from "./ops-types";

export function siteMapDrift(registered: readonly string[]): SiteMapDrift {
  const covered = new Set([...OPS_SITES.map((s) => s.namespace), ...NO_SITE_NAMESPACES]);
  const known = new Set(registered);
  return {
    unmapped: registered.filter((ns) => !covered.has(ns)).sort(),
    unknown: [...covered].filter((ns) => !known.has(ns)).sort(),
  };
}
