// Inline SVG with a text alternative and no frame: a chart in a table cell needs none.
import { sparkline, uptimeStrip, uptimeStripTable } from "enarratio";
import type { HourBucket, SiteSnapshot } from "../types";
import { fromRing, padRing, uptimeOf } from "capsomer/behavior/uptime-strip";
import { RING_SLOTS, slotStart } from "../lib/derive";
import { pct } from "../lib/format";
import { utc } from "capsomer/behavior/time";
import { markup } from "capsomer/behavior/trusted-html";

const TICKS = 84;

export function uptimeOptions(site: SiteSnapshot) {
  const ring = padRing(site.ring, RING_SLOTS);
  const slots = fromRing(ring, {
    slots: TICKS,
    label: ({ first, seen, down }) =>
      `${utc(slotStart(site, first)).slice(5)} +2h, ${seen ? `${seen - down} of ${seen} probes up` : "no watcher pass"}`,
  });
  const downTicks = slots.filter((x) => x.status === "down" || x.status === "degraded").length;
  const gaps = slots.filter((x) => x.status === "unknown").length;
  const up = uptimeOf(ring);
  return {
    slots,
    width: 420,
    height: 22,
    label: `Uptime over 7 days for ${site.name}: ${up == null ? "no probe data" : `${pct(up)} of probes up`}, ${downTicks} two-hour windows with a failed probe, ${gaps} with no watcher pass`,
  };
}

export function UptimeTicks({ site }: { site: SiteSnapshot }) {
  const opts = uptimeOptions(site);
  return (
    <>
      <span
        className="cap-uptime-strip"
        dangerouslySetInnerHTML={markup(uptimeStrip({ ...opts, inline: true }))}
      />
      <span dangerouslySetInnerHTML={markup(uptimeStripTable(opts).markup)} />
    </>
  );
}

export function UptimeFoot({ site }: { site: SiteSnapshot }) {
  const ring = padRing(site.ring, RING_SLOTS);
  return (
    <div className="upct">
      <span>7d</span>
      <span>
        {pct(uptimeOf(ring))} · 24h {pct(uptimeOf(ring.slice(-48)), 1)}
      </span>
    </div>
  );
}

export function errorTotals(e: HourBucket[]) {
  const req = e.reduce((a, x) => a + x.requests, 0);
  const err = e.reduce((a, x) => a + x.errors, 0);
  return { req, err, rate: req ? err / req : null };
}

export function ErrorSpark({ values, label }: { values: number[]; label: string }) {
  return (
    <span
      className="spark"
      dangerouslySetInnerHTML={markup(
        sparkline({
          values,
          label,
          alt: label,
          width: 86,
          height: 22,
          area: true,
          inline: true,
        }),
      )}
    />
  );
}
