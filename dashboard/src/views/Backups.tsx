import { useApp } from "../app/ctx";
import { DAY, ago, ms, utc } from "../lib/format";
import { St } from "../ui/icons";
import { NoSnapshot, PageHead, Panel } from "./shared";

export function Backups() {
  const { feed, now } = useApp();
  const snap = feed.snapshot;
  const head = <PageHead title="Backups" />;
  if (!snap) {
    return (
      <div className="page">
        {head}
        <NoSnapshot />
      </div>
    );
  }
  const h = snap.health;
  const m = snap.mirror;
  const dumpAge = m?.newest_dump ? now - ms(m.newest_dump) : null;
  const mirrorBad = !m || dumpAge == null || dumpAge > 2 * DAY || (m.last_run?.conclusion != null && m.last_run.conclusion !== "success");
  return (
    <div className="page">
      {head}
      <div className="grid2">
        <Panel title="Primary: Capsid D1" src="/health backup">
          <div className="body stack-gap">
            {!h ? (
              <div className="callout">
                <St kind="nodata">No data</St> Capsid health was not read on the last pass.
              </div>
            ) : (
              <>
                {h.backup.warning && <div className="callout crit">{h.backup.warning}</div>}
                <dl className="kv">
                  <dt>Last good dump</dt>
                  <dd className="num">{h.backup.last_ok ? `${utc(ms(h.backup.last_ok))} (${ago(ms(h.backup.last_ok), now)})` : <St kind="crit">None recorded</St>}</dd>
                  <dt>Age</dt>
                  <dd className="num">{h.backup.age_hours == null ? <St kind="nodata">No data</St> : `${h.backup.age_hours.toFixed(1)}h`}</dd>
                  <dt>State</dt>
                  <dd>{h.backup.warning || !h.backup.last_ok ? <St kind="crit">Stale</St> : <St kind="ok">Fresh</St>}</dd>
                  <dt>Health</dt>
                  <dd>
                    {h.status === "ok" ? <St kind="ok">ok</St> : <St kind="warn">degraded</St>} <span className="mono faint">sha {h.sha.slice(0, 7)}{h.dirty ? " (dirty)" : ""}</span>
                  </dd>
                  <dt>Store</dt>
                  <dd className="mono">
                    d1 {h.store.d1} · fts {h.store.fts} · media {h.bindings.media} · kv {h.bindings.app_kv}
                  </dd>
                  <dt>Schema</dt>
                  <dd className="mono">{h.schema_version ?? "not reported"}</dd>
                </dl>
              </>
            )}
          </div>
        </Panel>
        <Panel title="Off-account mirror" src="mirror workflow">
          <div className="body stack-gap">
            {!m ? (
              <div className="callout">
                <St kind="nodata">No data</St> The mirror was not read on the last pass.
              </div>
            ) : (
              <>
                {mirrorBad && (
                  <div className="callout crit">
                    <b>{dumpAge == null ? "No dump recorded." : `No dump for ${(dumpAge / DAY).toFixed(1)} days.`}</b>{" "}
                    {m.last_run ? `Last run ${m.last_run.conclusion ?? "still running"}${m.last_run.at ? ` ${ago(ms(m.last_run.at), now)}` : ""}.` : "No run recorded."}
                  </div>
                )}
                <dl className="kv">
                  <dt>Newest dump</dt>
                  <dd className="num">{m.newest_dump ? `${utc(ms(m.newest_dump))} (${ago(ms(m.newest_dump), now)})` : "none"}</dd>
                  <dt>Last run</dt>
                  <dd>
                    {m.last_run ? (
                      <>
                        {m.last_run.conclusion === "success" ? <St kind="ok">success</St> : m.last_run.conclusion ? <St kind="crit">{m.last_run.conclusion}</St> : <St kind="run">running</St>}{" "}
                        {m.last_run.url && (
                          <a href={m.last_run.url} target="_blank" rel="noopener noreferrer">
                            run
                          </a>
                        )}
                      </>
                    ) : (
                      <St kind="nodata">none</St>
                    )}
                  </dd>
                </dl>
              </>
            )}
          </div>
        </Panel>
      </div>
      <p className="faint note">The feed reports Capsid's own store and its mirror. Backups of the other sites are not part of it, so they are not shown here.</p>
    </div>
  );
}
