import { useEffect, useId, useRef, useState } from "react";
import { useApp } from "../app/ctx";
import type { OpsPackageConfig } from "../types";
import { Danger } from "./shared";

// The package configuration (live.packages, the ops_packages table): one row per npm
// package Packages' Published tab shows, added and changed there. Every change goes through the confirm dialog, which
// previews it first; the server validates every field.

interface Draft {
  name: string;
  repo: string;
  formerly: string;
}

export type PackageEditing = { kind: "add" } | { kind: "edit"; row: OpsPackageConfig };

function paramsOf(d: Draft): Record<string, string> {
  const p: Record<string, string> = {};
  for (const k of ["name", "repo", "formerly"] as const) {
    const v = d[k].trim();
    if (v) p[k] = v;
  }
  return p;
}

export function PackageForm({ editing, onClose }: { editing: PackageEditing; onClose: () => void }) {
  const { confirm } = useApp();
  const id = useId();
  const box = useRef<HTMLElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const adding = editing.kind === "add";
  const [d, setD] = useState<Draft>(adding ? { name: "", repo: "", formerly: "" } : { name: editing.row.name, repo: editing.row.repo ?? "", formerly: editing.row.formerly ?? "" });
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest" });
    first.current?.focus();
  }, []);
  const f = (k: string) => `${id}-${k}`;
  const submit = () => {
    if (!d.name.trim()) return setHint("Type the package's npm name.");
    setHint(null);
    if (editing.kind === "add") return confirm({ action: "package_add", params: paramsOf(d), title: `Add ${d.name.trim()}`, onDone: onClose });
    confirm({
      action: "package_edit",
      params: { ...paramsOf(d), name: editing.row.name, revision: String(editing.row.revision) },
      title: `Change ${editing.row.name}`,
      onDone: onClose,
    });
  };
  return (
    <section className="cap-panel" ref={box} aria-labelledby={f("h")}>
      <header className="cap-panel-head">
        <h2 id={f("h")}>{adding ? "Add a package" : `Edit ${editing.row.name}`}</h2>
        {!adding && <span className="cap-panel-src">revision {editing.row.revision}</span>}
      </header>
      <form
        className="siteform"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="f">
          <label htmlFor={f("name")} className="section-title">
            npm name
          </label>
          <input ref={first} id={f("name")} className="field mono" value={d.name} readOnly={!adding} autoComplete="off" spellCheck={false} onChange={(e) => setD({ ...d, name: e.target.value })} />
        </div>
        <div className="f">
          <label htmlFor={f("repo")} className="section-title">
            GitHub repository
          </label>
          <input id={f("repo")} className="field mono" value={d.repo} placeholder="owner/name" autoComplete="off" spellCheck={false} onChange={(e) => setD({ ...d, repo: e.target.value })} />
        </div>
        <div className="f">
          <label htmlFor={f("formerly")} className="section-title">
            Formerly
          </label>
          <input id={f("formerly")} className="field mono" value={d.formerly} placeholder="an earlier npm name" autoComplete="off" spellCheck={false} onChange={(e) => setD({ ...d, formerly: e.target.value })} />
          <span className="faint note">Its download history is shown joined to this one.</span>
        </div>
        <div className="full toolbar">
          <button type="submit" className="btn primary">
            {adding ? "Preview the add" : "Preview the change"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {hint && (
            <span className="note" role="alert">
              {hint}
            </span>
          )}
        </div>
        {!adding && (
          <Danger note="The Packages page stops showing it.">
            <button
              type="button"
              className="btn danger"
              aria-label={`Remove ${editing.row.name}`}
              onClick={() => confirm({ action: "package_remove", params: { name: editing.row.name, revision: String(editing.row.revision) }, title: `Remove ${editing.row.name}`, onDone: onClose })}
            >
              Remove
            </button>
          </Danger>
        )}
      </form>
    </section>
  );
}

