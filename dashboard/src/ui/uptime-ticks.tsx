// Chart 8, each site's uptime, apart from ./charts so Enarratio stays out of the entry chunk:
// App.tsx imports FreshRing from ./charts, and the uptime strip is drawn only in lazy views.
import { uptimeStrip, uptimeStripTable, type UptimeSlot } from "enarratio";
import { EnarChart } from "./Enar";
import type { SiteSnapshot } from "../types";
import { RING_SLOTS, ringOf, slotStart, uptime } from "../lib/derive";
import { pct, utc } from "../lib/format";

// ---- uptime ticks: 336 half-hour slots as 84 two-hour ticks ------------------------

const TICKS = 84;
const PER = RING_SLOTS / TICKS;

// Chart 8 (design-portal-evaluation.md section 3: "Is every site up, and since when?"), drawn
// with Enarratio's uptimeStrip: each two-hour window up, degraded (a failed probe among
// passes), down (every probe failed) or unknown (no watcher pass). Its table companion
// states every window in words.
export function UptimeTicks({ site }: { site: SiteSnapshot }) {
  const ring = ringOf(site);
  const slots: UptimeSlot[] = [];
  let downTicks = 0;
  let gaps = 0;
  for (let b = 0; b < TICKS; b++) {
    const slice = [...ring.slice(b * PER, (b + 1) * PER)];
    const seen = slice.filter((c) => c !== "-").length;
    const down = slice.filter((c) => c === "0").length;
    const status = !seen ? "unknown" : down === seen ? "down" : down ? "degraded" : "up";
    if (down) downTicks++;
    if (!seen) gaps++;
    const label = `${utc(slotStart(site, b * PER)).slice(5)} +2h, ${seen ? `${seen - down} of ${seen} probes up` : "no watcher pass"}`;
    slots.push({ status, label });
  }
  const up = uptime(ring);
  const opts = { slots, width: 420, height: 22, label: `Uptime over 7 days for ${site.name}: ${up == null ? "no probe data" : `${pct(up)} of probes up`}, ${downTicks} two-hour windows with a failed probe, ${gaps} with no watcher pass` };
  return <EnarChart className="ticks" draw={() => ({ svg: uptimeStrip(opts), table: uptimeStripTable(opts, { dataTable: "visually-hidden" }).markup })} />;
}
