import { stopCommand, type Command } from "capsomer/behavior/command-menu";
import type { ConfirmRequest } from "../app/ctx";
import type { OpsFeed } from "../types";

// A stop's own control: the confirm dialog (preview then perform), or a switch on
// Namespaces, pressed so that its reason field opens. Nothing is written from here.
export interface StopActions {
  confirm: (r: ConfirmRequest) => void;
  flip: (switchId: string) => void;
}

// Every way to stop something, in one place (capsid/decisions.md 2026-09-30, "admin
// panels review adopted", item 4): type "stop" to find them all. Each is listed only while
// there is something to stop. Here, not in app/CommandMenu.tsx, so a node test can import it.
export function stopCommands(feed: OpsFeed | null, a: StopActions): Command[] {
  if (!feed) return [];
  const out: Command[] = [];
  if (feed.live.overnight.mode !== "off") out.push(stopCommand({ id: "stop-overnight", label: "Turn the overnight run off", ask: "reason", run: () => a.flip("sw-overnight") }));
  for (const g of feed.live.agents) {
    if (!g.revoked_at) out.push(stopCommand({ id: `stop-agent-${g.name}`, label: `Revoke ${g.name}`, ask: "preview", keywords: ["revoke"], run: () => a.confirm({ action: "revoke_agent", params: { name: g.name }, title: `Revoke agent ${g.name}` }) }));
  }
  return out;
}
