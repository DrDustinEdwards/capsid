import { AttentionList } from "capsomer/react/attention-list";
import "capsomer/row-list.css";
import "capsomer/attention-list.css";
import { rowLink } from "../lib/router";
import { useApp } from "../app/ctx";
import { attentionList, WAITING_KINDS } from "../lib/derive";

// ---- Problems (was Needs attention) ------------------------------------------------------

// What is broken or needs looking at, worst first, as Capsomer's attention list: like rows
// fold into one that opens in place, warnings past the first eight wait behind "N more",
// and the notices are one closed row at the foot. What waits on your decision is in the
// list above, so it is left out here.
export function Problems({ sitesOn }: { sitesOn: boolean }) {
  const { feed, now, href } = useApp();
  const { items, groups } = attentionList(feed, now, href, WAITING_KINDS);
  return (
    <div id="attention">
      <AttentionList
        items={items}
        groups={groups}
        title="Problems"
        read={`From ${sitesOn ? "sites, " : ""}backups, CI, the watcher and agents.`}
        clearText="No problems."
        noticesDetail="Missing data and quiet agents: nothing to act on now"
        primary={false}
        renderLink={rowLink}
      />
    </div>
  );
}
