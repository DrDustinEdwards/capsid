import { Empty, Missing, Spinner } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { useApp } from "../app/ctx";
import { fetchResources } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import type { ResourcesDoc } from "../types";
import { St } from "../ui/icons";

// WORKERS: the secrets and data model (src/system-resources.ts), as the nightly build read it
// from Cloudflare. One panel per Worker with its system, its secret and variable names (never
// a value) and what it binds: a site's own Workers on its Setup tab, the rest on Health's
// Cloudflare tab with every D1 database, KV namespace and R2 bucket and who uses each, so a
// cleanup can see what is safe to remove. Private: behind the Portal's sign-in only. Nothing
// here changes anything.

type Worker = ResourcesDoc["workers"][number];
type User = ResourcesDoc["databases"][number]["used_by"][number];

const names = (list: string[]) =>
  list.length ? <span className="cap-mono">{list.join(", ")}</span> : <Missing />;
const pairs = (list: Array<{ binding: string; to: string }>) =>
  list.length ? (
    <span className="cap-mono">{list.map((p) => `${p.binding} → ${p.to}`).join(", ")}</span>
  ) : (
    <Missing />
  );

function WorkerPanel({ w }: { w: Worker }) {
  const rows: Array<[string, React.ReactNode, number]> = [
    ["Secrets", names(w.secrets), w.secrets.length],
    ["Variables", names(w.vars), w.vars.length],
    ["D1", pairs(w.d1.map((d) => ({ binding: d.binding, to: d.database }))), w.d1.length],
    ["KV", pairs(w.kv.map((k) => ({ binding: k.binding, to: k.namespace }))), w.kv.length],
    ["R2", pairs(w.r2.map((r) => ({ binding: r.binding, to: r.bucket }))), w.r2.length],
    [
      "Durable Objects",
      pairs(
        w.durable_objects.map((d) => ({
          binding: d.binding,
          to: d.script ? `${d.class} in ${d.script}` : d.class,
        })),
      ),
      w.durable_objects.length,
    ],
    ["Queues", pairs(w.queues.map((q) => ({ binding: q.binding, to: q.queue }))), w.queues.length],
    [
      "Services",
      pairs(w.services.map((s) => ({ binding: s.binding, to: s.service }))),
      w.services.length,
    ],
    ["Other", pairs(w.other.map((o) => ({ binding: o.binding, to: o.kind }))), w.other.length],
    [
      "Previews",
      pairs(w.previews.map((p) => ({ binding: p.binding, to: p.store }))),
      w.previews.length,
    ],
  ];
  const shown = rows.filter(([label, , n]) => n > 0 || label === "Secrets");
  return (
    <Panel
      flush
      title={w.script}
      id={`worker-${w.script}`}
      section={w.script}
      src={
        w.system ? (
          <>
            system <span className="cap-mono">{w.system}</span>
          </>
        ) : (
          <St kind="warn">No system lists it</St>
        )
      }
      footer={
        <span
          className="cap-text"
          data-tone="dim"
        >{`${w.secrets.length} ${w.secrets.length === 1 ? "secret" : "secrets"} · ${w.d1.length + w.kv.length + w.r2.length} ${w.d1.length + w.kv.length + w.r2.length === 1 ? "store" : "stores"}`}</span>
      }
    >
      {w.error ? (
        <p className="shared-none">
          <St kind="nodata">Could not read: {w.error}</St>
        </p>
      ) : (
        <table className="cap-table workers-bindings">
          <caption className="cap-sr-only">What {w.script} binds</caption>
          <colgroup>
            <col className="c-label" />
            <col />
          </colgroup>
          <tbody>
            {shown.map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

const usedBy = (users: User[]) =>
  users.length ? (
    <span>
      {[...new Set(users.map((u) => (u.system ? `${u.system} (${u.script})` : u.script)))].join(
        ", ",
      )}
    </span>
  ) : (
    <St kind="warn">Bound by no Worker</St>
  );

function StoresPanel({ doc }: { doc: ResourcesDoc }) {
  const unbound = [...doc.databases, ...doc.kv_namespaces, ...doc.buckets].filter(
    (s) => s.used_by.length === 0,
  ).length;
  return (
    <Panel
      flush
      title="Stores"
      id="worker-stores"
      section="Stores"
      src={
        <>{`${doc.databases.length} D1 · ${doc.kv_namespaces.length} KV · ${doc.buckets.length} R2`}</>
      }
      footer={
        <span className="cap-text" data-tone="dim">
          {unbound ? `${unbound} bound by no Worker` : "Every store is bound"}
        </span>
      }
    >
      <table className="cap-table workers-stores">
        <caption className="cap-sr-only">
          Every D1 database, KV namespace and R2 bucket, and who uses it
        </caption>
        <thead>
          <tr>
            <th>Store</th>
            <th className="c-kind">Kind</th>
            <th className="c-used">Used by</th>
          </tr>
        </thead>
        <tbody>
          {doc.databases.map((d) => (
            <tr key={`d1-${d.name}`}>
              <td>
                <span className="cap-mono">{d.name}</span>
                {d.tables ? (
                  <details>
                    <summary
                      className="cap-text"
                      data-tone="dim"
                    >{`${d.tables.length} ${d.tables.length === 1 ? "table" : "tables"}`}</summary>
                    <span className="cap-mono">{d.tables.join(", ")}</span>
                  </details>
                ) : (
                  <div>
                    <St kind="nodata">{d.tables_error ?? "Tables not read"}</St>
                  </div>
                )}
              </td>
              <td>D1</td>
              <td>{usedBy(d.used_by)}</td>
            </tr>
          ))}
          {doc.kv_namespaces.map((k) => (
            <tr key={`kv-${k.title}`}>
              <td>
                <span className="cap-mono">{k.title}</span>
              </td>
              <td>KV</td>
              <td>{usedBy(k.used_by)}</td>
            </tr>
          ))}
          {doc.buckets.map((b) => (
            <tr key={`r2-${b.name}`}>
              <td>
                <span className="cap-mono">{b.name}</span>
              </td>
              <td>R2</td>
              <td>{usedBy(b.used_by)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function useResources() {
  return useAnswer<ResourcesDoc>(["resources"], fetchResources);
}

// The read's state when it has no document to show yet, or null when it has one.
function NotRead({ load }: { load: ReturnType<typeof useResources> }) {
  const doc = load.data;
  if (load.loading && !doc) {
    return (
      <div className="loading">
        <Spinner label="Reading the Workers" />
      </div>
    );
  }
  if (load.error && !doc) {
    return (
      <p role="alert">
        <St kind="crit">Could not read the Workers: {load.error}</St>
      </p>
    );
  }
  if (!doc || !doc.read_at) {
    return (
      <Empty kind="nothing-yet" title="The Workers have not been read yet.">
        {doc?.problems[0] ??
          "The nightly build reads every Worker from Cloudflare after 06:00 UTC."}
      </Empty>
    );
  }
  return null;
}

function ReadNote({ doc }: { doc: ResourcesDoc }) {
  const { now } = useApp();
  return (
    <p
      className="cap-text shared-read"
      data-tone="dim"
    >{`Read from Cloudflare ${ago(parse(doc.read_at), now)}, nightly. Names only: no secret or variable value is ever read.`}</p>
  );
}

/** The Workers a site owns: its own script, and every Worker its system lists beside it
 *  (system/model.json), such as a site's desk. */
function ownedScripts(doc: ResourcesDoc, scripts: ReadonlyArray<string>): string[] {
  const systems = new Set(
    doc.workers.filter((w) => scripts.includes(w.script) && w.system).map((w) => w.system),
  );
  return doc.workers
    .filter((w) => scripts.includes(w.script) || (w.system !== null && systems.has(w.system)))
    .map((w) => w.script);
}

/** A site's Setup tab: what each of its Workers binds, and its secret and variable names. */
export function SiteWorkers({ scripts }: { scripts: ReadonlyArray<string> }) {
  const load = useResources();
  const doc = load.data;
  const waiting = <NotRead load={load} />;
  if (!doc || !doc.read_at) return waiting;
  const owned = new Set(ownedScripts(doc, scripts));
  const workers = doc.workers.filter((w) => owned.has(w.script));
  return (
    <>
      {workers.length === 0 ? (
        <p className="shared-none">
          <St kind="nodata">
            {scripts.length
              ? `Cloudflare has no Worker named ${scripts.join(" or ")}.`
              : "No Worker script is known for this site: set one in its settings above."}
          </St>
        </p>
      ) : (
        workers.map((w) => <WorkerPanel key={w.script} w={w} />)
      )}
      <ReadNote doc={doc} />
    </>
  );
}

/** Health's Cloudflare tab: the Workers no site owns, then every store and who uses it. */
export function UnownedResources({ siteScripts }: { siteScripts: ReadonlyArray<string> }) {
  const load = useResources();
  const doc = load.data;
  if (!doc || !doc.read_at)
    return (
      <div className="cap-stack">
        <NotRead load={load} />
      </div>
    );
  const owned = new Set(ownedScripts(doc, siteScripts));
  const rest = doc.workers.filter((w) => !owned.has(w.script));
  return (
    <div className="cap-stack">
      {doc.problems.map((p) => (
        <p key={p} className="shared-none">
          <St kind="nodata">{p}</St>
        </p>
      ))}
      {rest.map((w) => (
        <WorkerPanel key={w.script} w={w} />
      ))}
      {rest.length === 0 && (
        <p className="cap-text" data-tone="dim">
          Every Worker belongs to a site; each is on its site's Setup tab.
        </p>
      )}
      <StoresPanel doc={doc} />
      <ReadNote doc={doc} />
    </div>
  );
}
