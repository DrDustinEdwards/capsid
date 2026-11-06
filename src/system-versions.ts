import { z } from "zod";
import { bounded } from "./limits";
import type { OpsMaintenanceItem } from "./ops-types/views";
import type { SharedCodeView } from "./ops-types/feed";
import type { RepoPrivacy, SystemModel } from "./system-model";
import { DAY_MS } from "./time";

// THE VERSIONS MODEL, per system (Dustin, 2026-11-03). src/shared-code.ts reads, from every
// repo the system model names, which version of each network package it installs; this
// module turns that per-package view into the published per-system document and the
// nightly drift lines. Versions may be public (the coordinator's plan Dustin said go to):
// the document is served at /public/versions/v1.json beside the model, and read through
// capsid_read_status action versions.
//
// Like toPublic, the document is built by picking named fields into new objects. A
// private system's pins are published without the paths they were read from, the same
// rule as its code map: its file layout is not public.

const Id = bounded(64);
const Version = bounded(64);

const Pin = z.strictObject({
  package: bounded(100),
  pinned: Version.nullable(),
  // Releases newer than the pin, null when the pin is not a release.
  behind: z.number().int().nullable(),
  // The manifest, "renovate" or ".github/workflows (N uses)"; public systems only.
  where: bounded(200).optional(),
});

export const PublicVersionsSchema = z.strictObject({
  version: z.literal(1),
  as_of: bounded(10).regex(/^\d{4}-\d{2}-\d{2}$/),
  packages: z.array(z.strictObject({ name: bounded(100), registry: z.enum(["git", "npm"]), latest: Version.nullable() })),
  systems: z.array(z.strictObject({ system: Id, pins: z.array(Pin) })),
  // Repos that could not be read, by system, so "nobody is behind" is never "nothing was read".
  unread: z.array(Id),
});

export type PublicVersions = z.infer<typeof PublicVersionsSchema>;

/** The per-system document. Pure. */
export function toPublicVersions(view: SharedCodeView, model: SystemModel, privacy: RepoPrivacy, asOf: string): PublicVersions {
  const open = new Set(model.systems.filter((s) => s.repos.every((r) => privacy.get(r.toLowerCase()) === false)).map((s) => s.id));
  const bySystem = new Map<string, PublicVersions["systems"][number]["pins"]>();
  for (const pkg of view.packages) {
    for (const u of pkg.users) {
      if (!u.system) continue;
      const pin: PublicVersions["systems"][number]["pins"][number] = { package: pkg.name, pinned: u.pinned, behind: u.behind };
      if (open.has(u.system)) pin.where = u.where;
      bySystem.set(u.system, [...(bySystem.get(u.system) ?? []), pin]);
    }
  }
  const failed = new Set(view.apps_failed.flatMap((a) => (a.system ? [a.system] : [])));
  return {
    version: 1,
    as_of: asOf,
    packages: view.packages.map((p) => ({ name: p.name, registry: p.registry, latest: p.latest })),
    // In the model's order, every system that pins anything.
    systems: model.systems.flatMap((s) => (bySystem.has(s.id) ? [{ system: s.id, pins: bySystem.get(s.id)! }] : [])),
    unread: model.systems.filter((s) => failed.has(s.id)).map((s) => s.id),
  };
}

// How long a pin may sit behind the newest release before it is a drift line. Renovate
// opens the bump within a day of a release, so three days behind means its pull request
// is stuck or was never opened.
const BEHIND_GRACE_MS = 3 * DAY_MS;

/** When each pin behind was first seen behind, keyed by repo, package, where and pin. */
export type BehindSince = Record<string, string>;

/** The drift lines, and the carried first-seen map for tomorrow. Pure.
 *  - A repo that installs two versions of one package, in two of its manifests.
 *  - A pin behind the newest release for longer than BEHIND_GRACE_MS.
 *  - A repo, or a package's releases, that could not be read. */
export function versionDrift(view: SharedCodeView, prior: BehindSince, now: Date): { items: OpsMaintenanceItem[]; since: BehindSince } {
  const items: OpsMaintenanceItem[] = [];
  const since: BehindSince = {};
  for (const a of view.apps_failed) {
    items.push({ rule: "model-not-checked", namespace: a.namespace, job: null, line: `${a.namespace}'s versions could not be read (${a.error}), so its pins were not checked today.` });
  }
  for (const pkg of view.packages) {
    if (pkg.tags_error) items.push({ rule: "model-not-checked", namespace: "capsid", job: null, line: `${pkg.name}'s releases could not be read (${pkg.tags_error}), so no repo was checked for being behind on it today.` });
    const byRepo = new Map<string, typeof pkg.users>();
    for (const u of pkg.users) byRepo.set(u.repo ?? u.namespace, [...(byRepo.get(u.repo ?? u.namespace) ?? []), u]);
    for (const [repo, users] of byRepo) {
      const pins = [...new Set(users.flatMap((u) => (u.pinned ? [u.pinned] : [])))];
      if (pins.length > 1) {
        const where = users.filter((u) => u.pinned).map((u) => `${u.pinned} in ${u.where}`).join(", ");
        items.push({ rule: "model-drift", namespace: users[0].namespace, job: null, line: `${repo} installs ${pins.length} versions of ${pkg.name} (${where}): bring them to one.` });
      }
    }
    for (const u of pkg.users) {
      if (!u.behind) continue;
      const key = `${u.repo ?? u.namespace}|${pkg.name}|${u.where}|${u.pinned}`;
      const first = prior[key] ?? now.toISOString();
      since[key] = first;
      const days = Math.floor((now.getTime() - Date.parse(first)) / DAY_MS);
      if (now.getTime() - Date.parse(first) >= BEHIND_GRACE_MS) {
        items.push({ rule: "model-drift", namespace: u.namespace, job: null, line: `${u.repo ?? u.namespace} pins ${pkg.name} ${u.pinned} in ${u.where}, ${u.behind} ${u.behind === 1 ? "release" : "releases"} behind ${pkg.latest} for ${days} days: merge its Renovate bump, or find why there is none.` });
      }
    }
  }
  return { items, since };
}
