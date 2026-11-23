import { useApp } from "../app/ctx";
import { Row } from "capsomer/react/row-list";
import { Status } from "capsomer/react/status";
import { KIND_STATUS } from "../lib/derive";
import type { AutoMergeAsks } from "../lib/waiting";
import type { ConfirmRequest } from "../app/ctx";
import type { OpsFeed } from "../types";
import type { UnitRow } from "../lib/merge-units";
import type { Kind } from "../lib/derive";

// Auto-merge's controls, for Needs you and Pull requests: sign_policy_from_repo,
// automerge_resume, sign_policy_change (the next version typed) and unit_resume
// (docs/autonomy.md, "Earned promotion and demotion").
export const UNIT_STATE: Record<UnitRow["state"], { kind: Kind; label: string }> = {
  auto: { kind: "ok", label: "Auto" },
  suspended: { kind: "warn", label: "Suspended" },
  promote: { kind: "queued", label: "Ready to promote" },
  demote: { kind: "warn", label: "Proposed for removal" },
};

export const signPolicyRequest: ConfirmRequest = {
  action: "sign_policy_from_repo",
  params: {},
  title: "Load the auto-merge policy from the repo and sign it",
};

export const resumeRequest = (namespace: string): ConfirmRequest => ({
  action: "automerge_resume",
  params: { namespace },
  title: `Resume auto-merge for ${namespace}`,
});

/** A unit's buttons: Lift suspension, Promote, and Demote while the policy lists it. */
export function UnitButtons({
  row,
  policy,
  suspended,
}: {
  row: UnitRow;
  policy: Extract<OpsFeed["live"]["merge_policy"], { loads: true }>;
  suspended: boolean;
}) {
  const { confirm } = useApp();
  const next = String(Number(policy.version) + 1);
  const sign = (change: "promote" | "demote") =>
    confirm({
      action: "sign_policy_change",
      params: { change, unit: row.unit },
      title:
        change === "promote"
          ? `Promote ${row.unit} to auto-merge`
          : `Remove ${row.unit} from auto-merge`,
      confirmHelp: `The policy's next version, ${next}. It decides what merges with no human, so it is typed, not clicked.`,
    });
  return (
    <span className="cap-cluster" data-gap="3">
      {suspended && (
        <button
          type="button"
          className="cap-btn"
          aria-label={`Lift the suspension of ${row.unit}`}
          onClick={() =>
            confirm({
              action: "unit_resume",
              params: { unit: row.unit },
              title: `Lift the suspension of ${row.unit}`,
            })
          }
        >
          Lift suspension
        </button>
      )}
      {row.state === "promote" && (
        <button
          type="button"
          className="cap-btn"
          data-variant="primary"
          aria-label={`Promote ${row.unit}`}
          onClick={() => sign("promote")}
        >
          Promote
        </button>
      )}
      {policy.units.includes(row.unit) && (
        <button
          type="button"
          className="cap-btn"
          aria-label={`Demote ${row.unit}`}
          onClick={() => sign("demote")}
        >
          Demote
        </button>
      )}
    </span>
  );
}

/** Needs you's Auto-merge rows. */
export function AutoMergeRows({ asks }: { asks: AutoMergeAsks }) {
  const { confirm } = useApp();
  const { policy, paused, unitAsks, suspended } = asks;
  if (!policy) return null;
  return (
    <>
      {!policy.loads && (
        <Row
          status={<Status tone="crit">Does not load</Status>}
          title="Auto-merge policy"
          detail={policy.reason ?? undefined}
          actions={
            <button
              type="button"
              className="cap-btn"
              data-variant="primary"
              onClick={() => confirm(signPolicyRequest)}
            >
              Load from repo and sign
            </button>
          }
        />
      )}
      {paused.map((n) => (
        <Row
          key={n.namespace}
          status={<Status tone="warn">Paused</Status>}
          title={n.namespace}
          detail={n.paused?.reason}
          actions={
            <button
              type="button"
              className="cap-btn"
              data-variant="primary"
              aria-label={`Resume auto-merge for ${n.namespace}`}
              onClick={() => confirm(resumeRequest(n.namespace))}
            >
              Resume
            </button>
          }
        />
      ))}
      {unitAsks.map((r) => {
        const st = UNIT_STATE[r.state];
        return (
          <Row
            key={r.unit}
            status={<Status {...KIND_STATUS[st.kind]}>{st.label}</Status>}
            title={<span className="cap-mono">{r.unit}</span>}
            detail={r.why || undefined}
            actions={
              policy.loads && (
                <UnitButtons row={r} policy={policy} suspended={suspended.has(r.unit)} />
              )
            }
          />
        );
      })}
    </>
  );
}
