import { LIVE, fetchBoard, fetchFigures, fetchPrs, fetchTrends } from "./api";
import { useAnswer, type Load } from "capsomer/react/data";
import type { FigureSet, PortalBoard, PortalFigures, PortalPrs, PortalTrends } from "../types";

const TEN_MINUTES = 10 * 60_000;

// Kept ten minutes and shared: reading on every one-minute feed would cost the Worker ten D1 reads and an R2 listing a minute for nothing.
export function useTrends(): Load<PortalTrends> {
  return useAnswer([LIVE, "trends"], fetchTrends, { staleTime: TEN_MINUTES });
}

export function useBoard() {
  return useAnswer<PortalBoard>([LIVE, "board"], fetchBoard);
}

export function usePrs() {
  return useAnswer<PortalPrs>(["prs"], fetchPrs, { staleTime: TEN_MINUTES });
}

export const figuresKey = (set: FigureSet) => ["figures", set] as const;

export function useFigures(set: FigureSet) {
  return useAnswer<PortalFigures>(figuresKey(set), () => fetchFigures(set), {
    staleTime: TEN_MINUTES,
  });
}
