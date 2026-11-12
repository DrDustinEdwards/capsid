import { useState } from "react";
import { useApp } from "../app/ctx";
import type { OpsPackageConfig } from "../types";
import { ConfigForm, useConfigForm, type Editing } from "capsomer/react/config-form";
import "capsomer/config-form.css";
import { Field } from "./shared";
import { DangerZone } from "capsomer/react/danger-zone";
import "capsomer/danger-zone.css";

// The package configuration (live.packages, the ops_packages table): one row per npm
// package Packages' Published tab shows, added and changed there. Every change goes through the confirm dialog, which
// previews it first; the server validates every field.

interface Draft {
  name: string;
  repo: string;
  formerly: string;
}

function paramsOf(d: Draft): Record<string, string> {
  const p: Record<string, string> = {};
  for (const k of ["name", "repo", "formerly"] as const) {
    const v = d[k].trim();
    if (v) p[k] = v;
  }
  return p;
}

export function PackageForm({
  editing,
  onClose,
}: {
  editing: Editing<OpsPackageConfig>;
  onClose: () => void;
}) {
  const { confirm } = useApp();
  const { f, first } = useConfigForm();
  const adding = editing.kind === "add";
  const [d, setD] = useState<Draft>(
    adding
      ? { name: "", repo: "", formerly: "" }
      : {
          name: editing.row.name,
          repo: editing.row.repo ?? "",
          formerly: editing.row.formerly ?? "",
        },
  );
  const [hint, setHint] = useState<string | null>(null);
  const submit = () => {
    if (!d.name.trim()) return setHint("Type the package's npm name.");
    setHint(null);
    if (editing.kind === "add")
      return confirm({
        action: "package_add",
        params: paramsOf(d),
        title: `Add ${d.name.trim()}`,
        onDone: onClose,
      });
    confirm({
      action: "package_edit",
      params: { ...paramsOf(d), name: editing.row.name, revision: String(editing.row.revision) },
      title: `Change ${editing.row.name}`,
      onDone: onClose,
    });
  };
  return (
    <ConfigForm
      f={f}
      first={first}
      title={adding ? "Add a package" : `Edit ${editing.row.name}`}
      src={adding ? undefined : `revision ${editing.row.revision}`}
      hint={hint}
      onSubmit={submit}
      onClose={onClose}
      danger={
        !adding && (
          <DangerZone note="The Packages page stops showing it.">
            <button
              type="button"
              className="cap-btn"
              data-variant="danger"
              aria-label={`Remove ${editing.row.name}`}
              onClick={() =>
                confirm({
                  action: "package_remove",
                  params: { name: editing.row.name, revision: String(editing.row.revision) },
                  title: `Remove ${editing.row.name}`,
                  onDone: onClose,
                })
              }
            >
              Remove
            </button>
          </DangerZone>
        )
      }
    >
      <Field id={f("name")} label="npm name">
        <input
          ref={first}
          id={f("name")}
          className="field mono"
          value={d.name}
          readOnly={!adding}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setD({ ...d, name: e.target.value })}
        />
      </Field>
      <Field id={f("repo")} label="GitHub repository">
        <input
          id={f("repo")}
          className="field mono"
          value={d.repo}
          placeholder="owner/name"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setD({ ...d, repo: e.target.value })}
        />
      </Field>
      <Field
        id={f("formerly")}
        label="Formerly"
        note="Its download history is shown joined to this one."
      >
        <input
          id={f("formerly")}
          aria-describedby={`${f("formerly")}-note`}
          className="field mono"
          value={d.formerly}
          placeholder="an earlier npm name"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setD({ ...d, formerly: e.target.value })}
        />
      </Field>
    </ConfigForm>
  );
}
