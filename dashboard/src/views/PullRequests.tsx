import { trendChart } from "./charts";
import { ChartSlot } from "../ui/ChartSlot";
import { PageHead } from "./shared";

const MergesChart = trendChart("MergesChart");

export function PullRequests() {
  return (
    <div className="cap-admin-page">
      <PageHead title="Pull requests" />
      <ChartSlot>
        <MergesChart />
      </ChartSlot>
    </div>
  );
}
