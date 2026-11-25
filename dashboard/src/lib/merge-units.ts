import type { OpsFeed, PortalMergeUnits } from "../types";

export type UnitRow = {
  unit: string;
  state: "auto" | "suspended" | "promote" | "demote";
  why: string;
};

export function unitRows(promoted: readonly string[], units: PortalMergeUnits): UnitRow[] {
  const rows = new Map<string, UnitRow>();
  for (const u of promoted) rows.set(u, { unit: u, state: "auto", why: "" });
  for (const p of units.proposals) {
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

export const pausedProjects = (feed: OpsFeed) =>
  feed.live.merge_safety?.namespaces.filter((n) => n.paused) ?? [];
