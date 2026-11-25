import "capsomer/row-list.css";
import "capsomer/time.css";
import "capsomer/not-found-report.css";
import { NotFoundReport } from "capsomer/react/not-found-report";
import { fetchNotFound } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import type { PortalNotFound } from "../types";

export function NotFound() {
  const load = useAnswer<PortalNotFound>(["not-found"], fetchNotFound);
  const d = load.data;
  const days = d?.days ?? 30;
  return (
    <NotFoundReport
      title={`Missing pages, ${days} days`}
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
