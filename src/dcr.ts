import type { Env } from "./env";
import { readBoundedText } from "./improve-scorer";
import { callerIp, checkRate, type RateLimitPolicy } from "./rate-limit";
import { logEvent } from "./log";

// Tightened Dynamic Client Registration (capsid/rulings/mcp-2026-10-10.md, rule 13).
// Claude, Claude Code and ChatGPT sign in by Client ID Metadata Document. Grok and
// Gemini still need DCR as of 2026-10-09, so POST /register is back, tightened:
//
//   - every redirect URI a registration names is on the allowlist, matched exactly;
//   - registration grants nothing: it writes a client record and no grant or token. The
//     client still meets the per-client consent page on its first /authorize (the
//     approval is bound to the client id and its redirect set, src/approval.ts) and the
//     Access sign-in that admits ADMIN_EMAIL and CO_OWNER_EMAILS only;
//   - registration is rate limited per caller, and fails closed when the limit cannot
//     be read.
//
// REMOVAL CONDITION: delete this module, its gate in src/index.ts and the provider's
// clientRegistrationEndpoint when Grok and Gemini both sign in by CIMD, and at the
// latest when the MCP specification removes DCR (after summer 2027).
//
// It runs in the Worker's fetch before the OAuth provider, because the provider's
// registration callback is not handed env, and the allowlist's per-connector part and
// the rate limit's KV live there. This gate is the one place a registration is judged.

export const REGISTER_PATH = "/register";

// The callbacks that are the same for every user, matched exactly.
//   Grok: its custom connector callback.
//   ChatGPT: the connector platform's legacy callback, which OpenAI still honours.
export const FIXED_REDIRECTS: readonly string[] = [
  "https://grok.com/connectors/oauth/callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
];

// Google's (Gemini's) callback and ChatGPT's current one carry an id per connector, so
// they cannot be written down here. The seat lists the exact URIs, comma separated, in
// the DCR_REDIRECT_URIS var. Each must have one of these shapes, so a typo or a
// stray host in the var cannot widen the list; a listed URI of any other shape is
// ignored and logged. A pattern is never matched against a registration: only the
// exact listed strings are.
const PER_CONNECTOR_SHAPES: readonly RegExp[] = [
  /^https:\/\/oauth-redirect\.googleusercontent\.com\/r\/user_bound_custom-mcp-[A-Za-z0-9._-]+$/,
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/,
];

export function allowedRedirects(env: Pick<Env, "DCR_REDIRECT_URIS">): Set<string> {
  const allowed = new Set(FIXED_REDIRECTS);
  for (const raw of (env.DCR_REDIRECT_URIS ?? "").split(",")) {
    const uri = raw.trim();
    if (!uri) continue;
    if (PER_CONNECTOR_SHAPES.some((shape) => shape.test(uri))) allowed.add(uri);
    else logEvent("error", "DCR_REDIRECT_IGNORED", { message: `DCR_REDIRECT_URIS names ${uri}, which is not a Google or ChatGPT connector callback; it is not allowed` });
  }
  return allowed;
}

// A real registration is a few hundred bytes of JSON.
const REGISTER_MAX_BYTES = 16_384;

// Ten an hour and thirty a day from one address. A client registers once per
// connection, so a person connecting four clients never comes near it.
export const DCR_LIMIT: RateLimitPolicy = {
  prefix: "dcr:rate:",
  perHour: 10,
  perDay: 30,
  label: "DCR",
  // Fail closed: an unmeasured limit is no limit on an unauthenticated write.
  onUnavailable: "refuse",
};

function refusal(status: number, error: string, description: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// What the provider should see: the same request with the body this gate read, or the
// refusal. Only POST /register reaches here (src/index.ts).
export async function gateRegistration(request: Request, env: Env, now: Date): Promise<{ forward: Request } | { refuse: Response }> {
  const rate = await checkRate(env.APP_KV, callerIp(request), now, DCR_LIMIT);
  if (!rate.allowed) {
    if (rate.window === "unavailable") {
      return { refuse: refusal(503, "temporarily_unavailable", "client registration is refused while its rate limit cannot be read", { "Retry-After": "60" }) };
    }
    return {
      refuse: refusal(429, "slow_down", `too many registrations: ${rate.count} in the last ${rate.window}, limit ${rate.limit}`, {
        "Retry-After": rate.window === "hour" ? "3600" : "86400",
      }),
    };
  }

  const bounded = await readBoundedText(request, REGISTER_MAX_BYTES);
  if (!bounded.ok) return { refuse: refusal(413, "invalid_client_metadata", `the registration body is over ${REGISTER_MAX_BYTES} bytes`) };
  let metadata: unknown;
  try {
    metadata = JSON.parse(bounded.text);
  } catch {
    return { refuse: refusal(400, "invalid_client_metadata", "the registration body is not JSON") };
  }
  const redirects = (metadata as { redirect_uris?: unknown } | null)?.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0 || !redirects.every((u) => typeof u === "string")) {
    return { refuse: refusal(400, "invalid_redirect_uri", "redirect_uris must be a non-empty array of strings") };
  }
  const allowed = allowedRedirects(env);
  const unlisted = (redirects as string[]).filter((u) => !allowed.has(u));
  if (unlisted.length > 0) {
    logEvent("error", "DCR_REDIRECT_REFUSED", { message: `DCR_REDIRECT_REFUSED ${unlisted.join(" ")}` });
    return {
      refuse: refusal(
        400,
        "invalid_redirect_uri",
        `not an allowed redirect URI: ${unlisted.join(", ")}. This server registers only the Grok, Gemini and ChatGPT connector callbacks it lists; other clients sign in by Client ID Metadata Document.`
      ),
    };
  }
  return { forward: new Request(request, { body: bounded.text }) };
}
