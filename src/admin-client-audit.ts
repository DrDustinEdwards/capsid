import { auditStatement } from "./store-guards";
import { logEvent } from "./log";

// job_e1973c5bcb69, DECIDE 2: for 30 days, record which client the admin acts through,
// so the seat can see whether a Claude Code session ever reaches /mcp as the admin.
// OBSERVATION ONLY. Nothing here refuses a call because of what the client says: a
// clientInfo name and a User-Agent are chosen by the client, so a refusal keyed on
// either would stop only an honest one (capsid/research/design-local-admin-exposure.md).
//
// Two kinds of audit_log row, because /mcp is stateless: createMcpHandler builds a new
// server and transport per HTTP request (agents/mcp, handler.ts), so a tools/call
// request carries no clientInfo from the earlier initialize.
//   - "admin-initialize": the clientInfo name and User-Agent of an initialize request.
//   - "admin-client": one per admin call that is not a plain read, with the tool, the
//     User-Agent, and the client name only when the request itself has one (null in
//     production). Join the two on user_agent.
// The window ends at a fixed instant, so a merge later than 2026-10-04 shortens it.
export const ADMIN_CLIENT_AUDIT_UNTIL_MS = Date.parse("2026-11-03T00:00:00Z");

const MAX_FIELD = 200;
const MAX_INITIALIZE_BODY = 16384;
const clip = (v: string | null | undefined) => (v ? v.slice(0, MAX_FIELD) : null);

export interface AdminWriteCall {
  tool: string;
  action: string | undefined;
  namespace: string | undefined;
}

// Resolves to a refusal message, or null to let the call run. These rows are
// observation only (D2, ruled by Dustin 2026-10-04), so a row that cannot be written is
// logged under ADMIN_CLIENT_AUDIT_FAILED and the call proceeds: the observer returns
// null on every path today. The type keeps the refusal arm because the registrar's
// contract is shared. Every other audit row keeps its own behavior.
export type AdminWriteObserver = (call: AdminWriteCall, clientName: string | null) => Promise<string | null>;

function reportFailure(what: string, err: unknown): void {
  logEvent("error", "ADMIN_CLIENT_AUDIT_FAILED", { message: `ADMIN_CLIENT_AUDIT_FAILED ${what}: ${err instanceof Error ? err.message : String(err)}` });
}

export function adminWriteObserver(db: D1Database, actor: string, userAgent: string | null, now: () => number = Date.now): AdminWriteObserver {
  return async (call, clientName) => {
    if (now() >= ADMIN_CLIENT_AUDIT_UNTIL_MS) return null;
    try {
      await auditStatement(db, actor, "admin-client", call.namespace ?? null, null, {
        tool: call.tool,
        action: call.action ?? null,
        user_agent: clip(userAgent),
        client_name: clip(clientName),
      }).run();
      return null;
    } catch (err) {
      reportFailure(call.tool, err);
      return null;
    }
  };
}

// The clientInfo of an initialize request, from the JSON-RPC body (one message or a
// batch). Null when the body is not one. A body that is not JSON is the MCP handler's
// to reject, so it is not an error here: there is simply no initialize to record.
export function initializeClient(body: unknown): { client_name: string | null; protocol_version: string | null } | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const m of messages) {
    if (!m || typeof m !== "object" || (m as { method?: unknown }).method !== "initialize") continue;
    const params = (m as { params?: { clientInfo?: { name?: unknown }; protocolVersion?: unknown } }).params;
    const name = params?.clientInfo?.name;
    const version = params?.protocolVersion;
    return {
      client_name: typeof name === "string" ? clip(name) : null,
      protocol_version: typeof version === "string" ? clip(version) : null,
    };
  }
  return null;
}

// Reads the request's own body, on a clone, only when it is small enough to be an
// initialize (they are a few hundred bytes), so a large document write is never read
// twice. A failed insert is logged and the connect proceeds (observation only).
export async function recordAdminInitialize(
  db: D1Database,
  actor: string,
  request: Request,
  now: () => number = Date.now
): Promise<boolean> {
  if (now() >= ADMIN_CLIENT_AUDIT_UNTIL_MS || request.method !== "POST") return false;
  const length = Number(request.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_INITIALIZE_BODY) return false;
  let body: unknown;
  try {
    body = JSON.parse(await request.clone().text());
  } catch {
    return false;
  }
  const client = initializeClient(body);
  if (!client) return false;
  try {
    await auditStatement(db, actor, "admin-initialize", null, null, { ...client, user_agent: clip(request.headers.get("User-Agent")) }).run();
  } catch (err) {
    reportFailure("initialize", err);
    return false;
  }
  return true;
}
