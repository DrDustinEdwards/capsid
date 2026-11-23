import type { OpsFeed, PortalMergeUnits } from "../types";

// The merge units (src/merge-units.ts) as rows, and the paused projects.
export type UnitRow = {
  unit: string;
  state: "auto" | "suspended" | "promote" | "demote";
  why: string;
};

export function unitRows(promoted: readonly string[], units: PortalMergeUnits): UnitRow[] {
  const rows = new Map<string, UnitRow>();
  for (const u of promoted) rows.set(u, { unit: u, state: "auto", why: "" });
  for (const p of units.proposals) {
    // A demote proposal is for a unit in the list; a promote one for a unit not yet in it.
    if (p.kind === "demote" && !rows.has(p.unit)) continue;
    rows.set(p.unit, { unit: p.unit, state: p.kind, why: p.title });
  }
  for (const s of units.suspended) {
    const row = rows.get(s.unit);
    rows.set(s.unit, {
      unit: s.unit,
      state: "suspended",
      why: row?.state === "demote" ? row.why : s.reason,
    });
  }
  return [...rows.values()].sort((a, b) => a.unit.localeCompare(b.unit));
}

/** The projects whose auto-merge the safety meter paused. */
export const pausedProjects = (feed: OpsFeed) =>
  feed.live.merge_safety?.namespaces.filter((n) => n.paused) ?? [];
