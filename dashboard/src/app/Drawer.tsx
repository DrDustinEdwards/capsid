import { Alert } from "capsomer/react/banner";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Dialog } from "capsomer/react/dialog";
import { Missing as NoValue } from "capsomer/react/empty";
import { Spinner } from "capsomer/react/skeleton";
import { useApp, type ConfirmRequest, type DrawerType } from "./ctx";
import { fetchActivity } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import { actionWords } from "../lib/audit-words";
import { KIND_STATUS } from "../lib/derive";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import { Pill } from "capsomer/react/status";
import { Time } from "capsomer/react/time";
import { agentState, nsList } from "../lib/agents";
import type { OpsAgent } from "../types";
import { DangerZone } from "capsomer/react/danger-zone";
import "capsomer/danger-zone.css";
import "capsomer/summary-list.css";
import "capsomer/detail-panel.css";

type Ref = { type: DrawerType; id: string };

function Head({
  label,
  title,
  sub,
  badge,
  onClose,
}: {
  label: string;
  title: string;
  sub?: string;
  badge?: ReactNode;
  onClose: () => void;
}) {
  return (
    <>
      <header className="cap-dialog-header" data-divider>
        <div className="cap-detail-heading">
          <p className="cap-detail-kind">{label}</p>
          <div className="cap-detail-titlerow">
            <h2 className="cap-dialog-title" id="drawerTitle">
              {title}
            </h2>
            {badge}
          </div>
          {sub && <p className="cap-detail-id">{sub}</p>}
        </div>
      </header>
      <button
        type="button"
        className="cap-btn cap-dialog-close"
        data-variant="quiet"
        data-icon-only
        data-close
        aria-label="Close"
        onClick={onClose}
      >
        ×
      </button>
    </>
  );
}

function ChangeIt({ label, req, hint }: { label: string; req: ConfirmRequest; hint?: string }) {
  const { confirm } = useApp();
  return (
    <div>
      <p className="section-title">Change it</p>
      <div className="cap-cluster" data-gap="3">
        <button
          type="button"
          className="cap-btn"
          data-variant="primary"
          onClick={() => confirm(req)}
        >
          {label}
        </button>
      </div>
      {hint && (
        <p className="cap-text hint" data-tone="dim" data-size="small">
          {hint}
        </p>
      )}
    </div>
  );
}

function AgentControls({ a }: { a: OpsAgent }) {
  const { confirm } = useApp();
  if (a.revoked_at) return null;
  return (
    <div className="cap-stack" data-gap="4">
      {a.pending && (
        <ChangeIt
          label="Activate"
          req={{
            action: "activate_agent",
            params: { name: a.name },
            title: `Activate agent ${a.name}`,
          }}
          hint="Its key works only once you activate it. If you did not ask for it, revoke it."
        />
      )}
      <DangerZone note="Ends this credential.">
        <button
          type="button"
          className="cap-btn"
          data-variant="danger"
          onClick={() =>
            confirm({
              action: "revoke_agent",
              params: { name: a.name },
              title: `Revoke agent ${a.name}`,
            })
          }
        >
          Revoke
        </button>
      </DangerZone>
    </div>
  );
}

function Missing({ what, onClose }: { what: string; onClose: () => void }) {
  return (
    <>
      <Head label="Not found" title={what} onClose={onClose} />
      <div className="cap-dialog-body cap-detail-body">
        <Alert tone="neutral">Not in the current feed.</Alert>
      </div>
    </>
  );
}

function AuditBody({ id, onClose }: { id: string; onClose: () => void }) {
  const { now } = useApp();
  const load = useAnswer(["activity", "row", id], () => fetchActivity({ id }), {
    keep: false,
  });
  if (!load.data && load.loading) {
    return (
      <>
        <Head label="Audit row" title={`#${id}`} onClose={onClose} />
        <div className="cap-dialog-body cap-detail-body">
          <Spinner layout="page" label="Reading the row..." />
        </div>
      </>
    );
  }
  if (!load.data) {
    return (
      <>
        <Head label="Audit row" title={`#${id}`} onClose={onClose} />
        <div className="cap-dialog-body cap-detail-body">
          <Alert tone="crit">Could not read the row: {load.error}</Alert>
        </div>
      </>
    );
  }
  const r = load.data.rows[0];
  if (!r) {
    return (
      <>
        <Head label="Not found" title={`Audit row #${id}`} onClose={onClose} />
        <div className="cap-dialog-body cap-detail-body">
          <Alert tone="neutral">No audit row with this id.</Alert>
        </div>
      </>
    );
  }
  const d = r.detail;
  return (
    <>
      <Head
        label={`Audit row · ${r.namespace ?? "no namespace"}`}
        title={actionWords(r.action) ?? r.action ?? "no action"}
        sub={`#${r.id} · ${r.action ?? "no action"} · ${r.actor ?? "no actor"}`}
        onClose={onClose}
      />
      <div className="cap-dialog-body cap-detail-body">
        {d.reason !== null && (
          <div>
            <p className="section-title">Reason</p>
            <Alert tone="neutral">{d.reason}</Alert>
          </div>
        )}
        {d.changes !== null && (
          <div>
            <p className="section-title">What changed</p>
            {d.changes.length === 0 ? (
              <p className="cap-text" data-tone="dim">
                No field changed.
              </p>
            ) : (
              <dl className="cap-detail-record">
                {d.changes.map((c) => (
                  <Fragment key={c.field}>
                    <dt>{c.field}</dt>
                    <dd className="cap-detail-diff">
                      {c.before !== null && (
                        <del className="cap-mono" aria-label={`before: ${c.before}`}>
                          {c.before}
                        </del>
                      )}
                      {c.after !== null ? (
                        <ins className="cap-mono" aria-label={`after: ${c.after}`}>
                          {c.after}
                        </ins>
                      ) : (
                        <span className="cap-text" data-tone="dim">
                          removed
                        </span>
                      )}
                    </dd>
                  </Fragment>
                ))}
              </dl>
            )}
          </div>
        )}
        <div>
          <p className="section-title">Recorded</p>
          <dl className="cap-detail-record">
            <dt>When</dt>
            <dd>
              {ago(parse(r.at), now)} <Time at={r.at} format="exact" />
            </dd>
            <dt>Actor</dt>
            <dd className="cap-mono">{r.actor ?? <NoValue />}</dd>
            {r.client && (
              <>
                <dt>Via</dt>
                <dd>{r.client}</dd>
              </>
            )}
            {r.path && (
              <>
                <dt>Path</dt>
                <dd className="cap-mono wrap">{r.path}</dd>
              </>
            )}
            {d.fields.map((f) => (
              <Fragment key={f.name}>
                <dt>{f.name}</dt>
                <dd className="cap-mono wrap">{f.value}</dd>
              </Fragment>
            ))}
          </dl>
          {d.unreadable && (
            <p className="cap-text" data-tone="dim">
              Detail is not JSON, so it is not shown.
            </p>
          )}
          {d.withheld > 0 && (
            <p className="cap-text" data-tone="dim">
              {d.withheld} recorded {d.withheld === 1 ? "field is" : "fields are"} not shown:
              hashes, signatures and nested values stay in the audit log.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function AgentBody({ name, onClose }: { name: string; onClose: () => void }) {
  const { feed, now } = useApp();
  const a = feed.live.agents.find((x) => x.name === name);
  if (!a) return <Missing what={`Agent ${name}`} onClose={onClose} />;
  const st = agentState(a, now);
  return (
    <>
      <Head
        label={`Agent · ${a.kind}`}
        title={a.name}
        sub={`agent:${a.name}`}
        badge={<Pill {...KIND_STATUS[st.kind]}>{st.label}</Pill>}
        onClose={onClose}
      />
      <div className="cap-dialog-body cap-detail-body">
        <dl className="cap-detail-record">
          <dt>Namespaces</dt>
          <dd className="cap-mono">{nsList(a)}</dd>
          <dt>Last seen</dt>
          <dd>
            {a.last_seen ? (
              <>
                {ago(parse(a.last_seen), now)} <Time at={a.last_seen} format="exact" />
              </>
            ) : (
              "never"
            )}
          </dd>
          {a.revoked_at && (
            <>
              <dt>Revoked</dt>
              <dd>
                <Time at={a.revoked_at} format="exact" />
              </dd>
            </>
          )}
          {a.archived_at && (
            <>
              <dt>Archived</dt>
              <dd>
                <Time at={a.archived_at} format="exact" />
              </dd>
            </>
          )}
          <dt>Flags</dt>
          <dd>{a.flags.join(", ") || "none"}</dd>
        </dl>
        <AgentControls a={a} />
      </div>
    </>
  );
}

// Native showModal, so the page behind is inert and Tab stays inside (audit DECIDE 9).
export function Drawer({ route, onClose }: { route: Ref | null; onClose: () => void }) {
  const { open } = useApp();
  const [shown, setShown] = useState<Ref | null>(route);
  if (route && (shown?.type !== route.type || shown.id !== route.id)) setShown(route);
  const routed = useRef(route != null);
  useEffect(() => {
    routed.current = route != null;
  });
  const ref = route ?? shown;
  let body: ReactNode = null;
  if (ref?.type === "agent") {
    body = <AgentBody name={ref.id} onClose={onClose} />;
  } else if (ref?.type === "audit") {
    body = <AuditBody key={ref.id} id={ref.id} onClose={onClose} />;
  }
  const openRow = (e: ReactMouseEvent | ReactKeyboardEvent): boolean => {
    const t = e.target as Element;
    const el = t.closest<HTMLElement>("[data-open]");
    if (!el?.dataset.open || t.closest("a,button")) return false;
    open(el.dataset.open);
    return true;
  };
  return (
    <Dialog
      open={route != null}
      onOpenChange={(o) => {
        if (!o && routed.current) onClose();
      }}
      placement="right"
      closeButton={false}
      className="drawer cap-detail"
      aria-labelledby="drawerTitle"
      onClick={(e) => {
        openRow(e);
      }}
      onKeyDown={(e) => {
        // Enter on a focused row: cancel its default so the new panel's Close button is not activated by the same key.
        if (e.key === "Enter" && openRow(e)) e.preventDefault();
      }}
    >
      {body}
    </Dialog>
  );
}
