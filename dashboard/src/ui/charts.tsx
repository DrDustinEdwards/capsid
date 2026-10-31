// The Sites table's small charts, drawn by Enarratio: each site's uptime and errors per hour.
// Inline forms (the bare SVG, role="img" with its text alternative), since a chart in a table
// cell needs no frame.
import { sparkline, uptimeStrip, uptimeStripTable, type UptimeSlot } from "enarratio";
import type { HourBucket, SiteSnapshot } from "../types";
import { RING_SLOTS, ringOf, slotStart, uptime } from "../lib/derive";
import { pct, utc } from "../lib/format";

// ---- uptime ticks: 336 half-hour slots as 84 two-hour ticks ------------------------

const TICKS = 84;
const PER = RING_SLOTS / TICKS;

// Chart 8 (design-portal-evaluation.md section 3: "Is every site up, and since when?"), drawn
// with Enarratio's uptimeStrip: each two-hour window up, degraded (a failed probe among
// passes), down (every probe failed) or unknown (no watcher pass). The site drawer draws the
// same options as a whole figure in Capsomer's frame (app/Drawer.tsx).
export function uptimeOptions(site: SiteSnapshot) {
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
  return { slots, width: 420, height: 22, label: `Uptime over 7 days for ${site.name}: ${up == null ? "no probe data" : `${pct(up)} of probes up`}, ${downTicks} two-hour windows with a failed probe, ${gaps} with no watcher pass` };
}

/** The Sites table's strip, its windows also stated in a table only assistive technology reads. */
export function UptimeTicks({ site }: { site: SiteSnapshot }) {
  const opts = uptimeOptions(site);
  return (
    <>
      <span className="cap-uptime-strip" dangerouslySetInnerHTML={{ __html: uptimeStrip({ ...opts, inline: true }) }} />
      <span dangerouslySetInnerHTML={{ __html: uptimeStripTable(opts, { dataTable: "visually-hidden" }).markup }} />
    </>
  );
}

export function UptimeFoot({ site }: { site: SiteSnapshot }) {
  const ring = ringOf(site);
  return (
    <div className="upct">
      <span>7d</span>
      <span>
        {pct(uptime(ring))} · 24h {pct(uptime(ring.slice(-48)), 1)}
      </span>
    </div>
  );
}

// ---- errors per hour ---------------------------------------------------------------------

export function errorTotals(e: HourBucket[]) {
  const req = e.reduce((a, x) => a + x.requests, 0);
  const err = e.reduce((a, x) => a + x.errors, 0);
  return { req, err, rate: req ? err / req : null };
}

/** The Sites table's errors per hour, the cell's totals under it. */
export function ErrorSpark({ values, label }: { values: number[]; label: string }) {
  return <span className="spark" dangerouslySetInnerHTML={{ __html: sparkline({ values, label, alt: label, width: 86, height: 22, area: true, inline: true }) }} />;
}
