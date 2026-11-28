import { AttentionList } from "capsomer/react/attention-list";
import "capsomer/row-list.css";
import "capsomer/attention-list.css";
import { rowLink } from "../lib/router";
import { useApp } from "../app/ctx";
import { attentionList } from "../lib/derive";

export function Problems() {
  const { feed, now, href } = useApp();
  const { items, groups } = attentionList(feed, now, href, true);
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
