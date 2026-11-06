import { useApp } from "../app/ctx";
import { pct } from "../lib/format";
import { St } from "../ui/icons";
import { Panel } from "capsomer/react/panel";
import "capsomer/uptime-strip.css";
import { uptimeStrip, type UptimeSlot } from "enarratio";

// Each site's last 90 UTC days against the 99.9% target, from the five-minute pulse's daily
// counts (ops_uptime_daily), drawn as Capsomer's uptime strip in its table-cell form with one
// slot per UTC month (U4): up when the month met the target, degraded under it, down when no
// probe answered, the percent beside it. Degraded counts as up: the site answered.
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const monthName = (m: string) => MONTH.format(new Date(`${m}-01T00:00:00Z`));

export function Uptime90({ ns }: { ns: string }) {
  const { feed } = useApp();
  const u = feed.uptime;
  const title = u ? `Uptime by month, ${u.days} days` : "Uptime by month, 90 days";
  const src = u ? `target ${pct(u.target, 1)}, five-minute probes` : "five-minute probes";
  if (u === undefined) return null;
  if (u === null) {
    return (
      <Panel title={title} src={src}>
        <St kind="nodata">No data</St> The daily counts could not be read.
      </Panel>
    );
  }
  const rows = u.sites.filter((s) => ns === "all" || s.namespace === ns);
  return (
    <Panel flush title={title} src={src}>
      {rows.length === 0 ? (
        <p className="faint">No probe counted yet.</p>
      ) : (
        <div className="scroll-x">
          <table className="list">
            <thead>
              <tr>
                <th>Site</th>
                <th>Uptime by month</th>
                <th>Days counted</th>
                <th>Days under target</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const share = s.probes > 0 ? s.up / s.probes : null;
                const slots: UptimeSlot[] = (s.months ?? []).map((m) => {
                  const r = m.probes > 0 ? m.up / m.probes : null;
                  const status = r === null ? "unknown" : m.up === 0 ? "down" : r >= u.target ? "up" : "degraded";
                  return { status, label: `${monthName(m.month)}: ${r === null ? "no probe" : `${pct(r, 2)} of ${m.probes} probes up, ${m.below} of ${m.days} days under target`}` };
                });
                const alt = `Uptime of ${s.namespace} by month: ${(s.months ?? []).map((m) => `${monthName(m.month)} ${m.probes ? pct(m.up / m.probes, 2) : "no data"}`).join(", ")}.`;
                return (
                  <tr key={s.namespace}>
                    <td>
                      <b>{s.namespace}</b>
                    </td>
                    <td>
                      {share === null ? (
                        <St kind="nodata">No data</St>
                      ) : (
                        <span className="cap-uptime-line">
                          <span className="cap-uptime-strip" dangerouslySetInnerHTML={{ __html: uptimeStrip({ slots, alt, inline: true, width: 120, height: 18 }) }} />
                          <span className="cap-uptime-pct">
                            <St kind={share >= u.target ? "ok" : "warn"}>{pct(share, 2)}</St>
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="num">{s.days}</td>
                    <td className="num">{s.below}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ul className="cap-uptime-legend" aria-label="Key">
            <li><span className="cap-uptime-key" data-key="up" aria-hidden="true"></span>Met target</li>
            <li><span className="cap-uptime-key" data-key="degraded" aria-hidden="true"></span>Under target</li>
            <li><span className="cap-uptime-key" data-key="down" aria-hidden="true"></span>Down</li>
            <li><span className="cap-uptime-key" data-key="nodata" aria-hidden="true"></span>No data</li>
          </ul>
        </div>
      )}
    </Panel>
  );
}
