// The one JSON-RPC client the operator scripts use to reach /ops/mcp with a key. A tool
// refusal (isError) throws rather than reading as success.
//
// The key goes into the Authorization header and nowhere else. It is never printed.

/**
 * Refuse any origin that would send a bearer key in clear text.
 * @param {string} origin
 * @returns {string} the origin, unchanged
 */
export function requireHttps(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`CAPSID_ORIGIN '${origin}' is not a URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`CAPSID_ORIGIN must be https, and '${origin}' is not. The request carries a key in its Authorization header.`);
  }
  return origin;
}

/**
 * The JSON-RPC message in a response body. Streamable HTTP may answer as SSE; the
 * last `data:` line is the message. A body with no `data:` line is read as plain JSON.
 * @param {string} text
 * @param {string} method for the error message
 */
export function parseRpcBody(text, method) {
  const data = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  const payload = data.length > 0 ? data[data.length - 1].slice(5).trim() : text;
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error(`${method} -> the response was not JSON-RPC. Raw: ${text.slice(0, 300)}`);
  }
}

/**
 * A client bound to one origin and one key. `tool` initializes the session on first
 * use and THROWS when the tool refuses, so a refusal can never be reported as done.
 * @param {string} origin
 * @param {string} key
 * @param {string} clientName
 * @param {typeof fetch} [fetchImpl]
 */
export function capsidClient(origin, key, clientName, fetchImpl = fetch) {
  requireHttps(origin);
  let id = 0;
  let initialized = false;

  /** @param {object} message */
  const post = (message) =>
    fetchImpl(`${origin}/ops/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(message),
    });

  /** @param {string} method @param {object} params */
  async function rpc(method, params) {
    const res = await post({ jsonrpc: "2.0", id: ++id, method, params });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
    const body = parseRpcBody(text, method);
    if (body.error) throw new Error(`${method} -> ${JSON.stringify(body.error)}`);
    return body.result;
  }

  async function initialize() {
    if (initialized) return;
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: "1" },
    });
    await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    initialized = true;
  }

  /**
   * Call a tool and return its text. Throws on a refusal (isError).
   * @param {string} name
   * @param {object} args
   * @returns {Promise<string>}
   */
  async function tool(name, args) {
    await initialize();
    const result = await rpc("tools/call", { name, arguments: args });
    const text = (result?.content ?? []).map((/** @type {{ text?: string }} */ c) => c.text ?? "").join("");
    if (result?.isError) throw new Error(`${name} refused: ${text.slice(0, 400)}`);
    return text;
  }

  return { tool };
}
