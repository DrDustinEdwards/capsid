import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useApp } from "../app/ctx";
import { hasSites } from "../lib/derive";
import { ago, msSql, utc } from "../lib/format";
import { St } from "../ui/icons";
import type { OpsSiteConfig } from "../types";
import { PageHead, Panel } from "./shared";
import { PackageSettings } from "./SettingsPackages";

// The site configuration (live.sites, the ops_sites table): one row per namespace. A row
// with an origin is a site the watcher probes; a row with no origin records that the
// namespace serves no site. Every change goes through the confirm dialog, which previews
// it first. The server validates every field; the form only catches the one mistake it
// can name before sending (an origin left blank on a site).

type Platform = "cloudflare" | "vercel";

interface Draft {
  namespace: string;
  name: string;
  noSite: boolean;
  origin: string;
  health_path: string;
  platform: Platform;
  script: string;
}

const BLANK: Draft = { namespace: "", name: "", noSite: false, origin: "", health_path: "", platform: "cloudflare", script: "" };

function draftOf(s: OpsSiteConfig): Draft {
  return {
    namespace: s.namespace,
    name: s.name,
    noSite: s.origin === null,
    origin: s.origin ?? "",
    health_path: s.health_path ?? "",
    platform: s.platform ?? "cloudflare",
    script: s.script ?? "",
  };
}

// The params the server takes. A blank field is left out: the server reads an absent
// field as none, and a row that serves no site takes no origin, health path, platform
// or script.
function paramsOf(d: Draft): Record<string, string> {
  const p: Record<string, string> = {};
  const put = (k: string, v: string) => {
    const t = v.trim();
    if (t) p[k] = t;
  };
  put("namespace", d.namespace);
  put("name", d.name);
  if (!d.noSite) {
    put("origin", d.origin);
    put("health_path", d.health_path);
    p.platform = d.platform;
    if (d.platform === "cloudflare") put("script", d.script);
  }
  return p;
}

function Field({ id, label, note, children }: { id: string; label: string; note?: string; children: ReactNode }) {
  return (
    <div className="f">
      <label htmlFor={id} className="section-title">
        {label}
      </label>
      {children}
      {note && (
        <span id={`${id}-note`} className="faint note">
          {note}
        </span>
      )}
    </div>
  );
}

type Editing = { kind: "add" } | { kind: "edit"; row: OpsSiteConfig };

function SiteForm({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const { feed, confirm } = useApp();
  const id = useId();
  const box = useRef<HTMLElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const [d, setD] = useState<Draft>(editing.kind === "edit" ? draftOf(editing.row) : BLANK);
  const [hint, setHint] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => (setD((x) => ({ ...x, ...patch })), setHint(null));
  const adding = editing.kind === "add";

  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest" });
    first.current?.focus();
  }, []);

  // Namespaces on the roster with no row yet, offered as suggestions when adding.
  const taken = new Set(feed.live.sites.map((s) => s.namespace));
  const free = feed.live.namespaces.map((n) => n.name).filter((n) => !taken.has(n));

  const submit = () => {
    if (!d.namespace.trim()) return setHint("Type the namespace this row is for.");
    if (!d.noSite && !d.origin.trim()) return setHint("Give the site's origin, such as https://example.com, or tick \"Serves no site\".");
    setHint(null);
    const params = paramsOf(d);
    const ns = params.namespace ?? d.namespace;
    if (editing.kind === "add") return confirm({ action: "site_add", params, title: `Add ${ns}`, onDone: onClose });
    confirm({ action: "site_edit", params: { ...params, namespace: editing.row.namespace, revision: String(editing.row.revision) }, title: `Change ${editing.row.namespace}`, onDone: onClose });
  };

  const f = (k: string) => `${id}-${k}`;
  return (
    <section className="panel" ref={box} aria-labelledby={f("h")}>
      <header>
        <h2 id={f("h")}>{adding ? "Add a site" : `Edit ${editing.row.namespace}`}</h2>
        {!adding && <span className="src">revision {editing.row.revision}</span>}
      </header>
      <form
        className="siteform"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field id={f("ns")} label="Namespace" note="A registered namespace. One row each.">
          {adding ? (
            <>
              <input ref={first} id={f("ns")} aria-describedby={`${f("ns")}-note`} className="field mono" list={f("nslist")} value={d.namespace} autoComplete="off" spellCheck={false} onChange={(e) => set({ namespace: e.target.value })} />
              <datalist id={f("nslist")}>
                {free.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </>
          ) : (
            <input id={f("ns")} aria-describedby={`${f("ns")}-note`} className="field mono" value={d.namespace} readOnly />
          )}
        </Field>
        <Field id={f("name")} label="Name" note="Shown in the Portal. Blank uses the namespace.">
          <input ref={adding ? undefined : first} id={f("name")} aria-describedby={`${f("name")}-note`} className="field" value={d.name} autoComplete="off" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={d.noSite} onChange={(e) => set({ noSite: e.target.checked })} /> Serves no site. The watcher probes nothing for this namespace.
        </label>
        <Field id={f("origin")} label="Origin" note="https:// and a hostname only.">
          <input id={f("origin")} aria-describedby={`${f("origin")}-note`} className="field mono" value={d.noSite ? "" : d.origin} disabled={d.noSite} placeholder="https://example.com" autoComplete="off" spellCheck={false} onChange={(e) => set({ origin: e.target.value })} />
        </Field>
        <Field id={f("health")} label="Health path" note="Starts with /. Blank probes the root, which shows liveness only.">
          <input id={f("health")} aria-describedby={`${f("health")}-note`} className="field mono" value={d.noSite ? "" : d.health_path} disabled={d.noSite} placeholder="/health" autoComplete="off" spellCheck={false} onChange={(e) => set({ health_path: e.target.value })} />
        </Field>
        <Field id={f("platform")} label="Platform">
          <select id={f("platform")} className="field" value={d.platform} disabled={d.noSite} onChange={(e) => set({ platform: e.target.value as Platform })}>
            <option value="cloudflare">Cloudflare</option>
            <option value="vercel">Vercel</option>
          </select>
        </Field>
        <Field id={f("script")} label="Worker script" note="Cloudflare only. Blank finds it from the account's custom domains.">
          <input id={f("script")} aria-describedby={`${f("script")}-note`} className="field mono" value={d.noSite || d.platform !== "cloudflare" ? "" : d.script} disabled={d.noSite || d.platform !== "cloudflare"} autoComplete="off" spellCheck={false} onChange={(e) => set({ script: e.target.value })} />
        </Field>
        {hint && (
          <div className="callout warn full" role="alert">
            {hint}
          </div>
        )}
        <div className="toolbar full">
          <button type="submit" className="btn primary">
            Preview
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

function Row({ s, onEdit }: { s: OpsSiteConfig; onEdit: () => void }) {
  const { now, confirm } = useApp();
  const at = msSql(s.updated_at);
  const none = <span className="faint">none</span>;
  return (
    <tr data-row="">
      <td>
        <b className="mono">{s.namespace}</b>
      </td>
      <td data-label="Name">{s.name}</td>
      <td data-label="Origin">
        {s.origin === null ? (
          <St kind="nodata">Serves no site</St>
        ) : (
          <>
            <span className="mono">{s.origin}</span>
            {s.self_probe && <div className="src">probed in-process</div>}
          </>
        )}
      </td>
      <td data-label="Health path" className="mono">
        {s.origin === null ? none : s.health_path ?? <span className="faint">none, root probed</span>}
      </td>
      <td data-label="Platform">{s.platform === "vercel" ? "Vercel" : s.platform === "cloudflare" ? "Cloudflare" : none}</td>
      <td data-label="Worker script" className="mono">
        {s.script ?? none}
      </td>
      <td data-label="Revision">
        <span className="num">{s.revision}</span>
        <div className="src" title={Number.isNaN(at) ? s.updated_at : utc(at)}>
          {Number.isNaN(at) ? `updated ${s.updated_at}` : `updated ${ago(at, now)}`}
        </div>
      </td>
      <td className="ctl">
        <div className="toolbar nowrap">
          <button type="button" className="btn" aria-label={`Edit ${s.namespace}`} onClick={onEdit}>
            Edit
          </button>
          <button
            type="button"
            className="btn"
            aria-label={`Remove ${s.namespace}`}
            onClick={() => confirm({ action: "site_remove", params: { namespace: s.namespace, revision: String(s.revision) }, title: `Remove ${s.namespace}` })}
          >
            Remove
          </button>
        </div>
      </td>
    </tr>
  );
}

export function Settings() {
  const { feed } = useApp();
  const [editing, setEditing] = useState<Editing | null>(null);
  const rows = feed.live.sites;
  // The form is keyed on what it edits, so switching rows starts a fresh draft.
  const formKey = editing ? (editing.kind === "add" ? "add" : `edit:${editing.row.namespace}`) : "";
  return (
    <div className="page">
      <PageHead title="Settings">The sites the watcher probes, one row per namespace, and the npm packages it reads. A row with no origin records that a namespace serves no site. Every change shows a preview before anything is written.</PageHead>
      {!hasSites(feed) && (
        <div className="callout" role="status">
          No site is configured, so the watcher probes nothing and the Portal shows no Sites view. Add a site to start.
        </div>
      )}
      <div className="toolbar">
        <button type="button" className="btn primary" onClick={() => setEditing({ kind: "add" })} disabled={editing?.kind === "add"}>
          Add site
        </button>
      </div>
      {editing && <SiteForm key={formKey} editing={editing} onClose={() => setEditing(null)} />}
      <Panel title="Sites" count={rows.length} src="D1 ops_sites">
        {rows.length ? (
          <div className="scroll-x reflow">
            <table className="list cards-below-1320">
              <thead>
                <tr>
                  <th>Namespace</th>
                  <th>Name</th>
                  <th>Origin</th>
                  <th>Health path</th>
                  <th>Platform</th>
                  <th>Worker script</th>
                  <th>Revision</th>
                  <th>
                    <span className="sr-only">Controls</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <Row key={s.namespace} s={s} onEdit={() => setEditing({ kind: "edit", row: s })} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="body faint">No rows. Add a site, or record that a namespace serves none.</div>
        )}
      </Panel>
      <PackageSettings />
    </div>
  );
}
