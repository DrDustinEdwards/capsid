import { useState } from "react";
import { RepeaterField } from "capsomer/react/repeater-field";
import { useApp } from "../app/ctx";
import type { PortalNamespace } from "../types";
import { ConfigForm, useConfigForm, type Editing } from "capsomer/react/config-form";
import "capsomer/config-form.css";
import "capsomer/field.css";
import "capsomer/repeater-field.css";
import { Field, TextField } from "capsomer/react/field";
import { DangerZone } from "capsomer/react/danger-zone";
import "capsomer/danger-zone.css";
import "./config-form.css";

// ADD, CHANGE OR DELETE A PROJECT (the Portal audit's new map, 2026-11-06): the namespace_add,
// namespace_edit and namespace_remove controls, which share their rules and audit rows with
// capsid_admin_manage_namespaces (src/namespace-admin.ts, src/namespace-delete.ts). A project is
// its namespace and the repos the repo tools resolve through, exactly one labeled primary. Every
// change previews first in the confirm dialog, which shows what it will do or why it is refused.

type RepoDraft = { repo: string; label: string };

const draftRow = (repo = "", label = ""): RepoDraft => ({ repo, label });

export function ProjectForm({
  editing,
  onClose,
}: {
  editing: Editing<PortalNamespace>;
  onClose: () => void;
}) {
  const { confirm } = useApp();
  const { f, first } = useConfigForm();
  const adding = editing.kind === "add";
  const [ns, setNs] = useState(adding ? "" : editing.row.namespace);
  const [rows, setRows] = useState<RepoDraft[]>(() =>
    adding || !editing.row.repos.length
      ? [draftRow("", "primary")]
      : editing.row.repos.map((r) => draftRow(r.repo, r.label)),
  );
  const [cascade, setCascade] = useState(false);
  const [policies, setPolicies] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const submit = () => {
    const name = ns.trim();
    if (!name) return setHint("Type the project's namespace, such as sample-site.");
    const list = rows
      .map((r) => ({ repo: r.repo.trim(), label: r.label.trim() }))
      .filter((r) => r.repo || r.label);
    if (!list.length) return setHint("Map at least one repo, as owner/name.");
    if (list.some((r) => !r.repo || !r.label))
      return setHint("Each repo needs both its owner/name and a label.");
    if (list.filter((r) => r.label === "primary").length !== 1)
      return setHint('Label exactly one repo "primary": the repo tools resolve to it by default.');
    setHint(null);
    const repos = JSON.stringify(list);
    if (adding)
      return confirm({
        action: "namespace_add",
        params: { namespace: name, repos },
        title: `Add the project ${name}`,
        onDone: onClose,
      });
    confirm({
      action: "namespace_edit",
      params: { namespace: name, repos },
      title: `Change the repos of ${name}`,
      onDone: onClose,
    });
  };

  const remove = () => {
    const params: Record<string, string> = { namespace: ns };
    if (cascade) params.cascade = "true";
    if (policies) params.allow_improve_paths = "true";
    confirm({
      action: "namespace_remove",
      params,
      title: `Delete the project ${ns}`,
      onDone: onClose,
    });
  };

  return (
    <ConfigForm
      f={f}
      first={first}
      title={adding ? "Add a project" : `Edit ${ns}`}
      hint={hint}
      onSubmit={submit}
      onClose={onClose}
      danger={
        !adding && (
          <DangerZone note="Archived documents, versions, the audit log and finished jobs are kept. The preview lists what it deletes, or what has to end first.">
            <label className="check">
              <input
                type="checkbox"
                checked={cascade}
                onChange={(e) => setCascade(e.target.checked)}
              />{" "}
              Also delete its live documents (each is saved as a version first)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={policies}
                onChange={(e) => setPolicies(e.target.checked)}
              />{" "}
              Also delete its signed policy documents
            </label>
            <button
              type="button"
              className="cap-btn"
              data-variant="danger"
              aria-label={`Delete ${ns}`}
              onClick={remove}
            >
              Delete
            </button>
          </DangerZone>
        )
      }
    >
      <Field
        label="Project"
        help="Its namespace: a lowercase slug of a-z, 0-9 and '-'. It cannot be renamed later."
      >
        <input
          ref={adding ? first : undefined}
          id={f("ns")}
          className="cap-input cap-mono"
          value={ns}
          readOnly={!adding}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => (setNs(e.target.value), setHint(null))}
        />
      </Field>
      <div className="full">
        <RepeaterField
          legend="Repos"
          help="What an agent scoped to this project may reach through the repo tools. Exactly one is labeled primary."
          rows={rows}
          onChange={(next) => (setRows(next), setHint(null))}
          newRow={() => draftRow()}
          rowLabel={(i) => `Repo ${i + 1}`}
          addLabel="Add a repo"
          min={1}
        >
          {(r, { set, index }) => (
            <>
              <Field label="Owner/name">
                {(control) => (
                  <input
                    {...control}
                    ref={!adding && index === 0 ? first : undefined}
                    className="cap-input cap-mono"
                    placeholder="owner/name"
                    value={r.repo}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => set({ repo: e.target.value })}
                  />
                )}
              </Field>
              <TextField
                className="cap-mono"
                label="Label"
                placeholder="primary"
                value={r.label}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => set({ label: e.target.value })}
              />
            </>
          )}
        </RepeaterField>
      </div>
      {adding && (
        <p className="cap-text full note" data-tone="dim" data-size="small">
          No driver agent is minted here: a mint hands out a key, so it stays with the admin tools.
          Add the project's site on Sites.
        </p>
      )}
    </ConfigForm>
  );
}
