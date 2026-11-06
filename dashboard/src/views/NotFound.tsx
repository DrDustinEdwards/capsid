import { Spinner } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { fetchNotFound, useAnswer } from "../lib/api";
import type { PortalNotFound } from "../types";
import { St } from "../ui/icons";

// Capsid's own missing pages over 30 days (area 8, N4), from page_404_daily through GET
// /portal/api/not-found: each path with its hits and the hosts that linked to it, so a broken
// link names where it lives. Scanners' probes are counted, not listed. Each other site keeps
// its own table in its own database.
export function NotFound() {
  const load = useAnswer<PortalNotFound>(["not-found"], fetchNotFound);
  const d = load.data;
  const title = `Missing pages, ${d?.days ?? 30} days`;
  const src = "Capsid's page_404_daily";
  if (load.loading)
    return (
      <Panel title={title} src={src}>
        <Spinner label="Reading the 404 counts" />
      </Panel>
    );
  if (load.error || !d || d.pages === null) {
    return (
      <Panel title={title} src={src}>
        <St kind="nodata">No data</St> The 404 counts could not be read:{" "}
        {load.error ?? d?.error ?? "no answer"}.
      </Panel>
    );
  }
  return (
    <Panel flush title={title} src={`${src}; ${d.probes ?? 0} scanner probes not listed`}>
      {d.pages.length === 0 ? (
        <p className="faint">No missing page was asked for.</p>
      ) : (
        <div className="scroll-x">
          <table className="list">
            <thead>
              <tr>
                <th>Path</th>
                <th>Hits</th>
                <th>Linked from</th>
              </tr>
            </thead>
            <tbody>
              {d.pages.map((p) => (
                <tr key={p.path}>
                  <td className="mono">{p.path}</td>
                  <td className="num">{p.hits}</td>
                  <td>
                    {p.referrers.map((r) => `${r.host || "no referrer"} (${r.hits})`).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
