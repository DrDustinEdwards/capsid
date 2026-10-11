// Hand-drawn SVG, one scale per chart. Every chart has role="img" and a text
// alternative; each mark carries a <title> or a data-tip for the pointer.
import type { ReactNode } from "react";
import { uptimeStrip, uptimeStripTable, type UptimeSlot } from "enarratio";
import { EnarChart } from "./Enar";
import type { HourBucket, SiteSnapshot } from "../types";
import { RING_SLOTS, cfNoData, cfOk, ringOf, slotStart, uptime } from "../lib/derive";
import { DAY, SLOT_MS, ms, pct, shortId, utc } from "../lib/format";

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
  const opts = { slots, width: 336, height: 22, label: `Uptime over 7 days for ${site.name}: ${up == null ? "no probe data" : `${pct(up)} of probes up`}, ${downTicks} two-hour windows with a failed probe, ${gaps} with no watcher pass` };
  return <EnarChart className="ticks" draw={() => ({ svg: uptimeStrip(opts), table: uptimeStripTable(opts, { dataTable: "visually-hidden" }).markup })} />;
}

export function UptimeFoot({ site, long }: { site: SiteSnapshot; long?: boolean }) {
  const ring = ringOf(site);
  const p7 = uptime(ring);
  const p24 = uptime(ring.slice(-48));
  return long ? (
    <div className="upct">
      <span>{p7 == null ? "no data" : pct(p7)} over 7 days</span>
      <span>{p24 == null ? "no data" : pct(p24, 1)} over 24h</span>
    </div>
  ) : (
    <div className="upct">
      <span>7d</span>
      <span>
        {pct(p7)} · 24h {pct(p24, 1)}
      </span>
    </div>
  );
}

// ---- sparkline ---------------------------------------------------------------------------

export function Spark({ values, w = 86, h = 22, color, label }: { values: number[]; w?: number; h?: number; color: string; label: string }) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => [i * step, h - 2 - (v / max) * (h - 4)] as const);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="spark">
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={color} opacity=".14" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
      {last && <circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r="2.4" fill={color} />}
    </svg>
  );
}

export function errorTotals(e: HourBucket[]) {
  const req = e.reduce((a, x) => a + x.requests, 0);
  const err = e.reduce((a, x) => a + x.errors, 0);
  return { req, err, rate: req ? err / req : null };
}

// ---- deploys and downtime, one lane per site ------------------------------------------------

// width: the pixel width the chart is drawn into, so its text stays at its set size
// instead of shrinking with the page. Below 760 the chart keeps 760 and its wrapper
// scrolls (phone only; from 1024 px up the wrapper is always wider).
export const TIMELINE_MIN_W = 760;

export function Timeline({ sites, days, now, width }: { sites: SiteSnapshot[]; days: number; now: number; width?: number | null }) {
  const W = Math.max(TIMELINE_MIN_W, Math.floor(width ?? 1100)), rowH = 24, L = 150, R = 16, T = 26;
  const pw = W - L - R;
  const H = T + sites.length * rowH + 8;
  const t1 = now, t0 = t1 - days * DAY;
  const x = (t: number) => L + ((t - t0) / (t1 - t0)) * pw;
  const step = days > 7 ? Math.ceil(days / 10) : 1;
  const dayLines: number[] = [];
  for (let d = 0; d <= days; d += step) dayLines.push(d);
  if (dayLines[dayLines.length - 1] !== days) dayLines.push(days);
  let deployCount = 0;
  let downSlots = 0;
  const lanes = sites.map((s, i) => {
    const cy = T + i * rowH + rowH / 2;
    const ring = ringOf(s);
    const marks: ReactNode[] = [];
    for (let k = 0; k < ring.length; k++) {
      const c = ring[k];
      if (c === "1") continue;
      const ts = slotStart(s, k);
      if (ts + SLOT_MS < t0) continue;
      const x0 = Math.max(L, x(ts));
      const w = Math.max(3, x(ts + SLOT_MS) - x0);
      if (c === "0") downSlots++;
      marks.push(
        <rect key={`r${k}`} x={x0} y={cy - 9} width={w} height="18" rx="2" fill={c === "0" ? "var(--crit)" : "var(--nodata)"} opacity={c === "0" ? 0.75 : 0.45}>
          <title>{c === "0" ? `${s.name} probe failed ${utc(ts)}` : `no watcher pass ${utc(ts)}`}</title>
        </rect>,
      );
    }
    const cf = cfOk(s);
    const why = cfNoData(s.cloudflare);
    for (const d of cf?.deploys ?? []) {
      const t = ms(d.created_on);
      if (t < t0 || t > t1) continue;
      deployCount++;
      const dx = x(t);
      marks.push(
        <g key={d.id}>
          <title>{`${s.name} ${shortId(d.version_id ?? d.id)} · ${utc(t)}${d.triggered_by ? ` · ${d.triggered_by}` : ""}${d.author_email ? ` · ${d.author_email}` : ""}${d.message ? ` · ${d.message}` : ""}`}</title>
          <circle cx={dx} cy={cy} r="5" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
        </g>,
      );
    }
    return (
      <g key={s.name + i}>
        {i % 2 === 0 && <rect x="0" y={T + i * rowH} width={W} height={rowH} fill="var(--raised)" opacity=".6" />}
        <text x="12" y={cy + 4} fontSize="12" fontWeight="600" fontFamily="var(--ui)" fill="var(--text)">
          {s.name.length > 20 ? `${s.name.slice(0, 19)}…` : s.name}
        </text>
        <line x1={L} x2={W - R} y1={cy} y2={cy} stroke="var(--line-strong)" strokeWidth="1" />
        {why && (
          <text x={L + 8} y={cy - 5} fontSize="11" fontFamily="var(--ui)" fill="var(--dim)">
            {`Deploys: no data, ${why}`}
          </text>
        )}
        {marks}
      </g>
    );
  });
  const label = `Deploys and downtime across ${sites.length} sites, last ${days} days: ${deployCount} deploys, ${downSlots} half-hour probe failures.${days > 7 ? " The probe ring holds 7 days." : ""}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {dayLines.map((d) => {
        const tx = x(t0 + d * DAY);
        return (
          <g key={d}>
            <line x1={tx} x2={tx} y1={T - 6} y2={H - 6} stroke="var(--line)" strokeWidth="1" />
            <text x={tx} y={T - 12} textAnchor={d === days ? "end" : d === 0 ? "start" : "middle"} fontSize="11" fontFamily="var(--ui)" fill="var(--muted)">
              {d === days ? "now" : new Date(t0 + d * DAY).toISOString().slice(5, 10)}
            </text>
          </g>
        );
      })}
      {lanes}
    </svg>
  );
}

export function TimelineLegend() {
  return (
    <div className="tl-legend">
      <span>
        <svg width="12" height="12" aria-hidden="true">
          <circle cx="6" cy="6" r="5" fill="var(--accent)" />
        </svg>
        Deploy
      </span>
      <span>
        <svg width="14" height="10" aria-hidden="true">
          <rect width="14" height="10" rx="2" fill="var(--crit)" opacity=".75" />
        </svg>
        Probe failed
      </span>
      <span>
        <svg width="14" height="10" aria-hidden="true">
          <rect width="14" height="10" rx="2" fill="var(--nodata)" opacity=".45" />
        </svg>
        No watcher pass
      </span>
    </div>
  );
}

// ---- freshness ring: counts down to the next poll ----------------------------------------------

export function FreshRing({ frac, stale }: { frac: number; stale: boolean }) {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ring" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--line-strong)" strokeWidth="2" />
      <circle cx="8" cy="8" r={r} fill="none" stroke={stale ? "var(--warn)" : "var(--accent)"} strokeWidth="2" strokeDasharray={`${(c * frac).toFixed(2)} ${c.toFixed(2)}`} transform="rotate(-90 8 8)" strokeLinecap="round" />
    </svg>
  );
}

