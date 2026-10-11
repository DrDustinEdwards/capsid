// The last successful step-up action per admin identity, in APP_KV, so the step-up window
// slides across requests (src/scope.ts STEP_UP_WINDOW_MS). The TTL is the 12-hour cap:
// a record older than that can no longer admit anything.
import { logEvent } from "./log";
import { STEP_UP_MAX_MS } from "./scope";

const keyFor = (actor: string): string => `step-up:last:${actor}`;

// The record names the sign-in it belongs to, so another session's activity cannot keep
// this session's window open: only a reset made under the same sign-in counts.
export async function readLastStepUp(kv: KVNamespace, actor: string, signedInAt: number | null | undefined): Promise<number | null> {
  if (typeof signedInAt !== "number") return null;
  // A failed read counts as no recorded action: the window falls back to the sign-in alone.
  const raw = await kv.get(keyFor(actor)).catch(() => null);
  const [signedIn, at] = (raw ?? "").split(":").map(Number);
  return signedIn === signedInAt && Number.isFinite(at) ? at : null;
}

// The TTL only lets old records go; the window and the cap are decided from the stored
// times, never from expiry.
export async function recordStepUp(kv: KVNamespace, actor: string, signedInAt: number | null | undefined, now = Date.now()): Promise<void> {
  if (typeof signedInAt !== "number") return;
  try {
    await kv.put(keyFor(actor), `${signedInAt}:${now}`, { expirationTtl: Math.ceil(STEP_UP_MAX_MS / 1000) });
  } catch (error) {
    // The action already happened; a lost reset only shortens the window to the sign-in.
    logEvent("warn", "STEP_UP_RESET_LOST", {
      message: `could not record the step-up reset for ${actor}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
