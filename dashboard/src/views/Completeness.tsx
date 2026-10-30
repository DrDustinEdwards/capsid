import { Empty, Spinner } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { useApp } from "../app/ctx";
import { fetchCompleteness, useAnswer } from "../lib/api";
import { ago, fmtN, ms } from "../lib/format";
import type { CompletenessArea, CompletenessCell, CompletenessStatus, CompletenessView } from "../types";
import { St } from "../ui/icons";
import "./Completeness.css";

// COMPLETENESS: devkit's daily scoreboard (src/completeness.ts). Every area of the shared code
// against the package and every live site, each cell from the live checks and the verifiers'
// verdicts only, so no thread can mark its own work complete. The grid gives the whole
// picture; each area's panel below says why a cell is not complete yet, with the proof.
// Nothing here changes anything: a verdict is a file in devkit, signed by a verifier.

const BOARD_URL = "https://github.com/DrDustinEdwards/devkit/blob/scoreboard/SCOREBOARD.md";
const KIND = { complete: "ok", partial: "warn", missing: "crit", "n/a": "nodata" } as const;
const LABEL: Record<CompletenessStatus, string> = { complete: "Complete", partial: "Partial", missing: "Missing", "n/a": "Does not apply" };
const CLEAN_DAYS = 7;

type Column = { id: string; name: string };

export function Completeness() {
  const { now } = useApp();
  const load = useAnswer<CompletenessView>(["completeness"], fetchCompleteness);
  const data = load.data;
  if (load.loading && !data) {
    return (
      <div className="loading">
        <Spinner label="Reading the scoreboard" />
      </div>
    );
  }
  if (load.error) {
    return (
      <p role="alert">
        <St kind="crit">Could not read the scoreboard: {load.error}</St>
      </p>
    );
  }
  if (!data || data.error) {
    return (
      <Empty kind="nothing-yet" title="No scoreboard to show.">
        {data?.error ?? "devkit's live workflow has not published one."}
      </Empty>
    );
  }
  const columns: Column[] = [{ id: "package", name: "Package" }, ...data.sites];
  const cells = data.areas.flatMap((a) => columns.map((c) => a.cells[c.id]).filter((cell): cell is CompletenessCell => cell !== undefined && cell.status !== "n/a"));
  const count = (s: CompletenessStatus) => cells.filter((c) => c.status === s).length;
  return (
    <div className="embedded">
      <div className={`callout${data.finished ? "" : " warn"} done-verdict`}>
        <b>{data.finished ? "Finished." : "Not finished."}</b> {fmtN(count("complete"))} of {fmtN(cells.length)} cells complete, {fmtN(count("partial"))} partial, {fmtN(count("missing"))} missing.{" "}
        {data.finished ? `Every cell is complete and has passed ${CLEAN_DAYS} daily runs in a row.` : `Finished means every cell complete and clean for ${CLEAN_DAYS} daily runs.`}
      </div>
      <Panel flush title="Every area on every site" id="done-grid" section="Grid" src={<>From the live checks and the verifiers' verdicts only · <a href={BOARD_URL} target="_blank" rel="noreferrer noopener">the board on GitHub</a></>}>
        <div className="scroll-x">
          <table className="brief done-grid">
            <caption className="sr-only">Each area of the shared code, for the package and each live site</caption>
            <thead>
              <tr>
                <th scope="col">Area</th>
                {columns.map((c) => (
                  <th key={c.id} scope="col">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.areas.map((a) => (
                <tr key={a.id}>
                  <th scope="row">
                    <a href={`#done-area-${a.id}`}>
                      {a.id}. {a.name}
                    </a>
                  </th>
                  {columns.map((c) => {
                    const cell = a.cells[c.id];
                    return <td key={c.id}>{cell ? <Mark cell={cell} where={`${a.name}, ${c.name}`} /> : <span className="faint">·</span>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      {data.areas.map((a) => (
        <AreaPanel key={a.id} area={a} columns={columns} publicOnly={data.public_token} />
      ))}
      <p className="faint shared-read">
        Newest run {data.as_of ? ago(ms(data.as_of), now) : "unknown"}; read {ago(ms(data.read), now)}. Runs daily at 06:23 UTC. Kept for ten minutes.
      </p>
    </div>
  );
}

// One cell in the grid: the status as an icon, its words for a screen reader and on hover.
function Mark({ cell, where }: { cell: CompletenessCell; where: string }) {
  const label = `${where}: ${LABEL[cell.status]}. ${cell.reason}`;
  return (
    <span className={`done-mark ${KIND[cell.status]}`} title={label} role="img" aria-label={label}>
      <St kind={KIND[cell.status]}>{""}</St>
    </span>
  );
}

function linesText(area: CompletenessArea, publicOnly: boolean): string {
  if (!area.lines) return "Lines not counted yet";
  if ("error" in area.lines) return `Lines not counted: ${area.lines.error}`;
  const { prs, added, removed } = area.lines;
  return `${fmtN(prs)} ${prs === 1 ? "PR" : "PRs"}, +${fmtN(added)} −${fmtN(removed)} lines${publicOnly ? " (public repos only)" : ""}`;
}

function AreaPanel({ area, columns, publicOnly }: { area: CompletenessArea; columns: Column[]; publicOnly: boolean }) {
  const open = columns.map((c) => ({ c, cell: area.cells[c.id] })).filter((x): x is { c: Column; cell: CompletenessCell } => x.cell !== undefined && x.cell.status !== "complete" && x.cell.status !== "n/a");
  const done = columns.filter((c) => area.cells[c.id]?.status === "complete");
  const sites = columns.filter((c) => c.id !== "package" && area.cells[c.id] && area.cells[c.id]!.status !== "n/a").length;
  return (
    <Panel
      flush
      title={`${area.id}. ${area.name}`}
      id={`done-area-${area.id}`}
      section={area.name}
      src={
        <>
          Built by {area.builder} · {area.verifier ? <>verified by {area.verifier}</> : <St kind="nodata">no verifier yet</St>}
        </>
      }
      footer={<span className="faint">{linesText(area, publicOnly)}</span>}
    >
      {open.length ? (
        <ul className="done-open" aria-label={`Not complete in ${area.name}`}>
          {groups(open).map(({ names, cell }) => (
            <li key={names.join("|")}>
              <St kind={KIND[cell.status]}>{sites > 1 && names.length === sites && !names.includes("Package") ? "Every site" : names.join(", ")}</St> <span>{cell.reason}</span>
              {cell.clean_days !== null && cell.status === "partial" && <span className="faint"> · clean {cell.clean_days} of {CLEAN_DAYS} days</span>}
              {cell.errors.length > 0 && (
                <ul className="done-errors">
                  {cell.errors.map((e, i) => (
                    <li key={i}>
                      <span className="mono">{e.check}</span> <span className="faint">{e.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
              {cell.evidence.length > 0 && <Evidence urls={cell.evidence} />}
            </li>
          ))}
        </ul>
      ) : (
        <p className="faint shared-none">Every cell that applies is complete.</p>
      )}
      {done.length > 0 && (
        <p className="done-complete">
          <St kind="ok">Complete</St> {done.map((c) => c.name).join(", ")}
        </p>
      )}
    </Panel>
  );
}

// Cells that say the same thing (no check yet, the same reason) share one line, so twelve
// sites without a check read as one sentence; a cell with errors or proof keeps its own.
function groups(open: Array<{ c: Column; cell: CompletenessCell }>): Array<{ names: string[]; cell: CompletenessCell }> {
  const out: Array<{ key: string; names: string[]; cell: CompletenessCell }> = [];
  for (const { c, cell } of open) {
    const key = cell.errors.length || cell.evidence.length ? `own:${c.id}` : `${cell.status}|${cell.reason}|${cell.clean_days}`;
    const found = out.find((g) => g.key === key);
    if (found) found.names.push(c.name);
    else out.push({ key, names: [c.name], cell });
  }
  return out;
}

function Evidence({ urls }: { urls: string[] }) {
  return (
    <span className="faint">
      {" · "}
      {urls.map((u, i) => (
        <span key={u}>
          {i > 0 && ", "}
          <a href={u} target="_blank" rel="noreferrer noopener">
            proof {i + 1}
          </a>
        </span>
      ))}
    </span>
  );
}
