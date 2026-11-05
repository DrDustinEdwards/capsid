import { trendChart } from "./charts";
import { Fragment, Suspense } from "react";
import { useApp } from "../app/ctx";
import { ago, bytes, ms } from "../lib/format";
import { OFFACCOUNT_LATE, OFFACCOUNT_STALE, offaccountState } from "../lib/derive";
import { storeUse } from "../lib/store";
import { St } from "../ui/icons";
import { When } from "../ui/When";
import { Panel } from "capsomer/react/panel";
import { NoSnapshot, PageHead } from "./shared";

// Chart 10, the retention slots, from GET /portal/api/trends; Enarratio loads with it.
const BackupSlots = trendChart("BackupSlots");

export function Backups({ embedded = false }: { embedded?: boolean } = {}) {
  const { feed, now } = useApp();
  const snap = feed.snapshot;
  const head = embedded ? null : <PageHead title="Backups" />;
  if (!snap) {
    return (
      <div className={embedded ? "embedded" : "page"}>
        {head}
        <NoSnapshot />
      </div>
    );
  }
  const h = snap.health;
  const o = snap.offaccount;
  const os = o ? offaccountState(o, now) : null;
  return (
    <div className={embedded ? "embedded" : "page"}>
      {head}
      <div className="grid2">
        <Panel flush title="Primary: Capsid D1" src="/health backup">
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
                  <dd className="num">{h.backup.last_ok ? <>{ago(ms(h.backup.last_ok), now)} <When t={ms(h.backup.last_ok)} /></> : <St kind="crit">None recorded</St>}</dd>
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
                  <dt>Size</dt>
                  <dd className="num" data-store-size="">
                    {(() => {
                      const use = storeUse(feed);
                      const s = feed.live.store;
                      if (!use || s.size_bytes === null) return <St kind="nodata">Not reported</St>;
                      return (
                        <>
                          {bytes(s.size_bytes)} of {bytes(s.cap_bytes)} ({(use.fraction * 100).toFixed(use.fraction < 0.01 ? 2 : 0)}%){" "}
                          {use.warn && <St kind="warn">over half the cap</St>}
                        </>
                      );
                    })()}
                  </dd>
                  <dt>Schema</dt>
                  <dd className="mono">{h.schema_version ?? "not reported"}</dd>
                </dl>
              </>
            )}
          </div>
        </Panel>
        <Panel flush title="Off-account: Amazon S3" src="watch.yml report">
          <div className="body stack-gap">
            {!o || !os ? (
              <div className="callout">
                <St kind="nodata">No data</St> The Amazon copy's report was not read on the last pass.
              </div>
            ) : (
              <>
                {(os.bad || os.warn) && (
                  <div className={`callout ${os.bad ? "crit" : "warn"}`}>
                    <b>{os.headline}.</b> {os.detail}.
                  </div>
                )}
                <dl className="kv">
                  {o.sites.map((s) => (
                    <Fragment key={s.site}>
                      <dt>{s.site}</dt>
                      <dd className="num">
                        {s.newest ? (
                          <>
                            {ago(ms(s.newest), now)} <When t={ms(s.newest)} /> {now - ms(s.newest) >= OFFACCOUNT_STALE ? <St kind="crit">stale</St> : now - ms(s.newest) >= OFFACCOUNT_LATE ? <St kind="warn">late</St> : null}
                          </>
                        ) : (
                          <St kind="crit">No copy</St>
                        )}
                      </dd>
                    </Fragment>
                  ))}
                  <dt>Report</dt>
                  <dd className="num">{o.reported_at ? <>{ago(ms(o.reported_at), now)} <When t={ms(o.reported_at)} /></> : <St kind="crit">none yet</St>}</dd>
                  <dt>Last copy run</dt>
                  <dd>
                    {o.last_run ? (
                      <>
                        {o.last_run.conclusion === "success" ? <St kind="ok">success</St> : o.last_run.conclusion ? <St kind="crit">{o.last_run.conclusion}</St> : <St kind="run">running</St>}{" "}
                        {o.last_run.url && (
                          <a href={o.last_run.url} target="_blank" rel="noopener noreferrer">
                            run
                          </a>
                        )}
                      </>
                    ) : (
                      <St kind="nodata">none</St>
                    )}
                  </dd>
                  <dt>Last restore drill</dt>
                  <dd>
                    {o.last_drill ? (
                      <>
                        {o.last_drill.conclusion === "success" ? <St kind="ok">success</St> : o.last_drill.conclusion ? <St kind="crit">{o.last_drill.conclusion}</St> : <St kind="run">running</St>}{" "}
                        {o.last_drill.url && (
                          <a href={o.last_drill.url} target="_blank" rel="noopener noreferrer">
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
      <Suspense fallback={null}>
        <BackupSlots />
      </Suspense>
      <p className="faint note">The primary panel is Capsid's own store. The Amazon panel is every site's off-account copy, each site's newest complete one, as capsid-backups last reported it.</p>
    </div>
  );
}
