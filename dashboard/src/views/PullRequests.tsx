import { parse } from "capsomer/behavior/time";
import { Panel } from "capsomer/react/panel";
import { useApp } from "../app/ctx";
import { ago } from "../lib/format";
import { usePrs } from "../lib/trends";
import { ChartSlot } from "../ui/ChartSlot";
import { boardChart } from "./charts";
import { PageHead } from "./shared";

const PrTable = boardChart("PrTable");

export function PullRequests() {
  const { now } = useApp();
  const prs = usePrs();
  const data = prs.data;
  return (
    <div className="cap-admin-page">
      <PageHead title="Pull requests" />
      <Panel
        flush
        title="Open"
        id="open-prs"
        count={data?.prs.length}
        src={data ? `as of ${ago(parse(data.as_of), now)}, ${data.repos_read} repos` : undefined}
      >
        <div className="body cap-stack" data-gap="4">
          {!data ? (
            <p className="cap-text" data-tone="dim">
              {prs.error
                ? `Could not read the pull requests: ${prs.error}`
                : "Reading pull requests..."}
            </p>
          ) : data.prs.length === 0 ? (
            <p className="cap-text">No open pull request.</p>
          ) : (
            <ChartSlot>
              <PrTable data={data} />
            </ChartSlot>
          )}
          {data && data.not_checked.length > 0 && (
            <p className="cap-text" data-tone="dim">
              Not checked: {data.not_checked.join("; ")}.
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}
