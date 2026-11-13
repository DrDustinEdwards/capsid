import { Alert, Banner } from "capsomer/react/banner";
import { trendChart } from "./charts";
import { Fragment, Suspense } from "react";
import { useApp } from "../app/ctx";
import { ago } from "../lib/format";
import { formatBytes } from "capsomer/behavior/format";
import { parse } from "capsomer/behavior/time";
import { OFFACCOUNT_LATE, OFFACCOUNT_STALE, offaccountState } from "../lib/derive";
import { storeUse } from "../lib/store";
import { St } from "../ui/icons";
import { Time } from "capsomer/react/time";
import { Panel } from "capsomer/react/panel";
import { ReadAgain } from "capsomer/react/read-state";
import { NoSnapshot } from "./shared";
import { Spinner } from "capsomer/react/empty";
import { fetchBackups } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import type { SiteBackupRow } from "../types";
import "capsomer/summary-list.css";
import "capsomer/detail-panel.css";

// Chart 10, the retention slots, from GET /portal/api/trends; Enarratio loads with it.
const BackupSlots = trendChart("BackupSlots");

// Health's Backups tab.
export function Backups() {
  const { feed, now } = useApp();
  const snap = feed.snapshot;
  if (!snap) {
    return (
      <div className="cap-stack">
        <NoSnapshot />
      </div>
    );
  }
  const h = snap.health;
  const o = snap.offaccount;
  const os = o ? offaccountState(o, now) : null;
  return (
    <div className="cap-stack">
      <div className="cap-panes" data-even data-gap="5">
        <Panel flush title="Primary: Capsid D1" src="/health backup">
          <div className="body cap-stack" data-gap="4">
            {!h ? (
              <Alert tone="neutral">
                <St kind="nodata">No data</St> Capsid health was not read on the last pass.
              </Alert>
            ) : (
              <>
                {h.backup.warning && <Alert tone="crit">{h.backup.warning}</Alert>}
                <dl className="cap-detail-record">
                  <dt>Last good dump</dt>
                  <dd className="cap-num">
                    {h.backup.last_ok ? (
                      <>
                        {ago(parse(h.backup.last_ok), now)}{" "}
                        <Time at={h.backup.last_ok} format="exact" />
                      </>
                    ) : (
                      <St kind="crit">None recorded</St>
                    )}
                  </dd>
                  <dt>Age</dt>
                  <dd className="cap-num">
                    {h.backup.age_hours == null ? (
                      <St kind="nodata">No data</St>
                    ) : (
                      `${h.backup.age_hours.toFixed(1)}h`
                    )}
                  </dd>
                  <dt>State</dt>
                  <dd>
                    {h.backup.warning || !h.backup.last_ok ? (
                      <St kind="crit">Stale</St>
                    ) : (
                      <St kind="ok">Fresh</St>
                    )}
                  </dd>
                  <dt>Health</dt>
                  <dd>
                    {h.status === "ok" ? <St kind="ok">ok</St> : <St kind="warn">degraded</St>}{" "}
                    <span className="cap-text cap-mono" data-tone="dim">
                      sha {h.sha.slice(0, 7)}
                      {h.dirty ? " (dirty)" : ""}
                    </span>
                  </dd>
                  <dt>Store</dt>
                  <dd className="cap-mono">
                    d1 {h.store.d1} · fts {h.store.fts} · media {h.bindings.media} · kv{" "}
                    {h.bindings.app_kv}
                  </dd>
                  <dt>Size</dt>
                  <dd className="cap-num" data-store-size="">
                    {(() => {
                      const use = storeUse(feed);
                      const s = feed.live.store;
                      if (!use || s.size_bytes === null) return <St kind="nodata">Not reported</St>;
                      return (
                        <>
                          {formatBytes(s.size_bytes)} of {formatBytes(s.cap_bytes)} (
                          {(use.fraction * 100).toFixed(use.fraction < 0.01 ? 2 : 0)}
                          %) {use.warn && <St kind="warn">over half the cap</St>}
                        </>
                      );
                    })()}
                  </dd>
                  <dt>Schema</dt>
                  <dd className="cap-mono">{h.schema_version ?? "not reported"}</dd>
                </dl>
              </>
            )}
          </div>
        </Panel>
        <Panel flush title="Off-account: Amazon S3" src="watch.yml report">
          <div className="body cap-stack" data-gap="4">
            {!o || !os ? (
              <Alert tone="neutral">
                <St kind="nodata">No data</St> The Amazon copy's report was not read on the last
                pass.
              </Alert>
            ) : (
              <>
                {(os.bad || os.warn) && (
                  <Alert tone={os.bad ? "crit" : "warn"}>
                    <b>{os.headline}.</b> {os.detail}.
                  </Alert>
                )}
                <dl className="cap-detail-record">
                  {o.sites.map((s) => (
                    <Fragment key={s.site}>
                      <dt>{s.site}</dt>
                      <dd className="cap-num">
                        {s.newest ? (
                          <>
                            {ago(parse(s.newest), now)} <Time at={s.newest} format="exact" />{" "}
                            {now - parse(s.newest) >= OFFACCOUNT_STALE ? (
                              <St kind="crit">stale</St>
                            ) : now - parse(s.newest) >= OFFACCOUNT_LATE ? (
                              <St kind="warn">late</St>
                            ) : null}
                          </>
                        ) : (
                          <St kind="crit">No copy</St>
                        )}
                      </dd>
                    </Fragment>
                  ))}
                  <dt>Report</dt>
                  <dd className="cap-num">
                    {o.reported_at ? (
                      <>
                        {ago(parse(o.reported_at), now)} <Time at={o.reported_at} format="exact" />
                      </>
                    ) : (
                      <St kind="crit">none yet</St>
                    )}
                  </dd>
                  <dt>Last copy run</dt>
                  <dd>
                    {o.last_run ? (
                      <>
                        {o.last_run.conclusion === "success" ? (
                          <St kind="ok">success</St>
                        ) : o.last_run.conclusion ? (
                          <St kind="crit">{o.last_run.conclusion}</St>
                        ) : (
                          <St kind="run">running</St>
                        )}{" "}
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
                  <dt>Last passing drill</dt>
                  <dd>
                    {o.last_drill ? (
                      <>
                        {o.last_drill.conclusion === "success" ? (
                          <St kind="ok">success</St>
                        ) : o.last_drill.conclusion ? (
                          <St kind="crit">{o.last_drill.conclusion}</St>
                        ) : (
                          <St kind="run">running</St>
                        )}{" "}
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
      <SiteBackups />
      <Suspense fallback={null}>
        <BackupSlots />
      </Suspense>
      <p className="cap-text note" data-tone="dim" data-size="small">
        The primary panel is Capsid's own store. The sites panel is each site's own backups, read
        live through its operator API; Back up now runs the site's files passes, as its nightly cron
        does. The Amazon panel is every site's off-account copy, each site's newest complete one, as
        capsid-backups last reported it.
      </p>
    </div>
  );
}

// Every site's own backups, read live (GET /portal/api/backups), and Back up now: the
// site_backup control, previewed and performed like every control.
function SiteBackups() {
  const { now, confirm } = useApp();
  const load = useAnswer(["backups"], fetchBackups);
  const data = load.data;
  const backUp = (namespace?: string) =>
    confirm({
      action: "site_backup",
      params: namespace ? { namespace } : {},
      title: namespace ? `Back up ${namespace} now` : "Back up every site now",
      onDone: load.reread,
    });
  return (
    <Panel
      flush
      title="Sites"
      id="site-backups"
      section="Site backups"
      src={
        <>
          <ReadAgain
            at={data ? parse(data.read_at) : undefined}
            now={now}
            reading={load.loading}
            onRead={load.reread}
          />{" "}
          <button
            type="button"
            className="cap-btn"
            disabled={!data || data.sites.length === 0}
            onClick={() => backUp()}
          >
            Back up every site now
          </button>
        </>
      }
    >
      <div className="body cap-stack" data-gap="4">
        {load.error && <Banner tone="crit">Could not read the sites' backups: {load.error}</Banner>}
        {!data ? (
          !load.error && (
            <div className="loading" role="status">
              <Spinner label="Reading each site's backups..." />
            </div>
          )
        ) : (
          <>
            {data.not_configured.length > 0 && (
              <Alert tone="neutral">
                Not checked from here yet (no <span className="cap-mono">backup: true</span> in the
                operator configuration): {data.not_configured.join(", ")}.
              </Alert>
            )}
            <table className="cap-table">
              <thead>
                <tr>
                  <th scope="col">Site</th>
                  <th scope="col">Newest dump</th>
                  <th scope="col">Files</th>
                  <th scope="col">Amazon</th>
                  <th scope="col">
                    <span className="cap-sr-only">Back up</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.sites.map((s) => (
                  <SiteRow
                    key={s.namespace}
                    site={s}
                    now={now}
                    backUp={() => backUp(s.namespace)}
                  />
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Panel>
  );
}

function Fresh({
  at,
  warning,
  now,
}: {
  at: string | null | undefined;
  warning?: string;
  now: number;
}) {
  if (!at) return <St kind="crit">None</St>;
  return (
    <>
      {ago(parse(at), now)} {warning ? <St kind="crit">stale</St> : null}
    </>
  );
}

function SiteRow({ site, now, backUp }: { site: SiteBackupRow; now: number; backUp: () => void }) {
  const st = site.status;
  const files = Object.entries(st?.files ?? {});
  return (
    <tr data-site-backup={site.namespace}>
      <th scope="row">{site.namespace}</th>
      <td className="cap-num">
        {st ? (
          <Fresh
            at={st.last_ok}
            warning={
              st.warning && !files.some(([, f]) => f.warning === st.warning)
                ? st.warning
                : undefined
            }
            now={now}
          />
        ) : (
          <St kind="nodata">{site.error ?? "Not read"}</St>
        )}
      </td>
      <td>
        {files.length === 0 ? (
          <St kind="nodata">None reported</St>
        ) : (
          files.map(([name, f]) => (
            <div key={name}>
              <span className="cap-mono">{name}</span>{" "}
              <Fresh at={f.last_ok} warning={f.warning} now={now} />
            </div>
          ))
        )}
      </td>
      <td className="cap-num">
        {site.amazon?.newest ? ago(parse(site.amazon.newest), now) : <St kind="nodata">No copy</St>}
      </td>
      <td>
        <button type="button" className="cap-btn" onClick={backUp}>
          Back up now
        </button>
      </td>
    </tr>
  );
}
