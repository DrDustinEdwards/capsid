import { useCallback } from "react";
import { useApp, type UndoRequest } from "../app/ctx";
import { runAction } from "../lib/api";
import type { PortalActionRequest } from "../types";

// Sends one switch change (preview, then perform, with no dialog: the applied reason is
// the confirmation) and, when it applies, hands the result and its Undo to the app's
// message. Rejects with the refusal in plain words, which Capsomer's reason form shows
// beside the field until the next try or Cancel.
export function useApplySwitch(): (req: PortalActionRequest, undo: UndoRequest) => Promise<void> {
  const { feed, performed, signOut } = useApp();
  const csrf = feed.csrf;
  return useCallback(
    async (req, undo) => {
      const r = await runAction(csrf, req);
      if (r.kind === "ok") return performed(r.value, undo);
      if (r.kind === "signed-out") return signOut();
      throw new Error(r.kind === "error" ? `Could not reach the server: ${r.message}` : r.message);
    },
    [csrf, performed, signOut],
  );
}
