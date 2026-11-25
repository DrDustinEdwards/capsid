import { preloadedLazy } from "capsomer/react/data";

// A server-drawn chart needs the charts' chunk before hydration: React.lazy suspending on first render makes React drop it for the fallback.
// entry.client loads the chunk first, so a chart made here renders at once (capsomer/react/data's preloadedLazy).
const charts = preloadedLazy(() => import("./TrendCharts"));

export const loadCharts = charts.load;

export const trendChart = charts.part;
