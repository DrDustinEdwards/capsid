import { Empty, Spinner } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { useApp } from "../app/ctx";
import { fetchResources, useAnswer } from "../lib/api";
import { ago, ms } from "../lib/format";
import type { ResourcesDoc } from "../types";
import { St } from "../ui/icons";

// WORKERS: the secrets and data model (src/system-resources.ts), as the nightly build read it
// from Cloudflare. One panel per Worker with its system, its secret and variable names (never
// a value) and what it binds; then every D1 database with its tables, every KV namespace and
// R2 bucket, and who uses each, so a cleanup can see what is safe to remove. Private: behind
// the Portal's sign-in only. Nothing here changes anything.

type Worker = ResourcesDoc["workers"][number];
type User = ResourcesDoc["databases"][number]["used_by"][number];

const names = (list: string[]) => (list.length ? <span className="mono">{list.join(", ")}</span> : <span className="faint">none</span>);
const pairs = (list: Array<{ binding: string; to: string }>) =>
  list.length ? (
    <span className="mono">{list.map((p) => `${p.binding} → ${p.to}`).join(", ")}</span>
  ) : (
    <span className="faint">none</span>
  );

function WorkerPanel({ w }: { w: Worker }) {
  const rows: Array<[string, React.ReactNode, number]> = [
    ["Secrets", names(w.secrets), w.secrets.length],
    ["Variables", names(w.vars), w.vars.length],
    ["D1", pairs(w.d1.map((d) => ({ binding: d.binding, to: d.database }))), w.d1.length],
    ["KV", pairs(w.kv.map((k) => ({ binding: k.binding, to: k.namespace }))), w.kv.length],
    ["R2", pairs(w.r2.map((r) => ({ binding: r.binding, to: r.bucket }))), w.r2.length],
    ["Durable Objects", pairs(w.durable_objects.map((d) => ({ binding: d.binding, to: d.script ? `${d.class} in ${d.script}` : d.class }))), w.durable_objects.length],
    ["Queues", pairs(w.queues.map((q) => ({ binding: q.binding, to: q.queue }))), w.queues.length],
    ["Services", pairs(w.services.map((s) => ({ binding: s.binding, to: s.service }))), w.services.length],
    ["Other", pairs(w.other.map((o) => ({ binding: o.binding, to: o.kind }))), w.other.length],
    ["Previews", pairs(w.previews.map((p) => ({ binding: p.binding, to: p.store }))), w.previews.length],
  ];
  const shown = rows.filter(([label, , n]) => n > 0 || label === "Secrets");
  return (
    <Panel
      flush
      title={w.script}
      id={`worker-${w.script}`}
      section={w.script}
      src={w.system ? <>system <span className="mono">{w.system}</span></> : <St kind="warn">No system lists it</St>}
      footer={<span className="faint">{`${w.secrets.length} ${w.secrets.length === 1 ? "secret" : "secrets"} · ${w.d1.length + w.kv.length + w.r2.length} ${w.d1.length + w.kv.length + w.r2.length === 1 ? "store" : "stores"}`}</span>}
    >
      {w.error ? (
        <p className="shared-none">
          <St kind="nodata">Could not read: {w.error}</St>
        </p>
      ) : (
        <table className="brief workers-bindings">
          <caption className="sr-only">What {w.script} binds</caption>
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
    <span>{[...new Set(users.map((u) => (u.system ? `${u.system} (${u.script})` : u.script)))].join(", ")}</span>
  ) : (
    <St kind="warn">Bound by no Worker</St>
  );

function StoresPanel({ doc }: { doc: ResourcesDoc }) {
  const unbound = [...doc.databases, ...doc.kv_namespaces, ...doc.buckets].filter((s) => s.used_by.length === 0).length;
  return (
    <Panel
      flush
      title="Stores"
      id="worker-stores"
      section="Stores"
      src={<>{`${doc.databases.length} D1 · ${doc.kv_namespaces.length} KV · ${doc.buckets.length} R2`}</>}
      footer={<span className="faint">{unbound ? `${unbound} bound by no Worker` : "Every store is bound"}</span>}
    >
      <table className="brief workers-stores">
        <caption className="sr-only">Every D1 database, KV namespace and R2 bucket, and who uses it</caption>
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
                <span className="mono">{d.name}</span>
                {d.tables ? (
                  <details>
                    <summary className="faint">{`${d.tables.length} ${d.tables.length === 1 ? "table" : "tables"}`}</summary>
                    <span className="mono">{d.tables.join(", ")}</span>
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
                <span className="mono">{k.title}</span>
              </td>
              <td>KV</td>
              <td>{usedBy(k.used_by)}</td>
            </tr>
          ))}
          {doc.buckets.map((b) => (
            <tr key={`r2-${b.name}`}>
              <td>
                <span className="mono">{b.name}</span>
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

export function Workers() {
  const { now } = useApp();
  const load = useAnswer<ResourcesDoc>(["resources"], fetchResources);
  const doc = load.data;
  return (
    <div className="embedded">
      {load.loading ? (
        <div className="loading">
          <Spinner label="Reading the Workers" />
        </div>
      ) : load.error ? (
        <p role="alert">
          <St kind="crit">Could not read the Workers: {load.error}</St>
        </p>
      ) : !doc || !doc.read_at ? (
        <Empty kind="nothing-yet" title="The Workers have not been read yet.">
          {doc?.problems[0] ?? "The nightly build reads every Worker from Cloudflare after 06:00 UTC."}
        </Empty>
      ) : (
        <>
          {doc.problems.map((p) => (
            <p key={p} className="shared-none">
              <St kind="nodata">{p}</St>
            </p>
          ))}
          {doc.workers.map((w) => (
            <WorkerPanel key={w.script} w={w} />
          ))}
          <StoresPanel doc={doc} />
          <p className="faint shared-read">
            {`Read from Cloudflare ${ago(ms(doc.read_at), now)}, nightly. Names only: no secret or variable value is ever read.`}
          </p>
        </>
      )}
    </div>
  );
}
