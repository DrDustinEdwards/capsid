import { LIVE, fetchTrends } from "./api";
import { useAnswer, type Load } from "capsomer/react/data";
import type { PortalTrends } from "../types";

// Kept ten minutes and shared: reading on every one-minute feed would cost the Worker ten D1 reads and an R2 listing a minute for nothing.
export function useTrends(): Load<PortalTrends> {
  return useAnswer([LIVE, "trends"], fetchTrends, { staleTime: 10 * 60_000 });
}
