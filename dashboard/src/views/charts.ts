import { type ComponentType, type LazyExoticComponent, lazy } from "react";

// The Portal's charts (TrendCharts) load as one chunk, so Enarratio stays out of a page with no chart. A chart the
// server drew needs that chunk before hydration: React.lazy suspends on its first render, and an update that reaches a
// boundary still suspended (the shell's first effects, the feed's first read) makes React drop the server's chart and
// show the fallback, nothing, until it renders again. The page lost the chart's height for a moment (D5; /demos/queue
// 650 px, /demos/agents 500 px). So entry.client loads the chunk first on a page with a chart, and a chart made here
// then renders at once: its factory answers with a thenable that is already resolved, which React.lazy reads
// synchronously.

type Charts = typeof import("./TrendCharts");
// Each chart takes its own props.
type Chart = ComponentType<any>;
/** The names of TrendCharts' exports that are components. */
type ChartName = { [K in keyof Charts]: Charts[K] extends Chart ? K : never }[keyof Charts];

let loaded: Charts | undefined;
let loading: Promise<Charts> | undefined;

/** Loads the charts' chunk once. */
export function loadCharts(): Promise<Charts> {
  loading ??= import("./TrendCharts").then((m) => (loaded = m));
  return loading;
}

/** A chart from TrendCharts, lazy until its chunk has loaded and immediate after. */
export function trendChart<K extends ChartName>(name: K): LazyExoticComponent<Charts[K]> {
  type Module = { default: Charts[K] };
  const pick = (m: Charts): Module => ({ default: m[name] });
  return lazy(() => {
    const ready = loaded;
    if (!ready) return loadCharts().then(pick);
    const module = pick(ready);
    return { then: (resolve: (m: Module) => unknown) => resolve(module) } as Promise<Module>;
  });
}
