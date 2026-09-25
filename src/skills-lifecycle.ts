// The skill lifecycle as pure rules. A skill's status changes on evaluation evidence,
// never on a driver's judgement of its own run. Based on SkillOpt (arXiv 2605.23904:
// enough evidence before an edit, bounded edits, slow update) and SkillsVote (arXiv
// 2605.18401: credit a skill only when it was used and the verifier says the run
// succeeded).

const SKILL_STATUSES = ["candidate", "live", "retired"] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

const VERDICTS = ["positive", "neutral", "negative"] as const;
export type Verdict = (typeof VERDICTS)[number];

// Minimum evidence for any status change, in either direction. One evaluation is a
// sample, and acting on it would promote and retire the same skill on noise.
const MIN_EVALUATIONS = 2;

// A delta at or below this counts as no improvement: a tie is not an improvement.
const POSITIVE_DELTA = 0;

export interface Evaluation {
  skill: string;
  version: number;
  namespace: string;
  probe_set_version: string;
  delta: number;
  runs: number;
  verdict: Verdict;
  evaluated_at: string;
}

/** Whether a stored string is a status this code knows. Anything else is refused
 *  rather than coerced. */
export function isSkillStatus(value: string): value is SkillStatus {
  return (SKILL_STATUSES as readonly string[]).includes(value);
}

/** The same, for a stored verdict. */
export function isVerdict(value: string): value is Verdict {
  return (VERDICTS as readonly string[]).includes(value);
}

/** The verdict a delta earns. Derived once, at write time, and then stored. */
export function verdictFor(delta: number): Verdict {
  if (delta > POSITIVE_DELTA) return "positive";
  if (delta < POSITIVE_DELTA) return "negative";
  return "neutral";
}

export type Transition =
  | { change: false; reason: string }
  | { change: true; from: SkillStatus; to: SkillStatus; reason: string };

/**
 * What a skill's evaluations say its status should be.
 *
 * Candidate to live needs two positive evaluations. Live to retired needs two
 * consecutive non-positive ones, so a live skill alternating positive and neutral
 * stays live.
 *
 * Evaluations are counted at one version and one probe set version, since deltas
 * across either are not comparable. An accepted edit therefore costs the skill its
 * accumulated evidence.
 */
export function nextStatus(
  current: SkillStatus,
  version: number,
  evaluations: readonly Evaluation[]
): Transition {
  if (current === "retired") {
    return { change: false, reason: "a retired skill stays retired; its record is kept as evidence about what did not work." };
  }

  const atVersion = evaluations
    .filter((e) => e.version === version)
    .slice()
    .sort((a, b) => a.evaluated_at.localeCompare(b.evaluated_at));

  if (atVersion.length < MIN_EVALUATIONS) {
    return {
      change: false,
      reason: `version ${version} has ${atVersion.length} evaluation(s) and a status change needs ${MIN_EVALUATIONS}. One result is a sample, not evidence.`,
    };
  }

  // One probe set, or the deltas are not comparable. The newest probe set version
  // wins and older rows are ignored rather than mixed in.
  const newestProbe = atVersion[atVersion.length - 1].probe_set_version;
  const comparable = atVersion.filter((e) => e.probe_set_version === newestProbe);
  if (comparable.length < MIN_EVALUATIONS) {
    return {
      change: false,
      reason: `version ${version} has ${comparable.length} evaluation(s) against probe set ${newestProbe}, and deltas from different probe sets are not comparable.`,
    };
  }

  if (current === "candidate") {
    const positives = comparable.filter((e) => e.verdict === "positive").length;
    if (positives >= MIN_EVALUATIONS) {
      return {
        change: true,
        from: "candidate",
        to: "live",
        reason: `${positives} positive evaluations of version ${version} against probe set ${newestProbe}.`,
      };
    }
    return {
      change: false,
      reason: `version ${version} has ${positives} positive evaluation(s) of ${comparable.length}; promotion needs ${MIN_EVALUATIONS}.`,
    };
  }

  // live: two CONSECUTIVE non-positive evaluations, measured from the newest end.
  const tail = comparable.slice(-MIN_EVALUATIONS);
  if (tail.length === MIN_EVALUATIONS && tail.every((e) => e.verdict !== "positive")) {
    return {
      change: true,
      from: "live",
      to: "retired",
      reason: `${MIN_EVALUATIONS} consecutive non-positive evaluations of version ${version} (${tail.map((e) => e.verdict).join(", ")}).`,
    };
  }
  return { change: false, reason: `the most recent evaluations of version ${version} are not ${MIN_EVALUATIONS} consecutive non-positive ones.` };
}

// At most this fraction of L2 lines per edit. A wholesale rewrite would replace the
// skill, and its accumulated evaluations would describe a document that is gone.
const MAX_EDIT_FRACTION = 0.2;

export type EditOp =
  | { op: "add"; line: number; text: string }
  | { op: "delete"; line: number }
  | { op: "replace"; line: number; text: string };

export type EditVerdict = { ok: true; touched: number; allowed: number } | { ok: false; reason: string };

/** Whether a set of operations stays inside the bound. Counts distinct lines touched,
 *  against the body the edit starts from. */
export function withinEditBound(l2: string, ops: readonly EditOp[]): EditVerdict {
  const lines = l2.split("\n").length;
  if (ops.length === 0) return { ok: false, reason: "an edit with no operations changes nothing and is not evaluated." };
  // At least one line, so a short skill is editable; floor, not round.
  const allowed = Math.max(1, Math.floor(lines * MAX_EDIT_FRACTION));
  const touched = new Set(ops.map((o) => o.line)).size;
  const outOfRange = ops.filter((o) => o.line < 1 || o.line > lines);
  if (outOfRange.length > 0) {
    return { ok: false, reason: `operation(s) name line(s) outside the ${lines}-line body: ${outOfRange.map((o) => o.line).join(", ")}.` };
  }
  if (touched > allowed) {
    return {
      ok: false,
      reason: `this edit touches ${touched} of ${lines} lines and the bound is ${allowed} (${Math.round(MAX_EDIT_FRACTION * 100)} percent). An optimizer that can rewrite a skill wholesale is replacing it, not editing it.`,
    };
  }
  return { ok: true, touched, allowed };
}

/** Whether an evaluated edit is accepted. Strict improvement only: a tie still costs
 *  the skill its evaluation history. */
export function acceptEdit(deltaBefore: number, deltaAfter: number): { accepted: boolean; reason: string } {
  if (deltaAfter > deltaBefore) {
    return { accepted: true, reason: `the edited version scored ${deltaAfter} against ${deltaBefore} for the current one.` };
  }
  if (deltaAfter === deltaBefore) {
    return {
      accepted: false,
      reason: `the edited version scored the same as the current one (${deltaAfter}). A tie is a rejection: the edit would reset this skill's evaluation history for no measured gain.`,
    };
  }
  return { accepted: false, reason: `the edited version scored ${deltaAfter} against ${deltaBefore} for the current one.` };
}

// Why a run ended, from the verifier rather than the driver. `improvised`: the run
// succeeded without using the offered skill.
export type RunSignal = "verified-success" | "verified-failure" | "improvised" | "environment-failure";

export type Attribution = { credit: "win" | "loss" | "none"; reason: string };

/**
 * Whether one offered skill earns anything from one run.
 *
 * A skill moves only when it was used and the verifier reported on the work itself,
 * not on an environment failure.
 */
export function attribute(used: boolean, signal: RunSignal): Attribution {
  if (!used) {
    return { credit: "none", reason: "the skill was offered and not used, so the outcome is not evidence about it." };
  }
  switch (signal) {
    case "verified-success":
      return { credit: "win", reason: "the skill was used and the verifier reported success." };
    case "verified-failure":
      return { credit: "loss", reason: "the skill was used and the verifier reported failure." };
    case "improvised":
      return { credit: "none", reason: "the run succeeded without following the skill, so the success is not the skill's." };
    case "environment-failure":
      return {
        credit: "none",
        reason: "the run failed on the environment rather than on the work, so it says nothing about the skill.",
      };
  }
}

// Below this fraction of differing lines, two live skills with overlapping triggers
// are near-duplicates and a merge is proposed.
export const MERGE_DIFFERENCE_THRESHOLD = 0.1;

/** Fraction of lines that differ between two bodies, by the longer of the two. */
export function bodyDifference(a: string, b: string): number {
  const left = a.split("\n").map((l) => l.trim());
  const right = b.split("\n").map((l) => l.trim());
  const longer = Math.max(left.length, right.length);
  if (longer === 0) return 0;
  const shared = new Set(right);
  let same = 0;
  for (const line of left) {
    if (shared.has(line)) same += 1;
  }
  return (longer - same) / longer;
}

export function shouldProposeMerge(
  a: { status: SkillStatus; trigger: string; body: string },
  b: { status: SkillStatus; trigger: string; body: string }
): { merge: boolean; reason: string } {
  if (a.status !== "live" || b.status !== "live") {
    return { merge: false, reason: "only two live skills are merged; a candidate has not earned its place yet and a retired one is a record." };
  }
  if (!triggersOverlap(a.trigger, b.trigger)) {
    return { merge: false, reason: "the triggers do not overlap, so the two fire on different work." };
  }
  const difference = bodyDifference(a.body, b.body);
  if (difference >= MERGE_DIFFERENCE_THRESHOLD) {
    return { merge: false, reason: `the bodies differ by ${Math.round(difference * 100)} percent, at or above the ${Math.round(MERGE_DIFFERENCE_THRESHOLD * 100)} percent threshold, so they are saying different things.` };
  }
  return { merge: true, reason: `two live skills with overlapping triggers whose bodies differ by ${Math.round(difference * 100)} percent.` };
}

// Word overlap rather than string equality. Crude on purpose: the output is a
// proposal a human reviews.
const STOP_WORDS = new Set(["a", "an", "the", "is", "are", "of", "to", "in", "on", "and", "or", "for", "when", "with", "that", "this", "it"]);

export function triggersOverlap(a: string, b: string): boolean {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    );
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) shared += 1;
  }
  return shared / Math.min(left.size, right.size) >= 0.5;
}
