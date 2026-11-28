import { preloadedLazy } from "capsomer/react/data";

// A server-drawn chart needs the charts' chunks before hydration: React.lazy suspending on first render makes React drop it for the fallback.
// entry.client loads both chunks first, so a chart made here renders at once (capsomer/react/data's preloadedLazy).
const trends = preloadedLazy(() => import("./TrendCharts"));
const board = preloadedLazy(() => import("./BoardCharts"));

export const loadCharts = () => Promise.all([trends.load(), board.load()]);

export const trendChart = trends.part;

export const boardChart = board.part;
