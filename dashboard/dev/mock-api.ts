// Dev only: serves dev/sample-feed.json at /console/api/ops so `npm run dev` runs
// with fake data and no Worker. Never part of the build (apply: "serve").
//
// The fixture's timestamps are fixed; each response shifts every ISO timestamp and
// ring_slot so live.generated is "now", which keeps the relative times readable.
//
// WF_MOCK=signed-out answers 401, WF_MOCK=no-snapshot drops the watcher pass,
// WF_MOCK=no-token marks Cloudflare as not configured.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type { OpsFeed } from "../src/types.ts";

const FIXTURE = fileURLToPath(new URL("./sample-feed.json", import.meta.url));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SLOT_MS = 30 * 60_000;
const REFRESH_GAP_MS = 30_000;

function shift(value: unknown, delta: number): unknown {
  if (typeof value === "string" && ISO.test(value)) return new Date(Date.parse(value) + delta).toISOString();
  if (Array.isArray(value)) return value.map((v) => shift(v, delta));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === "ring_slot" && typeof v === "number" ? v + Math.round(delta / SLOT_MS) : shift(v, delta);
    }
    return out;
  }
  return value;
}

function feed(nextRefresh: number): OpsFeed {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as OpsFeed;
  const delta = Date.now() - Date.parse(raw.live.generated);
  const out = shift(raw, delta) as OpsFeed;
  const mode = process.env.WF_MOCK;
  if (mode === "no-snapshot") out.snapshot = null;
  if (mode === "no-token") {
    out.cloudflare_configured = false;
    for (const s of out.snapshot?.sites ?? []) {
      if (s.platform === "cloudflare") s.cloudflare = { state: "no-token", reason: "CF_OPS_TOKEN is not set" };
    }
  }
  out.refresh_allowed_at = nextRefresh > Date.now() ? new Date(nextRefresh).toISOString() : null;
  return out;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export function mockOpsApi(): Plugin {
  let nextRefresh = 0;
  return {
    name: "capsid-portal-mock-ops",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const path = (req.url ?? "").split("?")[0];
        if (path !== "/console/api/ops" && path !== "/console/api/ops/refresh") return next();
        if (process.env.WF_MOCK === "signed-out") return send(res, 401, { error: "signed out" });
        if (path === "/console/api/ops") {
          if (req.method !== "GET") return send(res, 405, { error: "method" });
          return send(res, 200, feed(nextRefresh));
        }
        if (req.method !== "POST" || req.headers["x-capsid-ops"] !== "refresh") return send(res, 400, { error: "refresh needs POST and X-Capsid-Ops: refresh" });
        if (Date.now() < nextRefresh) {
          return send(res, 429, { error: "too soon", refresh_allowed_at: new Date(nextRefresh).toISOString() });
        }
        nextRefresh = Date.now() + REFRESH_GAP_MS;
        return send(res, 200, feed(nextRefresh));
      });
    },
  };
}
