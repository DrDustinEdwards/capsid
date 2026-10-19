import type { ConfirmRequest } from "../app/ctx";
import type { OpsFeed } from "../types";

// One row of the command menu (app/CommandMenu.tsx). Here, not there, so this module
// has no JSX and a node test can import it.
export interface Command {
  group: string;
  text: string;
  hint: string;
  run: () => void;
}

// A stop's own control: the confirm dialog (preview then perform), or a switch on
// Namespaces, pressed so that its reason field opens. Nothing is written from here.
export interface StopActions {
  confirm: (r: ConfirmRequest) => void;
  flip: (switchId: string) => void;
}

// Every way to stop something, in one place (capsid/decisions.md 2026-09-30, "admin
// panels review adopted", item 4): type "stop" to find them all. Each is
// listed only while there is something to stop.
export function stopCommands(feed: OpsFeed | null, a: StopActions): Command[] {
  if (!feed) return [];
  const out: Command[] = [];
  if (feed.live.overnight.mode !== "off") out.push({ group: "Stop", text: "Turn the overnight run off", hint: "asks a reason", run: () => a.flip("sw-overnight") });
  for (const g of feed.live.agents) {
    if (!g.revoked_at) out.push({ group: "Stop", text: `Revoke ${g.name}`, hint: "preview first", run: () => a.confirm({ action: "revoke_agent", params: { name: g.name }, title: `Revoke agent ${g.name}` }) });
  }
  return out;
}
