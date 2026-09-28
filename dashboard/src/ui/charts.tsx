// Hand-drawn SVG, one scale per chart. Every chart has role="img" and a text
// alternative; each mark carries a <title> or a data-tip for the pointer.
import type { CSSProperties, ReactNode } from "react";
import type { HourBucket, SiteSnapshot } from "../types";
import { RING_SLOTS, cfNoData, cfOk, ringOf, slotStart, uptime } from "../lib/derive";
import { DAY, HOUR, SLOT_MS, fmtN, ms, pct, shortId, utc } from "../lib/format";

// ---- uptime ticks: 336 half-hour slots as 84 two-hour ticks ------------------------

const TICKS = 84;
const PER = RING_SLOTS / TICKS;

export function UptimeTicks({ site }: { site: SiteSnapshot }) {
  const ring = ringOf(site);
  const ticks: ReactNode[] = [];
  let downTicks = 0;
  let gaps = 0;
  for (let b = 0; b < TICKS; b++) {
    const slice = ring.slice(b * PER, (b + 1) * PER);
    const seen = [...slice].filter((c) => c !== "-").length;
    const down = [...slice].filter((c) => c === "0").length;
    const start = slotStart(site, b * PER);
    const tip = `${utc(start).slice(5)} +2h\n${seen ? `${seen - down}/${seen} probes up` : "no data: no watcher pass"}`;
    const cls = !seen ? "n" : down === seen ? "d" : down ? "p" : "";
    if (down) downTicks++;
    if (!seen) gaps++;
    const style = cls === "p" ? ({ "--f": `${Math.max(18, Math.round((down / seen) * 100))}%` } as CSSProperties) : undefined;
    ticks.push(<i key={b} className={cls} style={style} data-tip={tip} />);
  }
  const up = uptime(ring);
  const label = `Uptime over 7 days for ${site.name}: ${up == null ? "no probe data" : `${pct(up)} of probes up`}, ${downTicks} two-hour windows with a failed probe, ${gaps} with no watcher pass.`;
  return (
    <div className="ticks" role="img" aria-label={label}>
      {ticks}
    </div>
  );
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

// ---- 24h requests and error rate, with deploy markers ----------------------------------------

export function ErrorChart({ site }: { site: SiteSnapshot }) {
  const cf = cfOk(site);
  const why = cfNoData(site.cloudflare);
  if (!cf) return <div className="callout">No data: {why}</div>;
  if (!cf.errors24) return <div className="callout">No data: {cf.errors_reason ?? "the analytics read failed"}</div>;
  const e = cf.errors24;
  if (!e.length) return <div className="callout">No data: the analytics read returned no hours</div>;
  const W = 560, H = 170, L = 40, R = 10, T = 12, B = 26;
  const pw = W - L - R, ph = H - T - B;
  const rates = e.map((x) => (x.requests ? (x.errors / x.requests) * 100 : 0));
  const maxR = Math.max(1, Math.ceil(Math.max(...rates)));
  const maxQ = Math.max(1, ...e.map((x) => x.requests));
  const bw = pw / e.length;
  const y = (v: number) => T + ph - (v / maxR) * ph;
  const t0 = ms(e[0]!.hour);
  const t1 = ms(e[e.length - 1]!.hour) + HOUR;
  const grid: number[] = [];
  for (let g = 0; g <= maxR; g += Math.max(1, Math.round(maxR / 4))) grid.push(g);
  const tot = errorTotals(e);
  const peak = Math.max(...rates);
  const inWindow = cf.deploys.filter((d) => ms(d.created_on) >= t0 && ms(d.created_on) <= t1);
  const label = `Requests and error rate for ${site.name}, last 24 hours: ${fmtN(tot.req)} requests, ${fmtN(tot.err)} errors (${pct(tot.rate)}), peak hour ${peak.toFixed(2)}%, ${inWindow.length} deploys in the window.`;
  const xAt = (t: number) => L + ((t - t0) / (t1 - t0)) * pw;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="chart">
      {grid.map((g) => (
        <g key={g}>
          <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke="var(--line)" strokeWidth="1" />
          <text x={L - 6} y={y(g) + 3} textAnchor="end" fontSize="9" fontFamily="var(--mono)" fill="var(--muted)">
            {g}%
          </text>
        </g>
      ))}
      {e.map((x, i) => {
        const bh = (x.requests / maxQ) * ph * 0.9;
        return (
          <rect key={x.hour} x={L + i * bw + 1.5} y={T + ph - bh} width={Math.max(1, bw - 3)} height={bh} fill="var(--line-strong)" opacity=".55">
            <title>{`${utc(ms(x.hour))}: ${x.requests} requests, ${x.errors} errors`}</title>
          </rect>
        );
      })}
      <path d={rates.map((r, i) => `${i ? "L" : "M"}${(L + i * bw + bw / 2).toFixed(1)} ${y(r).toFixed(1)}`).join(" ")} fill="none" stroke="var(--crit)" strokeWidth="1.8" strokeLinejoin="round" />
      {rates.map((r, i) => (
        <circle key={i} cx={(L + i * bw + bw / 2).toFixed(1)} cy={y(r).toFixed(1)} r="2" fill="var(--crit)">
          <title>{`${r.toFixed(2)}% errors`}</title>
        </circle>
      ))}
      <line x1={L} x2={W - R} y1={y(1)} y2={y(1)} stroke="var(--warn)" strokeDasharray="4 3" />
      <text x={W - R} y={y(1) - 4} textAnchor="end" fontSize="9" fontFamily="var(--mono)" fill="var(--warn)">
        alert at 1%
      </text>
      {inWindow.map((d) => {
        const x = xAt(ms(d.created_on));
        return (
          <g key={d.id}>
            <title>{`deploy ${shortId(d.version_id ?? d.id)} ${utc(ms(d.created_on))}${d.message ? `: ${d.message}` : ""}`}</title>
            <line x1={x} x2={x} y1={T} y2={T + ph} stroke="var(--accent)" strokeWidth="1.2" />
            <path d={`M${x - 4} ${T} L${x + 4} ${T} L${x} ${T + 6} Z`} fill="var(--accent)" />
          </g>
        );
      })}
      {[0, 6, 12, 18, 24].map((hh) => (
        <text key={hh} x={L + (hh / 24) * pw} y={H - 8} textAnchor="middle" fontSize="9" fontFamily="var(--mono)" fill="var(--muted)">
          {hh === 24 ? "now" : `-${24 - hh}h`}
        </text>
      ))}
    </svg>
  );
}

// ---- deploys and downtime, one lane per site ------------------------------------------------

export function Timeline({ sites, days, now }: { sites: SiteSnapshot[]; days: number; now: number }) {
  const W = 1100, rowH = 30, L = 150, R = 16, T = 26;
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
          <text x={L + 8} y={cy - 5} fontSize="10" fontFamily="var(--mono)" fill="var(--faint)">
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
            <text x={tx} y={T - 12} textAnchor={d === days ? "end" : d === 0 ? "start" : "middle"} fontSize="10" fontFamily="var(--mono)" fill="var(--muted)">
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

