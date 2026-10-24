import { LIVE, fetchTrends, useAnswer, type Load } from "./api";
import type { PortalTrends } from "../types";

// GET /portal/api/trends, shared and kept for ten minutes: Health draws several charts from
// it, and each section asking would read it again. The series move by the day or the week,
// so reading them on every one-minute feed would cost the Worker ten D1 reads and an R2
// listing a minute for nothing. A feed that arrives after the ten minutes reads them again.
export function useTrends(): Load<PortalTrends> {
  return useAnswer([LIVE, "trends"], fetchTrends, { staleTime: 10 * 60_000 });
}
