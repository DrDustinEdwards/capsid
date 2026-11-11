import { NotFoundReport } from "capsomer/react/not-found-report";
import { fetchNotFound, useAnswer } from "../lib/api";
import type { PortalNotFound } from "../types";

// Capsid's own missing pages over 30 days (area 8, N4), from page_404_daily through GET
// /portal/api/not-found: each path with its hits and the hosts that linked to it, so a broken
// link names where it lives. Scanners' probes are counted, not listed. Each other site keeps
// its own table in its own database.
export function NotFound() {
  const load = useAnswer<PortalNotFound>(["not-found"], fetchNotFound);
  const d = load.data;
  const days = d?.days ?? 30;
  return (
    <NotFoundReport
      title={`Missing pages, ${days} days`}
      src="Capsid's page_404_daily"
      probes={d?.probes}
      rows={d?.pages ?? []}
      days={days}
      loading={load.loading}
      reason={
        load.error || !d || d.pages === null
          ? `The 404 counts could not be read: ${load.error ?? d?.error ?? "no answer"}.`
          : undefined
      }
    />
  );
}
