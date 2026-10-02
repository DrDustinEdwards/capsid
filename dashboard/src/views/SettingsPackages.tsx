import { useEffect, useId, useRef, useState } from "react";
import { useApp } from "../app/ctx";
import { ago, msSql, utc } from "../lib/format";
import type { OpsPackageConfig } from "../types";
import { Panel } from "capsomer/react/panel";
import {  } from "./shared";

// The package configuration (live.packages, the ops_packages table): one row per npm
// package the Packages view shows. Every change goes through the confirm dialog, which
// previews it first; the server validates every field.

interface Draft {
  name: string;
  repo: string;
  formerly: string;
}

type Editing = { kind: "add" } | { kind: "edit"; row: OpsPackageConfig };

function paramsOf(d: Draft): Record<string, string> {
  const p: Record<string, string> = {};
  for (const k of ["name", "repo", "formerly"] as const) {
    const v = d[k].trim();
    if (v) p[k] = v;
  }
  return p;
}

function PackageForm({ editing, onClose }: { editing: Editing; onClose: () => void }) {
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
      </form>
    </section>
  );
}

export function PackageSettings() {
  const { feed, now, confirm } = useApp();
  const [editing, setEditing] = useState<Editing | null>(null);
  const rows = feed.live.packages;
  const formKey = editing ? (editing.kind === "add" ? "add" : `edit:${editing.row.name}`) : "";
  return (
    <>
      <div className="toolbar">
        <button type="button" className="btn" onClick={() => setEditing({ kind: "add" })} disabled={editing?.kind === "add"}>
          Add package
        </button>
      </div>
      {editing && <PackageForm key={formKey} editing={editing} onClose={() => setEditing(null)} />}
      <Panel flush title="Packages" count={rows.length} src="D1 ops_packages">
        {rows.length ? (
          <div className="scroll-x">
            <table className="list">
              <thead>
                <tr>
                  <th>npm name</th>
                  <th>Repository</th>
                  <th>Formerly</th>
                  <th>Revision</th>
                  <th>
                    <span className="sr-only">Controls</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const at = msSql(p.updated_at);
                  return (
                    <tr key={p.name} data-row="" data-package={p.name}>
                      <td className="mono">{p.name}</td>
                      <td className="mono">{p.repo ?? <span className="faint">none</span>}</td>
                      <td className="mono">{p.formerly ?? <span className="faint">none</span>}</td>
                      <td>
                        <span className="num">{p.revision}</span>
                        <div className="src" title={Number.isNaN(at) ? p.updated_at : utc(at)}>
                          {Number.isNaN(at) ? `updated ${p.updated_at}` : `updated ${ago(at, now)}`}
                        </div>
                      </td>
                      <td className="ctl">
                        <div className="toolbar nowrap">
                          <button type="button" className="btn" aria-label={`Edit ${p.name}`} onClick={() => setEditing({ kind: "edit", row: p })}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn"
                            aria-label={`Remove ${p.name}`}
                            onClick={() => confirm({ action: "package_remove", params: { name: p.name, revision: String(p.revision) }, title: `Remove ${p.name}` })}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="body faint">No package is configured, so the Portal shows no Packages view. Add one to start.</div>
        )}
      </Panel>
    </>
  );
}
