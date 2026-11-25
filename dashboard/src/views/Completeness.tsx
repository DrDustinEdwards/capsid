import { Alert, Banner } from "capsomer/react/banner";
import { AwayLink } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { Spinner } from "capsomer/react/skeleton";
import { Panel } from "capsomer/react/panel";
import { StatusMatrix } from "capsomer/react/status-matrix";
import "capsomer/status-matrix.css";
import { useApp } from "../app/ctx";
import { fetchCompleteness } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import { ago } from "../lib/format";
import { shortCount } from "capsomer/behavior/format";
import { parse } from "capsomer/behavior/time";
import type {
  CompletenessArea,
  CompletenessCell,
  CompletenessStatus,
  CompletenessView,
} from "../types";
import { Status } from "capsomer/react/status";
import { KIND_STATUS } from "../lib/derive";
import "./Completeness.css";

const BOARD_URL = "https://github.com/DrDustinEdwards/devkit/blob/scoreboard/SCOREBOARD.md";
const KIND = {
  complete: "ok",
  partial: "warn",
  missing: "crit",
  unmeasured: "unknown",
  "n/a": "nodata",
} as const;
const TONE = {
  complete: "ok",
  partial: "warn",
  missing: "crit",
  unmeasured: "muted",
  "n/a": "nodata",
} as const;
const LABEL: Record<CompletenessStatus, string> = {
  complete: "Complete",
  partial: "Partial",
  missing: "Missing",
  unmeasured: "Could not measure",
  "n/a": "Does not apply",
};
const CLEAN_DAYS = 7;

type Column = { id: string; name: string };

export function Completeness() {
  const { now } = useApp();
  const load = useAnswer<CompletenessView>(["completeness"], fetchCompleteness);
  const data = load.data;
  if (load.loading && !data) {
    return <Spinner layout="page" label="Reading the scoreboard" />;
  }
  if (!data || data.error) {
    const err = data?.error ?? load.error;
    return err ? (
      <Empty kind="failed" title="No scoreboard to show.">
        {err}
      </Empty>
    ) : (
      <Empty kind="nothing-yet" title="No scoreboard to show." />
    );
  }
  const columns: Column[] = [{ id: "package", name: "Package" }, ...data.sites];
  const cells = data.areas.flatMap((a) =>
    columns
      .map((c) => a.cells[c.id])
      .filter((cell): cell is CompletenessCell => cell !== undefined && cell.status !== "n/a"),
  );
  const count = (s: CompletenessStatus) => cells.filter((c) => c.status === s).length;
  return (
    <div className="cap-stack">
      {load.error && <Banner tone="warn">Could not re-read the scoreboard: {load.error}</Banner>}
      <Alert tone={data.finished ? "neutral" : "warn"}>
        <b>{data.finished ? "Finished." : "Not finished."}</b> {shortCount(count("complete"))} of{" "}
        {shortCount(cells.length)} cells complete, {shortCount(count("partial"))} partial,{" "}
        {shortCount(count("missing"))} missing
        {count("unmeasured")
          ? `, ${shortCount(count("unmeasured"))} could not be measured`
          : ""}.{" "}
        {data.finished
          ? `Every cell is complete and has passed ${CLEAN_DAYS} daily runs in a row.`
          : `Finished: ${CLEAN_DAYS} clean daily runs.`}
      </Alert>
      <Panel
        flush
        title="Every area on every site"
        id="done-grid"
        section="Grid"
        src={
          <>
            <AwayLink href={BOARD_URL} newTab>
              the board on GitHub
            </AwayLink>
          </>
        }
      >
        <StatusMatrix
          caption="Each area of the shared code, for the package and each live site"
          columns={columns}
          rows={data.areas.map((a) => ({
            id: String(a.id),
            name: (
              <a href={`#done-area-${a.id}`}>
                {a.id}. {a.name}
              </a>
            ),
            text: a.name,
            cells: Object.fromEntries(
              Object.entries(a.cells).map(([id, c]) => [
                id,
                {
                  tone: TONE[c.status],
                  glyph: c.status === "unmeasured" ? ("unknown" as const) : undefined,
                  label: LABEL[c.status],
                  reason: c.reason,
                },
              ]),
            ),
          }))}
        />
      </Panel>
      {data.areas.map((a) => (
        <AreaPanel key={a.id} area={a} columns={columns} publicOnly={data.public_token} />
      ))}
      <p className="cap-text shared-read" data-tone="dim">
        Newest run {data.as_of ? ago(parse(data.as_of), now) : "unknown"}
      </p>
    </div>
  );
}

function linesText(area: CompletenessArea, publicOnly: boolean): string {
  if (!area.lines) return "Lines not counted yet";
  if ("error" in area.lines) return `Lines not counted: ${area.lines.error}`;
  const { prs, added, removed } = area.lines;
  return `${shortCount(prs)} ${prs === 1 ? "PR" : "PRs"}, +${shortCount(added)} −${shortCount(removed)} lines${publicOnly ? " (public repos only)" : ""}`;
}

function AreaPanel({
  area,
  columns,
  publicOnly,
}: {
  area: CompletenessArea;
  columns: Column[];
  publicOnly: boolean;
}) {
  const open = columns
    .map((c) => ({ c, cell: area.cells[c.id] }))
    .filter(
      (x): x is { c: Column; cell: CompletenessCell } =>
        x.cell !== undefined && x.cell.status !== "complete" && x.cell.status !== "n/a",
    );
  const done = columns.filter((c) => area.cells[c.id]?.status === "complete");
  const sites = columns.filter(
    (c) => c.id !== "package" && area.cells[c.id] && area.cells[c.id]!.status !== "n/a",
  ).length;
  return (
    <Panel
      flush
      title={`${area.id}. ${area.name}`}
      id={`done-area-${area.id}`}
      section={area.name}
      src={
        <>
          Built by {area.builder} ·{" "}
          {area.verifier ? (
            <>verified by {area.verifier}</>
          ) : (
            <Status tone="nodata">no verifier yet</Status>
          )}
        </>
      }
      footer={
        <span className="cap-text" data-tone="dim">
          {linesText(area, publicOnly)}
        </span>
      }
    >
      {open.length ? (
        <ul className="done-open" aria-label={`Not complete in ${area.name}`}>
          {groups(open).map(({ names, cell }) => (
            <li key={names.join("|")}>
              <Status {...KIND_STATUS[KIND[cell.status]]}>
                {sites > 1 && names.length === sites && !names.includes("Package")
                  ? "Every site"
                  : names.join(", ")}
              </Status>{" "}
              <span>{cell.reason}</span>
              {cell.clean_days !== null && cell.status === "partial" && (
                <span className="cap-text" data-tone="dim">
                  {" "}
                  · clean {cell.clean_days} of {CLEAN_DAYS} days
                </span>
              )}
              {cell.errors.length > 0 && (
                <ul className="done-errors">
                  {cell.errors.map((e, i) => (
                    <li key={i}>
                      <span className="cap-mono">{e.check}</span>{" "}
                      <span className="cap-text" data-tone="dim">
                        {e.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {cell.evidence.length > 0 && <Evidence urls={cell.evidence} />}
            </li>
          ))}
        </ul>
      ) : (
        <p className="cap-text shared-none" data-tone="dim">
          Every cell that applies is complete.
        </p>
      )}
      {done.length > 0 && (
        <p className="done-complete">
          <Status tone="ok">Complete</Status> {done.map((c) => c.name).join(", ")}
        </p>
      )}
    </Panel>
  );
}

function groups(
  open: Array<{ c: Column; cell: CompletenessCell }>,
): Array<{ names: string[]; cell: CompletenessCell }> {
  const out: Array<{ key: string; names: string[]; cell: CompletenessCell }> = [];
  for (const { c, cell } of open) {
    const key =
      cell.errors.length || cell.evidence.length
        ? `own:${c.id}`
        : `${cell.status}|${cell.reason}|${cell.clean_days}`;
    const found = out.find((g) => g.key === key);
    if (found) found.names.push(c.name);
    else out.push({ key, names: [c.name], cell });
  }
  return out;
}

function Evidence({ urls }: { urls: string[] }) {
  return (
    <span className="cap-text" data-tone="dim">
      {" · "}
      {urls.map((u, i) => (
        <span key={u}>
          {i > 0 && ", "}
          <AwayLink href={u} newTab>
            proof {i + 1}
          </AwayLink>
        </span>
      ))}
    </span>
  );
}
