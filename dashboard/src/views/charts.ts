import { preloadedLazy } from "capsomer/react/data";

// The Portal's charts (TrendCharts) load as one chunk, so Enarratio stays out of a page with no chart. A chart the
// server drew needs that chunk before hydration: React.lazy suspends on its first render, and an update that reaches a
// boundary still suspended (the shell's first effects, the feed's first read) makes React drop the server's chart and
// show the fallback, nothing, until it renders again. The page lost the chart's height for a moment (D5; /demos/queue
// 650 px, /demos/agents 500 px). So entry.client loads the chunk first on a page with a chart, and a chart made here
// then renders at once (capsomer/react/data's preloadedLazy).
const charts = preloadedLazy(() => import("./TrendCharts"));

/** Loads the charts' chunk once. */
export const loadCharts = charts.load;

/** A chart from TrendCharts, lazy until its chunk has loaded and immediate after. */
export const trendChart = charts.part;
