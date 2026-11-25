import type { Kind } from "./derive";
import type { OpsAgent, OpsFeed } from "../types";
import { DAY, HOUR } from "./format";
import { parse } from "capsomer/behavior/time";

export function rosterAgents(agents: readonly OpsAgent[]): OpsAgent[] {
  return agents.filter((a) => !a.revoked_at && !a.archived_at);
}

export function archiveAgents(agents: readonly OpsAgent[]): OpsAgent[] {
  const waiting = agents
    .filter((a) => a.revoked_at && !a.archived_at)
    .sort((x, y) => parse(x.revoked_at as string) - parse(y.revoked_at as string));
  const archived = agents
    .filter((a) => a.archived_at)
    .sort((x, y) => parse(y.archived_at as string) - parse(x.archived_at as string));
  return [...waiting, ...archived];
}

export function agentState(a: OpsAgent, now: number): { kind: Kind; label: string } {
  if (a.archived_at) return { kind: "nodata", label: "Archived" };
  if (a.revoked_at) return { kind: "crit", label: "Revoked" };
  if (a.pending) return { kind: "warn", label: "Waiting for activation" };
  if (!a.last_seen) return { kind: "nodata", label: "Never seen" };
  const d = now - parse(a.last_seen);
  if (d < HOUR) return { kind: "ok", label: "Active" };
  if (d < 2 * DAY) return { kind: "queued", label: "Idle" };
  return { kind: "nodata", label: "Silent" };
}

export function nsList(a: OpsAgent): string {
  return a.namespaces === "*" ? "*" : a.namespaces.join(", ");
}

export function driverOf(feed: OpsFeed, ns: string): OpsAgent | null {
  return feed.live.agents.find((a) => a.name === `${ns}-driver`) ?? null;
}
