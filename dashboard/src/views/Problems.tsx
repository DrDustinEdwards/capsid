import { AttentionList } from "capsomer/react/attention-list";
import "capsomer/row-list.css";
import "capsomer/attention-list.css";
import { rowLink } from "../lib/router";
import { useApp } from "../app/ctx";
import { attentionList } from "../lib/derive";

// What is broken or needs looking at, worst first, as Capsomer's attention list: like rows
// fold into one that opens in place, warnings past the first eight wait behind "N more",
// and the notices are one closed row at the foot. What waits on your decision is in the
// list above, so it is left out here.
export function Problems() {
  const { feed, now, href } = useApp();
  const { items, groups } = attentionList(feed, now, href);
  return (
    <div id="attention">
      <AttentionList
        items={items}
        groups={groups}
        title="Problems"
        clearText="No problems."
        primary={false}
        renderLink={rowLink}
      />
    </div>
  );
}
