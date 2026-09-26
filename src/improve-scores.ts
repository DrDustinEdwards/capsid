import { sha256Hex } from "./auth";
import { anchorKey, POLICY_PREFIX, PROMPTS_PREFIX, RUN_TASK_PREFIX, SCORES_PATH, SKILLS_PREFIX } from "./improve-schema";

export type Direction = "maximize" | "minimize";

export interface AnchorSpec {
  metric: string;
  // "required" means the value must be truthy (1). A bound means the value must
  // be at least (min) or at most (max) the number.
  kind: "required" | "min" | "max";
  bound: number | null;
}

export interface SecondarySpec {
  metric: string;
  direction: Direction;
  weight: number;
  // A stub is parsed, listed and reported, and excluded from every comparison until a
  // human removes the marker. It lets a namespace declare a metric it intends to wire
  // without that metric silently scoring as zero.
  stub: boolean;
}

export interface ScoresDoc {
  namespace: string;
  anchors: AnchorSpec[];
  secondary: SecondarySpec[];
  // The exact bytes the checksum is taken over, after line-ending normalization.
  anchorBlock: string;
  // Parse complaints. The document is still returned so the caller can report them.
  problems: string[];
}

export type MetricMap = Record<string, number | null>;

const ANCHOR_HEADING = /^##\s+anchors\s*$/i;
const SECONDARY_HEADING = /^##\s+secondary\s*$/i;
const SECTION_HEADING = /^##\s+/;

// CRLF is normalized before anything else, including the hash (capsid/repo-structure.md
// records the CRLF checkout hazard). A scores document from an autocrlf checkout would
// otherwise hash differently from the same document written through MCP, and the pin
// would mismatch for a reason unrelated to anyone editing an anchor.
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sectionSlice(lines: string[], startIndex: number): string {
  const out: string[] = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (SECTION_HEADING.test(lines[i])) break;
    out.push(lines[i]);
  }
  // Trailing blank lines are dropped so they cannot move the hash; interior ones are content.
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

// `- metric: required` | `- metric: min 0.95` | `- metric: max 3`
const ANCHOR_LINE = /^-\s*([a-z0-9_]+)\s*:\s*(required|min|max)(?:\s+(-?[0-9]*\.?[0-9]+))?\s*$/i;
// `- metric: maximize weight 3` | `- metric: minimize weight 1 stub`
const SECONDARY_LINE = /^-\s*([a-z0-9_]+)\s*:\s*(maximize|minimize)\s+weight\s+(-?[0-9]*\.?[0-9]+)(\s+stub)?\s*$/i;

export function parseScoresDoc(namespace: string, body: string): ScoresDoc {
  const lines = normalize(body).split("\n");
  const problems: string[] = [];
  const anchors: AnchorSpec[] = [];
  const secondary: SecondarySpec[] = [];

  const anchorAt = lines.findIndex((l) => ANCHOR_HEADING.test(l.trim()));
  const secondaryAt = lines.findIndex((l) => SECONDARY_HEADING.test(l.trim()));

  if (anchorAt === -1) problems.push("no '## Anchors' section: the loop has no floor and cannot run");
  if (secondaryAt === -1) problems.push("no '## Secondary' section: the loop has nothing to optimise");

  const anchorBlock = anchorAt === -1 ? "" : sectionSlice(lines, anchorAt);

  if (anchorAt !== -1) {
    for (const raw of anchorBlock.split("\n").slice(1)) {
      const line = raw.trim();
      if (!line.startsWith("-")) continue;
      const m = ANCHOR_LINE.exec(line);
      if (!m) {
        problems.push(`anchor line not understood: ${line}`);
        continue;
      }
      const kind = m[2].toLowerCase() as AnchorSpec["kind"];
      if (kind !== "required" && m[3] === undefined) {
        problems.push(`anchor '${m[1]}' declares ${kind} with no bound`);
        continue;
      }
      anchors.push({ metric: m[1], kind, bound: m[3] === undefined ? null : Number(m[3]) });
    }
  }

  if (secondaryAt !== -1) {
    for (const raw of sectionSlice(lines, secondaryAt).split("\n").slice(1)) {
      const line = raw.trim();
      if (!line.startsWith("-")) continue;
      const m = SECONDARY_LINE.exec(line);
      if (!m) {
        problems.push(`secondary line not understood: ${line}`);
        continue;
      }
      secondary.push({
        metric: m[1],
        direction: m[2].toLowerCase() as Direction,
        weight: Number(m[3]),
        stub: Boolean(m[4]),
      });
    }
  }

  if (anchorAt !== -1 && anchors.length === 0) {
    problems.push("the Anchors section declares no anchors; a loop with no floor is refused");
  }

  return { namespace, anchors, secondary, anchorBlock, problems };
}

export async function anchorChecksum(doc: ScoresDoc): Promise<string> {
  return sha256Hex(doc.anchorBlock);
}

// The write tool's improve-path guard: a refusal when a document write would touch the
// improve loop's control surface without allow_improve_paths, or null. The prefixes are
// refused outright. For scores.md only a write that changes the anchor checksum is
// refused (the Secondary section is freely editable); creating it counts as a change.
export async function improveWriteRefusal(
  namespace: string,
  path: string,
  priorBody: string | null,
  newBody: string,
  allow: boolean
): Promise<string | null> {
  if (allow) return null;
  // The nightly task document, `improve/run-<day>.md`, is read by the `/improve`
  // driver and executed as its instruction list on a machine holding five repo clones,
  // local git and a Capsid write grant.
  if (path.startsWith(RUN_TASK_PREFIX)) {
    return `${namespace}/${path} is an improve loop task document. The /improve driver executes it, so a write here steers a session with local shell and repo access. Pass allow_improve_paths: true to write it anyway; the flag is audit-logged. The loop writes and signs these itself.`;
  }
  if (path.startsWith(PROMPTS_PREFIX)) {
    return `${namespace}/${path} is the improve loop's run-prompt surface and the ordinary write tool refuses it. It steers the nightly attempt generator, so a write here is only accepted with allow_improve_paths: true, which is audit-logged.`;
  }
  // The policy documents are read by the Worker as authority: capsid/policy/auto-merge.md
  // says what it may merge with no human, and capsid/policy/gates.md which blocked
  // commands the seat may approve without one. So a write here is a ruling, accepted
  // only with allow_improve_paths, which needs can_touch_protected.
  if (path.startsWith(POLICY_PREFIX)) {
    return `${namespace}/${path} is an autonomy policy document. It decides what this Worker may do without a human, so a write here is a ruling. Pass allow_improve_paths: true to write it anyway; the flag needs the can_touch_protected scope and is audit-logged.`;
  }
  if (path.startsWith(SKILLS_PREFIX)) {
    return `${namespace}/${path} is an improve loop skill document, re-injected into other projects' runs, and the ordinary write tool refuses it. Pass allow_improve_paths: true to write it anyway; the flag is audit-logged.`;
  }
  if (path === SCORES_PATH) {
    const before = priorBody === null ? null : await anchorChecksum(parseScoresDoc(namespace, priorBody));
    const after = await anchorChecksum(parseScoresDoc(namespace, newBody));
    if (before !== after) {
      return `this write changes the checksummed Anchors block of ${namespace}/${SCORES_PATH}, which is the improve loop's floor. Editing a Secondary weight is fine and does not trip this; changing an anchor needs allow_improve_paths: true (audit-logged) and a human re-pin afterwards.`;
    }
  }
  return null;
}

export interface AnchorVerification {
  ok: boolean;
  // A full sentence, because it lands in the task doc a human reads.
  refusal: string | null;
  current: string;
  pinned: string | null;
}

// Fails closed in both directions. A missing pin is a refusal, not a free pass: pinning
// on first sight is how an attacker or an accident installs its own floor, since
// whatever the anchors say the first time the loop looks becomes canon. A namespace
// joins the loop when a human pins its anchors, and never before.
export async function verifyAnchors(
  kv: KVNamespace,
  namespace: string,
  doc: ScoresDoc
): Promise<AnchorVerification> {
  const current = await anchorChecksum(doc);
  let pinned: string | null = null;
  try {
    pinned = await kv.get(anchorKey(namespace));
  } catch (err) {
    return {
      ok: false,
      refusal: `could not read the anchor pin for ${namespace}: ${err instanceof Error ? err.message : String(err)}. Refusing the run rather than proceeding unpinned.`,
      current,
      pinned: null,
    };
  }
  if (doc.problems.length > 0) {
    return {
      ok: false,
      refusal: `${namespace}/improve/scores.md does not parse: ${doc.problems.join("; ")}`,
      current,
      pinned,
    };
  }
  if (!pinned) {
    return {
      ok: false,
      refusal:
        `no anchor pin for ${namespace}. A namespace joins the loop when a human pins its anchor block, never by the loop pinning what it happens to find. ` +
        `Set KV ${anchorKey(namespace)} to ${current} once the Anchors section of ${namespace}/improve/scores.md reads the way you want it to.`,
      current,
      pinned: null,
    };
  }
  if (pinned.trim().toLowerCase() !== current) {
    return {
      ok: false,
      refusal:
        `anchor checksum mismatch for ${namespace}. Pinned ${pinned.trim().toLowerCase()}, the Anchors section now hashes to ${current}. ` +
        `Nothing ran. Either the anchors were edited on purpose, in which case re-pin, or they were edited by something that should not be editing them.`,
      current,
      pinned,
    };
  }
  return { ok: true, refusal: null, current, pinned };
}

export interface AnchorVerdict {
  passed: boolean;
  reasons: string[];
}

// An unmeasured anchor is a failed anchor. A null means CI did not report the metric,
// and any missing or unauthenticated score is treated as a revert. Skipping it would let
// a scorer that stopped running the holdout suite score like one that ran it and passed.
export function anchorVerdict(anchors: AnchorSpec[], values: MetricMap): AnchorVerdict {
  const reasons: string[] = [];
  for (const spec of anchors) {
    const value = values[spec.metric];
    if (value === undefined || value === null) {
      reasons.push(`anchor ${spec.metric} was not reported`);
      continue;
    }
    if (spec.kind === "required" && !(value > 0)) {
      reasons.push(`anchor ${spec.metric} is required and reported ${value}`);
    } else if (spec.kind === "min" && spec.bound !== null && value < spec.bound) {
      reasons.push(`anchor ${spec.metric} reported ${value}, below its floor of ${spec.bound}`);
    } else if (spec.kind === "max" && spec.bound !== null && value > spec.bound) {
      reasons.push(`anchor ${spec.metric} reported ${value}, above its ceiling of ${spec.bound}`);
    }
  }
  return { passed: reasons.length === 0, reasons };
}

// Anchors that got worse than the base while still inside their bound. The drift gate
// pauses on this, because no single attempt is refused for a slow slide.
export function anchorRegressions(anchors: AnchorSpec[], before: MetricMap, after: MetricMap): string[] {
  const out: string[] = [];
  for (const spec of anchors) {
    const a = before[spec.metric];
    const b = after[spec.metric];
    if (a === undefined || a === null || b === undefined || b === null) continue;
    // Every anchor is "higher is better": required is 0 or 1, a min is a floor,
    // and a max is a ceiling on something already inverted by whoever wrote it.
    if (spec.kind === "max" ? b > a : b < a) {
      out.push(`${spec.metric} moved from ${a} to ${b}`);
    }
  }
  return out;
}

export interface MetricDelta {
  metric: string;
  direction: Direction;
  weight: number;
  before: number | null;
  after: number | null;
  // null when the metric could not be compared, with `why` saying so.
  contribution: number | null;
  why?: string;
}

export interface Comparison {
  improved: boolean;
  delta: number;
  scoreBefore: number;
  scoreAfter: number;
  // Metrics with a value on both sides. Zero means `improved` is false.
  compared: number;
  details: MetricDelta[];
  reason: string;
}

// Relative improvement, so a metric in bytes cannot drown four in counts. The
// denominator is max(|before|, 1), not |before|: a base of zero (0 lint errors) makes
// any increase a loss rather than a division by zero, and near zero, 1 error becoming
// 2 is a real doubling, not an infinite one. Clamped to [-1, 1] so one metric's
// contribution is bounded by its weight.
function relative(direction: Direction, before: number, after: number): number {
  const scale = Math.max(Math.abs(before), 1);
  const raw = direction === "maximize" ? (after - before) / scale : (before - after) / scale;
  return Math.max(-1, Math.min(1, raw));
}

// Keep or revert, and the default is revert. Kept only when the anchors hold and the
// weighted secondary score is strictly better. Strictly, not "no worse": a change that
// moves nothing is churn, so a tie reverts. When nothing could be compared (all stubs or
// unreported) the attempt reverts: the cheapest way to score well is to report nothing,
// and a system that reads silence as success rewards exactly that.
export function compare(specs: SecondarySpec[], before: MetricMap, after: MetricMap): Comparison {
  const details: MetricDelta[] = [];
  let delta = 0;
  let scoreBefore = 0;
  let scoreAfter = 0;
  let compared = 0;

  for (const spec of specs) {
    const a = before[spec.metric] ?? null;
    const b = after[spec.metric] ?? null;
    if (spec.stub) {
      details.push({ ...spec, before: a, after: b, contribution: null, why: "declared a stub, excluded until wired" });
      continue;
    }
    if (a === null || b === null) {
      details.push({
        ...spec,
        before: a,
        after: b,
        contribution: null,
        why: a === null && b === null ? "not reported on either side" : a === null ? "no baseline" : "not reported by this attempt",
      });
      continue;
    }
    const contribution = spec.weight * relative(spec.direction, a, b);
    compared += 1;
    delta += contribution;
    // Absolute scores for the improve_attempts columns, sign-corrected so higher is better.
    const sign = spec.direction === "maximize" ? 1 : -1;
    scoreBefore += spec.weight * sign * a;
    scoreAfter += spec.weight * sign * b;
    details.push({ ...spec, before: a, after: b, contribution });
  }

  if (compared === 0) {
    return {
      improved: false,
      delta: 0,
      scoreBefore,
      scoreAfter,
      compared,
      details,
      reason:
        "no secondary metric could be compared: every one was a stub or was missing on one side. " +
        "An attempt that proves nothing is reverted, because reporting nothing must never be the cheapest way to score well.",
    };
  }

  const improved = delta > 0;
  return {
    improved,
    delta,
    scoreBefore,
    scoreAfter,
    compared,
    details,
    reason: improved
      ? `secondary score improved by ${delta.toFixed(4)} across ${compared} comparable metric(s)`
      : `secondary score moved ${delta.toFixed(4)} across ${compared} comparable metric(s); a tie or a loss reverts`,
  };
}

// Not dead: the holdout suite imports it, and the holdout is invisible to any scan
// that runs here, so a scan finds no caller. Without it the holdout scores 28/30
// against an anchor of min 1.0. test/dead-exports.test.ts keeps it.
//
// It is also the canonical statement of what a scores document declares: every live
// one was generated from it, and test/null-metrics.test.ts checks its Secondary list
// against the scorer's REPORTED_SECONDARY in both directions. Only wired metrics
// appear here; the unbuilt ones are listed in capsid/improve/TASK-wire-the-metrics.md.
export function seedScoresDoc(namespace: string): string {
  return [
    `# improve scores - ${namespace}`,
    "",
    "What the improve loop measures here, and what it may never break. Written by a",
    "human, read by the Worker, never edited by the loop.",
    "",
    "## Anchors",
    "",
    "The floor. The loop may not edit this section and may not regress these values.",
    "Its sha256 is pinned in KV " + anchorKey(namespace) + " and checked before every",
    "run; a mismatch refuses the run and writes a task doc. An anchor CI did not",
    "report counts as failed, never as skipped.",
    "",
    "- build_passes: required",
    "- holdout_pass_rate: min 1.0",
    "",
    "## Secondary",
    "",
    "What the loop optimises. Edit these freely: this section is not checksummed, so",
    "adding or reweighting a metric here does not break the anchor pin. A line marked",
    "`stub` is parsed and reported and excluded from scoring until the marker is",
    "removed, so declaring an intention never scores as a zero.",
    "",
    "- test_pass_rate: maximize weight 3",
    "- lint_count: minimize weight 2",
    "- bundle_size_bytes: minimize weight 1",
    "",
  ].join("\n");
}
