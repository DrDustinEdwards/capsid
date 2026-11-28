import { LIVE, fetchBoard, fetchFigures, fetchPrs, fetchTrends } from "./api";
import { useAnswer, type Load } from "capsomer/react/data";
import type { FigureSet, PortalBoard, PortalFigures, PortalPrs, PortalTrends } from "../types";

const TEN_MINUTES = 10 * 60_000;

// Kept ten minutes and shared: reading on every one-minute feed would cost the Worker ten D1 reads and an R2 listing a minute for nothing.
export function useTrends(): Load<PortalTrends> {
  return useAnswer([LIVE, "trends"], fetchTrends, { staleTime: TEN_MINUTES });
}

// The Board's D1 parts are cheap: read again with each feed (the LIVE key).
export function useBoard() {
  return useAnswer<PortalBoard>([LIVE, "board"], fetchBoard);
}

// The pull requests are kept 15 minutes by the Worker; read in the browser after the page paints, never on the server.
export function usePrs() {
  return useAnswer<PortalPrs>(["prs"], fetchPrs, { staleTime: TEN_MINUTES });
}

export const figuresKey = (set: FigureSet) => ["figures", set] as const;

// Server-drawn charts: never on the feed's poll, so a redraw never takes a reader's hover, focus or sort.
export function useFigures(set: FigureSet) {
  return useAnswer<PortalFigures>(figuresKey(set), () => fetchFigures(set), {
    staleTime: TEN_MINUTES,
  });
}
