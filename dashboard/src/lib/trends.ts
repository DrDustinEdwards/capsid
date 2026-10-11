import { useEffect, useState } from "react";
import { useApp } from "../app/ctx";
import { fetchTrends } from "./api";
import type { PortalTrends } from "../types";

// GET /portal/api/trends, shared and kept for ten minutes: Health draws two charts from it,
// and both sections asking would read it twice. The series move by the day or the week, so
// reading them on every one-minute feed would cost the Worker ten D1 reads and an R2 listing
// a minute for nothing. A feed that arrives after the ten minutes reads them again.

export type TrendsLoad = { data: PortalTrends | null; error: string | null };

const KEEP_MS = 10 * 60_000;
let kept: { at: number; read: Promise<TrendsLoad> } | null = null;

function read(signOut: () => void): Promise<TrendsLoad> {
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.read;
  const reading = fetchTrends().then((r): TrendsLoad => {
    if (r.kind === "ok") return { data: r.value, error: null };
    if (r.kind === "signed-out") signOut();
    // A failed read is not kept, so the next feed tries again.
    if (kept?.read === reading) kept = null;
    return { data: null, error: r.kind === "refused" ? `HTTP ${r.status}: ${r.message}` : r.kind === "signed-out" ? "signed out" : r.message };
  });
  kept = { at: Date.now(), read: reading };
  return reading;
}

export function useTrends(): TrendsLoad & { loading: boolean } {
  const { feed, signOut } = useApp();
  const generated = feed.live.generated;
  const [load, setLoad] = useState<TrendsLoad & { loading: boolean }>({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true;
    void read(signOut).then((r) => {
      if (alive) setLoad((l) => ({ data: r.data ?? l.data, error: r.error, loading: false }));
    });
    return () => {
      alive = false;
    };
  }, [generated, signOut]);
  return load;
}
