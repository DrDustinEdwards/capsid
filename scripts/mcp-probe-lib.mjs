// Gate 8's decisions, apart from scripts/verify-live.mjs so they can be tested: the same
// reason scripts/cimd-probe-lib.mjs and scripts/canary-lib.mjs exist. Node standard
// library only, because the live job runs with no npm ci.
//
// Every other gate stops short of the MCP connection: a deploy that answered OAuth
// metadata, /register, the consent page and the Access redirect, and then broke every
// tool call, passed them all (job_bb06c9be24c4, found in the #331 rollback report).
// This gate makes the calls a client makes, through /ops/mcp with the live-probe agent's
// key (scripts/mint-agents.ts, role live-probe: read grant on capsid, the capsid_read_doc tool
// only), in both protocol eras Capsid serves:
//
//   2025-11-25  initialize, notifications/initialized, tools/list, tools/call capsid_read_doc
//   2026-07-28  server/discover, tools/list, tools/call capsid_read_doc, each with the _meta envelope
//
// When src/mcp-handler.ts stops passing isLegacyRequest to routeMcpEra, 2025-11-25 leaves ERAS
// in the same pull request.

export const ERAS = ["2025-11-25", "2026-07-28"];

// What tools/list must return on /mcp to the live-probe agent, which holds the read grant:
// Capsid's tools a read grant can call, not Capsid Admin's and not the write tools, which
// are not listed for a read grant (src/scope.ts toolListed; area 11, T7). So the gate
// catches a deploy that lost a read tool; one that lost a write tool shows in the tests.
// test/live-gate-mcp.test.ts holds it to CAPSID_TOOLS and TOOL_GRANTS, so a change to the
// served surface changes this in the same commit.
export const EXPECTED_TOOLS = 8;

// The tool the probe reads with.
export const READ_TOOL = "capsid_read_doc";

// The read: the document /health already depends on (`capsid/conventions.md` keeps the word "conventions"), in
// the one namespace the probe agent is scoped to.
export const PROBE_READ = { namespace: "capsid", path: "conventions.md", word: "conventions" };

const CLIENT_INFO = { name: "capsid-live-gate", version: "1" };

// A JSON-RPC answer from a body that is JSON, or an event stream carrying it on a data:
// line (the 2025-era lane answers text/event-stream). Null when neither.
export function rpcMessage(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: read it as an event stream below.
  }
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim());
      if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) return parsed;
    } catch {
      // A data line that is not JSON is not the answer; keep reading.
    }
  }
  return null;
}

function envelope(era) {
  return { "io.modelcontextprotocol/protocolVersion": era, "io.modelcontextprotocol/clientInfo": CLIENT_INFO, "io.modelcontextprotocol/clientCapabilities": {} };
}

// The requests, in order, for one era. Each names what its answer must show.
export function eraSteps(era) {
  const modern = era !== "2025-11-25";
  const params = (p = {}) => (modern ? { ...p, _meta: envelope(era) } : p);
  const headers = (method, name) =>
    modern ? { "mcp-method": method, "mcp-protocol-version": era, ...(name ? { "mcp-name": name } : {}) } : method === "initialize" ? {} : { "mcp-protocol-version": era };
  const read = { name: READ_TOOL, arguments: { namespace: PROBE_READ.namespace, path: PROBE_READ.path } };
  const steps = modern
    ? [{ label: "server/discover", method: "server/discover", params: params(), headers: headers("server/discover") }]
    : [
        { label: "initialize", method: "initialize", params: { protocolVersion: era, capabilities: {}, clientInfo: CLIENT_INFO }, headers: headers("initialize") },
        { label: "notifications/initialized", method: "notifications/initialized", notification: true, headers: headers("notifications/initialized") },
      ];
  steps.push({ label: "tools/list", method: "tools/list", params: params(), headers: headers("tools/list") });
  steps.push({ label: `tools/call ${READ_TOOL}`, method: "tools/call", params: params(read), headers: headers("tools/call", READ_TOOL) });
  return steps.map((s, i) => ({ ...s, id: s.notification ? undefined : i + 1, era }));
}

export function requestBody(step) {
  const body = { jsonrpc: "2.0", method: step.method };
  if (step.params) body.params = step.params;
  if (!step.notification) body.id = step.id;
  return JSON.stringify(body);
}

// The problem with one answer, or null. `status` is the HTTP status and `text` the body.
export function stepProblem(step, status, text) {
  const where = `${step.era} ${step.label}`;
  if (status === 401 || status === 403) {
    return `${where}: HTTP ${status}. The probe key was refused: is CAPSID_LIVE_PROBE_KEY the live-probe agent's key, and is that agent unrevoked? A deploy that broke key resolution answers this too.`;
  }
  if (step.notification) return status >= 200 && status < 300 ? null : `${where}: HTTP ${status}, expected 2xx`;
  if (status !== 200) return `${where}: HTTP ${status}, expected 200${text ? `: ${String(text).slice(0, 160)}` : ""}`;
  const message = rpcMessage(text);
  if (!message) return `${where}: the answer is not JSON-RPC: ${String(text).slice(0, 160)}`;
  if (message.error) return `${where}: JSON-RPC error ${message.error.code}: ${String(message.error.message).slice(0, 200)}`;
  const result = message.result;
  if (!result || typeof result !== "object") return `${where}: no result`;
  switch (step.method) {
    case "initialize":
      if (result.protocolVersion !== step.era) return `${where}: negotiated ${JSON.stringify(result.protocolVersion)}, expected ${step.era}`;
      if (result.serverInfo?.name !== "capsid") return `${where}: serverInfo.name is ${JSON.stringify(result.serverInfo?.name)}, expected "capsid"`;
      return null;
    case "server/discover": {
      const versions = Array.isArray(result.supportedVersions) ? result.supportedVersions : [];
      if (!versions.includes(step.era)) return `${where}: supportedVersions ${JSON.stringify(versions)} does not include ${step.era}`;
      const name = result._meta?.["io.modelcontextprotocol/serverInfo"]?.name;
      if (name !== "capsid") return `${where}: serverInfo name is ${JSON.stringify(name)}, expected "capsid"`;
      return null;
    }
    case "tools/list": {
      const tools = Array.isArray(result.tools) ? result.tools : [];
      if (tools.length !== EXPECTED_TOOLS) return `${where}: ${tools.length} tools, expected ${EXPECTED_TOOLS}`;
      if (!tools.some((t) => t?.name === READ_TOOL)) return `${where}: no ${READ_TOOL} tool in the list`;
      // Claude Code refuses a 2026-07-28 tools/list without its cache fields.
      if (step.era !== "2025-11-25" && (typeof result.ttlMs !== "number" || typeof result.cacheScope !== "string")) {
        return `${where}: no ttlMs/cacheScope on a ${step.era} list, which Claude Code refuses`;
      }
      return null;
    }
    case "tools/call": {
      const first = Array.isArray(result.content) ? result.content[0] : undefined;
      const body = typeof first?.text === "string" ? first.text : "";
      if (result.isError === true) return `${where}: the tool refused: ${body.slice(0, 200)}`;
      const doc = (() => {
        try {
          return JSON.parse(body);
        } catch {
          return null;
        }
      })();
      if (doc?.namespace !== PROBE_READ.namespace || doc?.path !== PROBE_READ.path) {
        return `${where}: did not return ${PROBE_READ.namespace}/${PROBE_READ.path}: ${body.slice(0, 160)}`;
      }
      if (typeof doc.body !== "string" || !doc.body.includes(PROBE_READ.word)) return `${where}: the document came back without the word "${PROBE_READ.word}"`;
      return null;
    }
    default:
      return null;
  }
}

// Runs every era. `post(body, headers)` sends one request and resolves to { status, text },
// or throws when there was no answer (verify-live's NoAnswer), which this lets through.
// Resolves to the list of problems, empty when every step passed.
export async function probeMcp(post) {
  const problems = [];
  for (const era of ERAS) {
    for (const step of eraSteps(era)) {
      const { status, text } = await post(requestBody(step), step.headers);
      const problem = stepProblem(step, status, text);
      if (problem) {
        problems.push(problem);
        // A later step in a failed era only repeats the cause.
        break;
      }
    }
  }
  return problems;
}
