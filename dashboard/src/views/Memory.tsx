import { parseDocParam } from "../lib/keys";
import { useState, type FormEvent } from "react";
import { FilterBar, withParams } from "capsomer/react/filter-bar";
import { Empty } from "capsomer/react/empty";
import { Spinner } from "capsomer/react/skeleton";
import { Panel } from "capsomer/react/panel";
import { Snippet } from "capsomer/react/search-results";
import "capsomer/search-results.css";
import "capsomer/filter-bar.css";
import "./Memory.css";
import { Link, useLocation, useSearchString } from "../lib/router";
import { MEMORY_TABS, routePath, tabOf, useApp, type MemoryTab } from "../app/ctx";
import { fetchLibrary } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import type { LibraryEntry, LibraryHandoff, LibraryShelf, PortalLibrary } from "../types";
import { useFigures } from "../lib/trends";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { ChartSlot } from "../ui/ChartSlot";
import { boardChart } from "./charts";
import { memoryDocHref } from "./memory-links";
import { Status } from "capsomer/react/status";
import { PageHead } from "./shared";

const SHELVES: Array<{ id: LibraryShelf; title: string; none: string }> = [
  { id: "decisions", title: "Decisions", none: "No decision record yet." },
  { id: "rulings", title: "Rulings", none: "No ruling yet." },
  { id: "research", title: "Research", none: "No research yet." },
];

const plainSnippet = (text: string) =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\n)\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(\*\*|__|\*|`)/g, "");

const WritesFigure = boardChart("ServerFigure");
const HandoffWeeksChart = boardChart("HandoffWeeksChart");

export function Memory() {
  const { now } = useApp();
  const search = useSearchString();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const q = params.get("q")?.trim() || "";
  const doc = parseDocParam(params.get("doc"));
  const docNs = doc?.ns ?? null;
  const docPath = doc?.path ?? null;
  const tabParam = useTabParam();
  const tab: MemoryTab = q ? "search" : (tabOf(MEMORY_TABS, tabParam) ?? MEMORY_TABS[0].id);
  const load = useAnswer<PortalLibrary>(["library", docNs, docPath, q], () =>
    fetchLibrary(
      docNs !== null && docPath !== null ? { ns: docNs, path: docPath } : q ? { q } : null,
    ),
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const next = String(new FormData(e.currentTarget).get("q") ?? "");
    navigate(withParams(routePath("memory"), { tab: "search", q: next }));
  };
  const data = load.data;
  const shelf = SHELVES.find((s) => s.id === tab);
  return (
    <div className="cap-admin-page">
      <PageHead title="Memory" />
      {!doc && <PageTabs label="Memory" path="/memory" tabs={MEMORY_TABS} current={tab} />}
      {tab === "search" && !doc && (
        // The address changed (back, a link): the field follows it, so the bar starts over.
        <FilterBar
          key={q}
          label="Search memory"
          onSubmit={submit}
          applyLabel="Search"
          clearLabel="Clear"
          clearHref={q ? `${routePath("memory")}?tab=search` : null}
          renderLink={(props) => <Link {...props} />}
        >
          <input
            className="search"
            type="search"
            name="q"
            aria-label="Search memory"
            defaultValue={q}
          />
        </FilterBar>
      )}
      {load.loading ? (
        <Spinner layout="page" label="Reading memory" />
      ) : load.error ? (
        <p role="alert">
          <Status tone="crit">Could not read memory: {load.error}</Status>
        </p>
      ) : !data ? null : data.kind === "document" ? (
        <DocumentView data={data} now={now} />
      ) : data.kind === "search" ? (
        <Results data={data} now={now} />
      ) : tab === "search" ? null : shelf ? (
        <>
          <Shelf title={shelf.title} none={shelf.none} rows={data.shelves[shelf.id]} now={now} />
          {data.truncated && (
            <p className="cap-text shared-read" data-tone="dim">
              The shelves show the first 500 documents; search for the rest.
            </p>
          )}
        </>
      ) : (
        <>
          <Handoffs rows={data.handoffs} truncated={data.handoffs_truncated} now={now} />
          <MemoryCharts />
        </>
      )}
    </div>
  );
}

function MemoryCharts() {
  const figs = useFigures("memory");
  const d = figs.data;
  if (!d)
    return figs.error ? (
      <p className="cap-text" data-tone="dim">
        The charts could not be read: {figs.error}
      </p>
    ) : null;
  return (
    <div className="cap-stack" data-gap="5">
      <ChartSlot>
        {d.handoff_weeks && <HandoffWeeksChart weeks={d.handoff_weeks} />}
        {d.figures.writes ? (
          <WritesFigure html={d.figures.writes} narrow={d.figures.writes_recent} />
        ) : (
          <p className="cap-text">{d.empty.writes ?? "No writes."}</p>
        )}
      </ChartSlot>
    </div>
  );
}

function Handoffs({
  rows,
  truncated,
  now,
}: {
  rows: LibraryHandoff[];
  truncated: boolean;
  now: number;
}) {
  const [filter, setFilter] = useState("");
  const f = filter.trim().toLowerCase();
  const shown = f
    ? rows.filter((r) => `${r.title ?? ""} ${r.namespace}/${r.path}`.toLowerCase().includes(f))
    : rows;
  const open = rows.filter((r) => r.open).length;
  return (
    <Panel
      flush
      title="Handoffs"
      id="memory-handoffs"
      count={rows.length}
      footer={
        <span className="cap-text" data-tone="dim">
          {open} open{truncated ? `; the newest ${rows.length} are listed` : ""}
        </span>
      }
    >
      <div className="body">
        <label className="cap-sr-only" htmlFor="handoff-filter">
          Filter handoffs
        </label>
        <input
          id="handoff-filter"
          className="search"
          type="search"
          placeholder="Filter handoffs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {shown.length ? (
        <table className="cap-table lib-table">
          <caption className="cap-sr-only">Handoffs, open first</caption>
          <thead>
            <tr>
              <th>Title</th>
              <th className="c-where">Where</th>
              <th>State</th>
              <th className="c-when">Updated</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.namespace}/${r.path}`}>
                <td>
                  <Link href={memoryDocHref(r.namespace, r.path)}>{r.title || r.path}</Link>
                </td>
                <td className="c-where">
                  <span className="cap-mono">
                    {r.namespace}/{r.path}
                  </span>
                </td>
                <td>
                  {r.open ? <Status tone="info">open</Status> : <Status tone="muted">older</Status>}
                </td>
                <td className="c-when">{ago(parse(r.updated_at), now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="cap-text shared-none" data-tone="dim">
          {f ? "No handoff matches." : "No handoff yet."}
        </p>
      )}
    </Panel>
  );
}

function EntryRow({ row, now }: { row: LibraryEntry; now: number }) {
  return (
    <tr>
      <td>
        <Link href={memoryDocHref(row.namespace, row.path)}>{row.title || row.path}</Link>
      </td>
      <td className="c-where">
        <span className="cap-mono">
          {row.namespace}/{row.path}
        </span>
      </td>
      <td className="c-when">{ago(parse(row.updated_at), now)}</td>
    </tr>
  );
}

function Shelf({
  title,
  none,
  rows,
  now,
}: {
  title: string;
  none: string;
  rows: LibraryEntry[];
  now: number;
}) {
  const id = `memory-${title.toLowerCase()}`;
  return (
    <Panel
      flush
      title={title}
      id={id}
      section={title}
      footer={
        <span className="cap-text" data-tone="dim">
          {rows.length} {rows.length === 1 ? "document" : "documents"}
        </span>
      }
    >
      {rows.length ? (
        <table className="cap-table lib-table">
          <caption className="cap-sr-only">{title}</caption>
          <thead>
            <tr>
              <th>Title</th>
              <th className="c-where">Where</th>
              <th className="c-when">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <EntryRow key={`${r.namespace}/${r.path}`} row={r} now={now} />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="cap-text shared-none" data-tone="dim">
          {none}
        </p>
      )}
    </Panel>
  );
}

function Results({ data, now }: { data: Extract<PortalLibrary, { kind: "search" }>; now: number }) {
  if (!data.rows.length)
    return <Empty kind="no-match" title={`Nothing matches "${data.query}".`} />;
  return (
    <Panel
      flush
      title="Results"
      id="memory-results"
      section="Results"
      footer={
        <span className="cap-text" data-tone="dim">
          {data.truncated
            ? `The best ${data.rows.length}; narrow the search for the rest.`
            : `${data.rows.length} ${data.rows.length === 1 ? "match" : "matches"}`}
        </span>
      }
    >
      <ol className="lib-results">
        {data.rows.map((r) => (
          <li key={`${r.namespace}/${r.path}`}>
            <Link href={memoryDocHref(r.namespace, r.path)}>
              <b>{r.title || r.path}</b>
            </Link>{" "}
            <span className="cap-text cap-mono" data-tone="dim">
              {r.namespace}/{r.path}
            </span>{" "}
            <span className="cap-text" data-tone="dim">
              · {r.type} · {ago(parse(r.updated_at), now)}
            </span>
            <div className="cap-search-snippet">
              <Snippet text={plainSnippet(r.snippet)} />
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function DocumentView({
  data,
  now,
}: {
  data: Extract<PortalLibrary, { kind: "document" }>;
  now: number;
}) {
  const d = data.doc;
  const edges = [
    ...data.outgoing.map((e) => ({
      dir: "to",
      type: e.type,
      ns: e.to_ns,
      path: e.to_path,
    })),
    ...data.incoming.map((e) => ({
      dir: "from",
      type: e.type,
      ns: e.from_ns,
      path: e.from_path,
    })),
  ];
  return (
    <Panel
      flush
      title={d.title || d.path}
      id="memory-document"
      section="Document"
      src={
        <>
          <span className="cap-mono">
            {d.namespace}/{d.path}
          </span>
          {" · "}
          {d.type} · {d.status} · updated {ago(parse(d.updated_at), now)}
        </>
      }
    >
      <div className="lib-body">{d.body}</div>
      {edges.length > 0 && (
        <ul className="shared-local lib-edges" aria-label="Linked documents">
          {edges.map((e) => (
            <li key={`${e.dir}|${e.type}|${e.ns}/${e.path}`}>
              <span className="cap-text" data-tone="dim">
                {e.type} {e.dir}
              </span>{" "}
              <Link href={memoryDocHref(e.ns, e.path)}>
                <span className="cap-mono">
                  {e.ns}/{e.path}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
