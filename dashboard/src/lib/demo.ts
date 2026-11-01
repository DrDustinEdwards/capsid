// The Portal's chart demo (devkit live/areas.json, area 10): the same app, built a second time at
// /demos/ (vite.config.ts, mode "demo") and served on portal.dustinedwards.info with no sign-in, so a
// live check sees the charts a signed-in owner sees. Its data is dev/sample-feed.json and the dev
// mock's other answers (example.com sites, "sample" namespaces), captured once at build time into
// /demos/api/*.json by scripts/demo-api.ts. Nothing in it is read from Capsid, and nothing is written:
// every request that is not a GET is answered here with a refusal and never leaves the browser.

export const DEMO_BASE = "/demos";

/** The clock the captured answers were made at; each read moves every time by now minus this. */
export const DEMO_CAPTURED = "2026-10-01T12:00:00.000Z";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_MS = 30 * 60_000;
const DAY_MS = 86_400_000;

/** Every ISO time in `value` moved by `delta` ms, and every ring_slot by as many half-hour slots.
 *  The dev mock uses the same shift (dev/mock-api.ts), so the times read as recent. With `days`, a
 *  bare date (the trends' days, 2026-09-18) moves by as many whole days too: the mock makes those from
 *  its clock, which the demo's captured answers pinned. */
export function shiftTimes(value: unknown, delta: number, days = false): unknown {
  if (typeof value === "string" && ISO.test(value)) return new Date(Date.parse(value) + delta).toISOString();
  if (days && typeof value === "string" && DAY.test(value)) return new Date(Date.parse(value) + Math.round(delta / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map((v) => shiftTimes(v, delta, days));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === "ring_slot" && typeof v === "number" ? v + Math.round(delta / SLOT_MS) : shiftTimes(v, delta, days);
    }
    return out;
  }
  return value;
}

/** The demo's reads, answered from the captured files: GET /demos/api/<name>?... reads
 *  /demos/api/<name>.json (the query is not kept), moved to now. Anything else under /demos/api/
 *  is refused in the browser with 409 and plain text, which the app shows as the server's words. */
export function installDemoFetch(): void {
  const prefix = `${DEMO_BASE}/api/`;
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== window.location.origin || !url.pathname.startsWith(prefix)) return real(input, init);
    if (request.method !== "GET") {
      return new Response("This is a demo with sample data: nothing is saved or changed.", { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    const res = await real(`${url.pathname}.json`, { credentials: "omit" });
    if (!res.ok) return res;
    const moved = shiftTimes(await res.json(), Date.now() - Date.parse(DEMO_CAPTURED), true);
    return new Response(JSON.stringify(moved), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}
