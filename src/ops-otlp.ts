import { readBoundedText } from "./improve-scorer";
import { resolveSessionCaller, type SessionCaller } from "./ops-session-auth";

// Claude Code's OpenTelemetry, received as OTLP/HTTP JSON (docs/telemetry.md).
//
// POST /ops/otlp/v1/metrics keeps per-session totals in session_usage
// (migrations/0025): cost, tokens, active time, commits, pull requests and lines of
// code, per metric, type attribute and model. Delta points are added; a cumulative
// point replaces the stored total. Nothing else in the export is read.
//
// POST /ops/otlp/v1/logs keeps one number: how many api_error events each session
// reported, as the metric claude_code.api_error keyed by the HTTP status. Every other
// event is counted as seen and dropped; a log record's body and its other attributes
// (a prompt, when OTEL_LOG_USER_PROMPTS is on; a tool's input) are never read into a
// value that is stored.
//
// ALLOWLIST, NOT DENYLIST. What reaches D1 is: the session id, the job id, the metric
// name from METRICS below, a type from that metric's list, a model name that matches
// MODEL_SHAPE, and a number. A new attribute Claude Code starts sending is ignored
// until it is added here. (test/ops-otlp.test.ts, the PLANT test.)

export const OTLP_METRICS_PATH = "/ops/otlp/v1/metrics";
export const OTLP_LOGS_PATH = "/ops/otlp/v1/logs";

// 1MB, after decompression. The compressed body is held to the same cap.
export const OTLP_MAX_BYTES = 1024 * 1024;
// Bounds on one request, so a runaway exporter costs one bounded batch.
const OTLP_MAX_SERIES = 200;
const OTLP_MAX_SESSIONS = 16;

// The metrics kept, and the type attribute values each may carry. An empty list means
// the metric has no type attribute, and its kind is ''.
const METRICS: Record<string, readonly string[]> = {
  "claude_code.cost.usage": [],
  "claude_code.token.usage": ["input", "output", "cacheRead", "cacheCreation"],
  "claude_code.active_time.total": ["user", "cli"],
  "claude_code.commit.count": [],
  "claude_code.pull_request.count": [],
  "claude_code.lines_of_code.count": ["added", "removed"],
};
const API_ERROR_METRIC = "claude_code.api_error";

const SESSION_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;
const MODEL_SHAPE = /^[A-Za-z0-9._:@/\[\]-]{1,100}$/;
const JOB_SHAPE = /^job_[0-9a-f]{12}$/;
const STATUS_SHAPE = /^[1-5][0-9]{2}$/;

// OTLP's AggregationTemporality: 1 delta, 2 cumulative. JSON carries the number; the
// enum name is accepted too.
type Temporality = "delta" | "cumulative";

interface UsagePoint {
  session_id: string;
  // The capsid.job_id attribute, when the exporter sent one that is a job id.
  job_attr: string | null;
  metric: string;
  kind: string;
  model: string;
  value: number;
  temporality: Temporality;
  // For "latest wins" among cumulative points of one series in one request.
  at: bigint;
}

interface ParsedExport {
  points: UsagePoint[];
  // Points of a kept metric that could not be read: no session id, a value that is
  // not a non-negative number, an unknown type, a gauge. Reported as partialSuccess.
  rejected: number;
  problems: string[];
}

type Attr = { key?: unknown; value?: Record<string, unknown> };

// Only scalar attribute values are read. An arrayValue or kvlistValue is skipped.
function attrMap(list: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(list)) return out;
  for (const item of list as Attr[]) {
    if (typeof item?.key !== "string" || !item.value || typeof item.value !== "object") continue;
    const v = item.value;
    if (typeof v.stringValue === "string") out.set(item.key, v.stringValue);
    else if (typeof v.intValue === "string" || typeof v.intValue === "number") out.set(item.key, String(v.intValue));
    else if (typeof v.doubleValue === "number") out.set(item.key, String(v.doubleValue));
    else if (typeof v.boolValue === "boolean") out.set(item.key, String(v.boolValue));
  }
  return out;
}

function temporalityOf(raw: unknown): Temporality | null {
  if (raw === 1 || raw === "AGGREGATION_TEMPORALITY_DELTA") return "delta";
  if (raw === 2 || raw === "AGGREGATION_TEMPORALITY_CUMULATIVE") return "cumulative";
  return null;
}

/** A data point's value: asDouble, or asInt, which JSON may carry as a decimal string. */
export function pointValue(point: Record<string, unknown>): number | null {
  let value: number | null = null;
  if (typeof point.asDouble === "number") value = point.asDouble;
  else if (typeof point.asInt === "number") value = point.asInt;
  else if (typeof point.asInt === "string" && /^-?[0-9]{1,18}$/.test(point.asInt)) value = Number(point.asInt);
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function timeOf(point: Record<string, unknown>): bigint {
  const raw = point.timeUnixNano;
  if (typeof raw === "string" && /^[0-9]{1,20}$/.test(raw)) return BigInt(raw);
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
  return 0n;
}

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]).filter((x) => x && typeof x === "object") : []);

/** The kept points of an ExportMetricsServiceRequest. Throws nothing; a body that is
 *  not the expected shape yields no points. */
export function parseMetrics(body: unknown): ParsedExport {
  const out: ParsedExport = { points: [], rejected: 0, problems: [] };
  const problem = (message: string) => {
    out.rejected += 1;
    if (out.problems.length < 5 && !out.problems.includes(message)) out.problems.push(message);
  };
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  for (const rm of arr(root.resourceMetrics)) {
    const resource = attrMap((rm.resource as Record<string, unknown> | undefined)?.attributes);
    for (const sm of arr(rm.scopeMetrics)) {
      for (const metric of arr(sm.metrics)) {
        const name = metric.name;
        // Not one of ours: ignored, not rejected. The exporter did nothing wrong.
        if (typeof name !== "string" || !Object.hasOwn(METRICS, name)) continue;
        const sum = metric.sum as Record<string, unknown> | undefined;
        if (!sum || typeof sum !== "object") {
          const gaugePoints = arr((metric.gauge as Record<string, unknown> | undefined)?.dataPoints).length;
          for (let i = 0; i < gaugePoints; i += 1) problem(`${name} is not a sum`);
          continue;
        }
        const temporality = temporalityOf(sum.aggregationTemporality);
        for (const dp of arr(sum.dataPoints)) {
          if (!temporality) {
            problem(`${name} has no aggregationTemporality`);
            continue;
          }
          const attrs = new Map([...resource, ...attrMap(dp.attributes)]);
          const session = attrs.get("session.id");
          if (!session || !SESSION_SHAPE.test(session)) {
            problem(`${name} point without a usable session.id`);
            continue;
          }
          const value = pointValue(dp);
          if (value === null) {
            problem(`${name} point with a value that is not a non-negative number`);
            continue;
          }
          const kinds = METRICS[name];
          const kind = kinds.length === 0 ? "" : (attrs.get("type") ?? "");
          if (kinds.length > 0 && !kinds.includes(kind)) {
            problem(`${name} point with an unknown type`);
            continue;
          }
          const model = attrs.get("model") ?? "";
          if (model !== "" && !MODEL_SHAPE.test(model)) {
            problem(`${name} point with a model name this receiver does not accept`);
            continue;
          }
          const job = attrs.get("capsid.job_id");
          out.points.push({
            session_id: session,
            job_attr: job && JOB_SHAPE.test(job) ? job : null,
            metric: name,
            kind,
            model,
            value,
            temporality,
            at: timeOf(dp),
          });
        }
      }
    }
  }
  return out;
}

/** api_error events from an ExportLogsServiceRequest, as delta points of
 *  claude_code.api_error keyed by status. Every other record is skipped. */
export function parseLogs(body: unknown): ParsedExport {
  const out: ParsedExport = { points: [], rejected: 0, problems: [] };
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  for (const rl of arr(root.resourceLogs)) {
    const resource = attrMap((rl.resource as Record<string, unknown> | undefined)?.attributes);
    for (const sl of arr(rl.scopeLogs)) {
      for (const record of arr(sl.logRecords)) {
        const attrs = new Map([...resource, ...attrMap(record.attributes)]);
        const event = attrs.get("event.name");
        // Claude Code names the event in event.name ("api_error") and in the body
        // ("claude_code.api_error"). The body is compared, never kept.
        const bodyName = (record.body as Record<string, unknown> | undefined)?.stringValue;
        const isApiError = event === "api_error" || event === API_ERROR_METRIC || bodyName === API_ERROR_METRIC;
        if (!isApiError) continue;
        const session = attrs.get("session.id");
        if (!session || !SESSION_SHAPE.test(session)) {
          out.rejected += 1;
          if (out.problems.length === 0) out.problems.push("api_error record without a usable session.id");
          continue;
        }
        const status = attrs.get("status_code") ?? "";
        const model = attrs.get("model") ?? "";
        const job = attrs.get("capsid.job_id");
        out.points.push({
          session_id: session,
          job_attr: job && JOB_SHAPE.test(job) ? job : null,
          metric: API_ERROR_METRIC,
          kind: STATUS_SHAPE.test(status) ? status : "",
          model: MODEL_SHAPE.test(model) ? model : "",
          value: 1,
          temporality: "delta",
          at: timeOf(record),
        });
      }
    }
  }
  return out;
}

interface SeriesWrite {
  session_id: string;
  metric: string;
  kind: string;
  model: string;
  value: number;
  mode: "add" | "replace";
}

/** One write per series: delta points of a series summed, cumulative points of a
 *  series reduced to the newest. */
export function aggregate(points: UsagePoint[]): SeriesWrite[] {
  const deltas = new Map<string, SeriesWrite>();
  const latest = new Map<string, { write: SeriesWrite; at: bigint }>();
  for (const p of points) {
    const key = JSON.stringify([p.session_id, p.metric, p.kind, p.model]);
    if (p.temporality === "delta") {
      const seen = deltas.get(key);
      if (seen) seen.value += p.value;
      else deltas.set(key, { session_id: p.session_id, metric: p.metric, kind: p.kind, model: p.model, value: p.value, mode: "add" });
    } else {
      const seen = latest.get(key);
      if (!seen || p.at >= seen.at) {
        latest.set(key, { write: { session_id: p.session_id, metric: p.metric, kind: p.kind, model: p.model, value: p.value, mode: "replace" }, at: p.at });
      }
    }
  }
  return [...deltas.values(), ...[...latest.values()].map((l) => l.write)];
}

/**
 * The job each session's usage is recorded against. A session already bound (its
 * agent_sessions row, written by the hook receiver) keeps that job. Otherwise the
 * caller's binding. The capsid.job_id attribute never picks a job on its own: it is
 * set by whoever configured the exporter, so it is honoured only where it agrees with
 * the binding, and a disagreement is reported rather than recorded.
 */
export function jobForSession(caller: SessionCaller, bound: string | null | undefined, attr: string | null): { job: string | null; mismatch: boolean } {
  const job = bound ?? caller.job_id;
  return { job, mismatch: attr !== null && attr !== job };
}

// The upsert. The job a row was first written with is kept (COALESCE), so a session
// stays with the job it was bound to.
const UPSERT = (mode: "add" | "replace") =>
  `INSERT INTO session_usage (session_id, job_id, metric, kind, model, value, updated_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
   ON CONFLICT(session_id, metric, kind, model) DO UPDATE SET
     value = ${mode === "add" ? "session_usage.value + excluded.value" : "excluded.value"},
     job_id = COALESCE(session_usage.job_id, excluded.job_id),
     updated_at = excluded.updated_at`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function plain(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store" } });
}

/** The request body as text: identity or gzip, at most OTLP_MAX_BYTES either side of
 *  decompression. */
export async function readOtlpBody(request: Request): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return { ok: false, response: plain("unsupported media type: this receiver takes OTLP/HTTP JSON (OTEL_EXPORTER_OTLP_PROTOCOL=http/json), not protobuf", 415) };
  }
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > OTLP_MAX_BYTES) {
    return { ok: false, response: plain(`payload too large: the body exceeds ${OTLP_MAX_BYTES} bytes`, 413) };
  }
  const encoding = (request.headers.get("Content-Encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "identity" && encoding !== "gzip") {
    return { ok: false, response: plain(`unsupported content encoding '${encoding}': send gzip or none`, 415) };
  }
  if (!request.body) return { ok: true, text: "" };
  let stream: ReadableStream<Uint8Array> = request.body;
  if (encoding === "gzip") {
    // The compressed bytes are capped on the way in too, by counting what the
    // decompressor is fed.
    let fed = 0;
    const cap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        fed += chunk.byteLength;
        if (fed > OTLP_MAX_BYTES) controller.error(new Error("compressed body too large"));
        else controller.enqueue(chunk);
      },
    });
    stream = request.body.pipeThrough(cap).pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  }
  try {
    const read = await readBoundedText({ body: stream }, OTLP_MAX_BYTES);
    if (!read.ok) return { ok: false, response: plain(`payload too large: the body exceeds ${OTLP_MAX_BYTES} bytes after decompression`, 413) };
    return { ok: true, text: read.text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/too large/.test(message)) return { ok: false, response: plain(`payload too large: the compressed body exceeds ${OTLP_MAX_BYTES} bytes`, 413) };
    return { ok: false, response: plain(`bad request: the gzip body does not decompress (${message})`, 400) };
  }
}

/** Parse, bind and write one export. Returns the OTLP response. */
export async function recordExport(
  db: D1Database,
  caller: SessionCaller,
  parsed: ParsedExport,
  now: Date
): Promise<Response> {
  let rejected = parsed.rejected;
  const problems = [...parsed.problems];

  // Bounded: at most OTLP_MAX_SESSIONS sessions per request; points of the rest are
  // rejected.
  const sessions = [...new Set(parsed.points.map((p) => p.session_id))];
  const kept = new Set(sessions.slice(0, OTLP_MAX_SESSIONS));
  if (sessions.length > kept.size) problems.push(`more than ${OTLP_MAX_SESSIONS} sessions in one request`);
  const points = parsed.points.filter((p) => {
    if (kept.has(p.session_id)) return true;
    rejected += 1;
    return false;
  });

  const bound = new Map<string, string | null>();
  if (kept.size > 0) {
    const { results } = await db
      .prepare("SELECT session_id, job_id FROM agent_sessions WHERE session_id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify([...kept]))
      .all<{ session_id: string; job_id: string | null }>();
    for (const row of results ?? []) bound.set(row.session_id, row.job_id);
  }
  const jobOf = new Map<string, string | null>();
  let mismatched = 0;
  for (const p of points) {
    const { job, mismatch } = jobForSession(caller, bound.get(p.session_id), p.job_attr);
    jobOf.set(p.session_id, job);
    if (mismatch) mismatched += 1;
  }
  if (mismatched > 0) problems.push(`${mismatched} point(s) named a capsid.job_id other than the job this caller is bound to; they were recorded against the bound job`);

  let writes = aggregate(points);
  if (writes.length > OTLP_MAX_SERIES) {
    problems.push(`more than ${OTLP_MAX_SERIES} series in one request`);
    // The points behind the dropped series are not counted one by one; each dropped
    // series counts as one.
    rejected += writes.length - OTLP_MAX_SERIES;
    writes = writes.slice(0, OTLP_MAX_SERIES);
  }
  const at = now.toISOString();
  if (writes.length > 0) {
    try {
      await db.batch(
        writes.map((w) => db.prepare(UPSERT(w.mode)).bind(w.session_id, jobOf.get(w.session_id) ?? null, w.metric, w.kind, w.model, w.value, at))
      );
    } catch (err) {
      // Not swallowed (CLAUDE.md, no swallowed error rule): logged, and answered 503 so
      // the exporter retries rather than losing the points.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`OTLP_WRITE_FAILED ${caller.agent.actor}: ${message}`);
      return plain(`service unavailable: the usage could not be written (${message})`, 503);
    }
  }
  if (rejected === 0 && problems.length === 0) return json({});
  return json({ partialSuccess: { rejectedDataPoints: rejected, errorMessage: problems.join("; ") } });
}

async function handle(request: Request, env: { DB: D1Database; OPERATOR_KEY_HASH?: string }, parse: (body: unknown) => ParsedExport): Promise<Response> {
  const caller = await resolveSessionCaller(request, env);
  if (caller instanceof Response) return caller;
  const body = await readOtlpBody(request);
  if (!body.ok) return body.response;
  let decoded: unknown;
  try {
    decoded = JSON.parse(body.text);
  } catch {
    return plain("bad request: the body is not JSON", 400);
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return plain("bad request: the body is not an OTLP export object", 400);
  return recordExport(env.DB, caller, parse(decoded), new Date());
}

export function handleOtlpMetrics(request: Request, env: { DB: D1Database; OPERATOR_KEY_HASH?: string }): Promise<Response> {
  return handle(request, env, parseMetrics);
}

export function handleOtlpLogs(request: Request, env: { DB: D1Database; OPERATOR_KEY_HASH?: string }): Promise<Response> {
  return handle(request, env, parseLogs);
}
