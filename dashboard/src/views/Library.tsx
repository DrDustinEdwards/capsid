import { parseDocParam } from "../lib/keys";
import { useState, type FormEvent, type ReactNode } from "react";
import { Empty, Spinner } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Link, useLocation, useSearch } from "../lib/router";
import { routePath, useApp } from "../app/ctx";
import { fetchLibrary, useAnswer } from "../lib/api";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import type { LibraryEntry, LibraryShelf, PortalLibrary } from "../types";
import { St } from "../ui/icons";
import { PageHead } from "./shared";

// LIBRARY (capsid/decisions.md 2026-10-09, Portal review item 4; experience review answer
// 11): the knowledge store, read-only. The shelves (decisions, rulings, research) when it
// opens, a search with ?q=, one document with ?doc=<namespace>/<path>. A job id in a
// document opens that job's drawer over the page. Nothing here writes: writing stays in
// chat and with drivers. Read from GET /portal/api/library.

const SHELVES: Array<{ id: LibraryShelf; title: string; none: string }> = [
  { id: "decisions", title: "Decisions", none: "No decision record yet." },
  { id: "rulings", title: "Rulings", none: "No ruling yet." },
  { id: "research", title: "Research", none: "No research yet." },
];

const JOB_ID = /\bjob_[0-9a-f]{12}\b/g;

/** The ?doc= value for a document: its namespace, a slash, its path. */
function docParam(ns: string, path: string): string {
  return `${ns}/${path}`;
}

/** A ?doc= value back to its namespace and path; null when it names neither. A namespace
 *  holds no slash, so the first one divides them. */

function docHref(ns: string, path: string): string {
  return `${routePath("library")}?${new URLSearchParams({ doc: docParam(ns, path) }).toString()}`;
}

/** Text with each job id made a link to that job's drawer over the Library. */
function withJobLinks(text: string, back: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(JOB_ID)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <Link
        key={`${at}-${m[0]}`}
        href={`${routePath("library", { type: "job", id: m[0] })}${back}`}
      >
        <span className="cap-mono">{m[0]}</span>
      </Link>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** FTS5's snippet, its matched words (between U+0002 and U+0003, which no document
 *  holds, so a bracket in the text is never taken for a match) in bold: no color needed,
 *  so it reads the same in both themes. */
function Snippet({ text }: { text: string }) {
  // oxlint-disable-next-line no-control-regex -- the delimiters are control characters on purpose
  const parts = text.split(/\u0002([^\u0003]*)\u0003/g);
  // split with one capture group: the odd entries are the matched words.
  return <>{parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : p))}</>;
}

export function Library() {
  const { now } = useApp();
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const q = params.get("q")?.trim() || "";
  const doc = parseDocParam(params.get("doc"));
  const [draft, setDraft] = useState(q);
  const docNs = doc?.ns ?? null;
  const docPath = doc?.path ?? null;
  // The address changed: the field follows it. Adjusted while rendering, not in an effect.
  const [seenQ, setSeenQ] = useState(q);
  if (seenQ !== q) {
    setSeenQ(q);
    setDraft(q);
  }
  const load = useAnswer<PortalLibrary>(["library", docNs, docPath, q], () =>
    fetchLibrary(
      docNs !== null && docPath !== null ? { ns: docNs, path: docPath } : q ? { q } : null,
    ),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = draft.trim();
    // The page itself, not location: a search made with a job's drawer open closes it.
    const page = routePath("library");
    navigate(next ? `${page}?${new URLSearchParams({ q: next }).toString()}` : page);
  };
  const data = load.data;
  return (
    <div className="cap-admin-page">
      <PageHead title="Library" />
      <form className="lib-search" role="search" onSubmit={submit}>
        <input
          className="search"
          type="search"
          name="q"
          placeholder="Search the knowledge store"
          aria-label="Search the knowledge store"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="cap-btn">
          Search
        </button>
        {(q || doc) && (
          <Link href={routePath("library")} className="cap-btn">
            All shelves
          </Link>
        )}
      </form>
      {load.loading ? (
        <div className="loading">
          <Spinner label="Reading the library" />
        </div>
      ) : load.error ? (
        <p role="alert">
          <St kind="crit">Could not read the library: {load.error}</St>
        </p>
      ) : !data ? null : data.kind === "document" ? (
        <DocumentView data={data} back={search ? `?${search}` : ""} now={now} />
      ) : data.kind === "search" ? (
        <Results data={data} now={now} />
      ) : (
        <>
          {SHELVES.map((s) => (
            <Shelf key={s.id} title={s.title} none={s.none} rows={data.shelves[s.id]} now={now} />
          ))}
          {data.truncated && (
            <p className="cap-text shared-read" data-tone="dim">
              The shelves show the first 500 documents; search for the rest.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function EntryRow({ row, now }: { row: LibraryEntry; now: number }) {
  return (
    <tr>
      <td>
        <Link href={docHref(row.namespace, row.path)}>{row.title || row.path}</Link>
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
  const id = `library-${title.toLowerCase()}`;
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
      id="library-results"
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
            <Link href={docHref(r.namespace, r.path)}>
              <b>{r.title || r.path}</b>
            </Link>{" "}
            <span className="cap-text cap-mono" data-tone="dim">
              {r.namespace}/{r.path}
            </span>{" "}
            <span className="cap-text" data-tone="dim">
              · {r.type} · {ago(parse(r.updated_at), now)}
            </span>
            <div>
              <Snippet text={r.snippet} />
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function DocumentView({
  data,
  back,
  now,
}: {
  data: Extract<PortalLibrary, { kind: "document" }>;
  back: string;
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
      id="library-document"
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
      <div className="lib-body">{withJobLinks(d.body, back)}</div>
      {edges.length > 0 && (
        <ul className="shared-local lib-edges" aria-label="Linked documents">
          {edges.map((e) => (
            <li key={`${e.dir}|${e.type}|${e.ns}/${e.path}`}>
              <span className="cap-text" data-tone="dim">
                {e.type} {e.dir}
              </span>{" "}
              <Link href={docHref(e.ns, e.path)}>
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
