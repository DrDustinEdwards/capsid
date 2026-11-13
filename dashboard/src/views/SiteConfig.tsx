import { useState } from "react";
import { useApp } from "../app/ctx";
import type { OpsSiteConfig } from "../types";
import { ConfigForm, useConfigForm, type Editing } from "capsomer/react/config-form";
import "capsomer/config-form.css";
import "capsomer/field.css";
import { Field } from "capsomer/react/field";
import { DangerZone } from "capsomer/react/danger-zone";
import "capsomer/danger-zone.css";
import "capsomer/select.css";
import "./config-form.css";

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

const BLANK: Draft = {
  namespace: "",
  name: "",
  noSite: false,
  origin: "",
  health_path: "",
  platform: "cloudflare",
  script: "",
};

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

export function SiteForm({
  editing,
  onClose,
}: {
  editing: Editing<OpsSiteConfig>;
  onClose: () => void;
}) {
  const { feed, confirm } = useApp();
  const { f, first } = useConfigForm();
  const [d, setD] = useState<Draft>(editing.kind === "edit" ? draftOf(editing.row) : BLANK);
  const [hint, setHint] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => (setD((x) => ({ ...x, ...patch })), setHint(null));
  const adding = editing.kind === "add";

  // Namespaces on the roster with no row yet, offered as suggestions when adding.
  const taken = new Set(feed.live.sites.map((s) => s.namespace));
  const free = feed.live.namespaces.map((n) => n.name).filter((n) => !taken.has(n));

  const submit = () => {
    if (!d.namespace.trim()) return setHint("Type the namespace this row is for.");
    if (!d.noSite && !d.origin.trim())
      return setHint(
        'Give the site\'s origin, such as https://example.com, or tick "Serves no site".',
      );
    setHint(null);
    const params = paramsOf(d);
    const ns = params.namespace ?? d.namespace;
    if (editing.kind === "add")
      return confirm({
        action: "site_add",
        params,
        title: `Add ${ns}`,
        onDone: onClose,
      });
    confirm({
      action: "site_edit",
      params: {
        ...params,
        namespace: editing.row.namespace,
        revision: String(editing.row.revision),
      },
      title: `Change ${editing.row.namespace}`,
      onDone: onClose,
    });
  };

  return (
    <ConfigForm
      f={f}
      first={first}
      title={adding ? "Add a site" : `Edit ${editing.row.namespace}`}
      src={adding ? undefined : `revision ${editing.row.revision}`}
      hint={hint}
      onSubmit={submit}
      onClose={onClose}
      danger={
        !adding && (
          <DangerZone note="The watcher stops probing it. Its history stays.">
            <button
              type="button"
              className="cap-btn"
              data-variant="danger"
              aria-label={`Remove ${editing.row.namespace}`}
              onClick={() =>
                confirm({
                  action: "site_remove",
                  params: {
                    namespace: editing.row.namespace,
                    revision: String(editing.row.revision),
                  },
                  title: `Remove ${editing.row.namespace}`,
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
      <Field label="Project" help="A registered project (its namespace). One row each.">
        {(control) =>
          adding ? (
            <>
              <input
                ref={first}
                {...control}
                className="cap-input cap-mono"
                list={f("nslist")}
                value={d.namespace}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => set({ namespace: e.target.value })}
              />
              <datalist id={f("nslist")}>
                {free.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </>
          ) : (
            <input {...control} className="cap-input cap-mono" value={d.namespace} readOnly />
          )
        }
      </Field>
      <Field label="Name" help="Shown in the Portal. Blank uses the namespace.">
        <input
          ref={adding ? undefined : first}
          id={f("name")}
          className="cap-input"
          value={d.name}
          autoComplete="off"
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={d.noSite}
          onChange={(e) => set({ noSite: e.target.checked })}
        />{" "}
        Serves no site. The watcher probes nothing for this namespace.
      </label>
      <Field label="Origin" help="https:// and a hostname only.">
        <input
          id={f("origin")}
          className="cap-input cap-mono"
          value={d.noSite ? "" : d.origin}
          disabled={d.noSite}
          placeholder="https://example.com"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => set({ origin: e.target.value })}
        />
      </Field>
      <Field
        label="Health path"
        help="Starts with /. Blank probes the root, which shows liveness only."
      >
        <input
          id={f("health")}
          className="cap-input cap-mono"
          value={d.noSite ? "" : d.health_path}
          disabled={d.noSite}
          placeholder="/health"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => set({ health_path: e.target.value })}
        />
      </Field>
      <Field label="Platform">
        {(control) => (
          <div className="cap-select-wrap">
            <select
              {...control}
              className="cap-select"
              value={d.platform}
              disabled={d.noSite}
              onChange={(e) => set({ platform: e.target.value as Platform })}
            >
              <option value="cloudflare">Cloudflare</option>
              <option value="vercel">Vercel</option>
            </select>
          </div>
        )}
      </Field>
      <Field
        label="Worker script"
        help="Cloudflare only. Blank finds it from the account's custom domains."
      >
        <input
          id={f("script")}
          className="cap-input cap-mono"
          value={d.noSite || d.platform !== "cloudflare" ? "" : d.script}
          disabled={d.noSite || d.platform !== "cloudflare"}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => set({ script: e.target.value })}
        />
      </Field>
    </ConfigForm>
  );
}
