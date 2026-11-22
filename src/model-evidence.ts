import { JOB_KINDS, MODELS, ROUTING_RULES, TRIAL_ARMS, type RoutedModel } from "./model-routing";
import { formatMoney } from "@dustinedwards/site-runtime/money";

// What the outcomes say about the routing rules (src/model-routing.ts). Reads only.

// A cell (kind, model) is read only from this many outcomes. Below it a rate is noise: a
// single merged job reads as 100 percent.
export const MIN_SAMPLE = 10;
// A model whose merged-with-green rate for a kind is under this, with enough outcomes,
// is a reason to propose a more capable one.
export const RATE_FLOOR = 0.6;
// How much better a more capable model's rate must be before it is proposed.
export const RATE_GAIN = 0.1;

export interface OutcomeFact {
  kind: string | null;
  // The model Capsid chose (job_outcomes.model_chosen). The session's own model_id only
  // leaves an outcome out when it names another model (src/model-learning.ts).
  model: string | null;
  prs_merged: number | null;
  ci_green: number | null;
  corrections: number | null;
  cost_usd: number | null;
  tokens: number | null;
  // Its pull request was later reverted, or its deploy rolled back (src/model-learning.ts).
  undone?: boolean;
}

export interface Cell {
  kind: string;
  model: string;
  n: number;
  // Jobs with a verified merge and green CI that was not later reverted or rolled back, over n.
  merged_green: number;
  rate: number;
  corrections_mean: number | null;
  cost_mean_usd: number | null;
  cost_n: number;
  // Below MIN_SAMPLE: shown, never acted on.
  enough: boolean;
}

/** The alias a model id reduces to: "claude-opus-5-5" and "opus" are both opus. A
 *  model it does not recognize is kept as reported, so it shows as its own cell. */
export function modelAlias(id: string | null): string | null {
  if (!id) return null;
  const lower = id.toLowerCase();
  for (const alias of ["opusplan", "opus", "sonnet", "haiku"] as const)
    if (lower.includes(alias)) return alias;
  return lower.slice(0, 64);
}

export function cellsOf(facts: readonly OutcomeFact[]): Cell[] {
  const groups = new Map<string, OutcomeFact[]>();
  for (const f of facts) {
    const model = modelAlias(f.model);
    if (!f.kind || !model) continue;
    const key = `${f.kind}\u0000${model}`;
    groups.set(key, [...(groups.get(key) ?? []), { ...f, model }]);
  }
  const cells: Cell[] = [];
  for (const [key, rows] of groups) {
    const [kind, model] = key.split("\u0000") as [string, string];
    const good = rows.filter(
      (r) => (r.prs_merged ?? 0) >= 1 && r.ci_green === 1 && !r.undone,
    ).length;
    const corr = rows.filter((r) => r.corrections !== null);
    const costed = rows.filter((r) => r.cost_usd !== null);
    cells.push({
      kind,
      model,
      n: rows.length,
      merged_green: good,
      rate: good / rows.length,
      corrections_mean: corr.length
        ? corr.reduce((s, r) => s + (r.corrections ?? 0), 0) / corr.length
        : null,
      cost_mean_usd: costed.length
        ? costed.reduce((s, r) => s + (r.cost_usd ?? 0), 0) / costed.length
        : null,
      cost_n: costed.length,
      enough: rows.length >= MIN_SAMPLE,
    });
  }
  return cells.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      MODELS.indexOf(a.model as RoutedModel) - MODELS.indexOf(b.model as RoutedModel),
  );
}

export interface Proposal {
  kind: string;
  from: string;
  to: string;
  why: string;
}

const rank = (model: string): number => MODELS.indexOf(model as RoutedModel);

/** Rule changes the evidence supports, never applied: the seat approves each. Only cells
 *  with MIN_SAMPLE outcomes count. A cheaper model is proposed when it did as well as the
 *  current one (the one the kind's routine rule names); a more capable one when the current
 *  is under the floor and the other is clearly better. */
export function proposeRuleChanges(cells: readonly Cell[]): Proposal[] {
  const out: Proposal[] = [];
  for (const kind of JOB_KINDS) {
    const rule =
      ROUTING_RULES.find((r) => r.when.kind === kind) ?? ROUTING_RULES[ROUTING_RULES.length - 1]!;
    const current = cells.find((c) => c.kind === kind && c.model === rule.model && c.enough);
    if (!current) continue;
    const others = cells.filter((c) => c.kind === kind && c.model !== rule.model && c.enough);
    const cheaper = others
      .filter(
        (c) => rank(c.model) >= 0 && rank(c.model) < rank(rule.model) && c.rate >= current.rate,
      )
      .sort((a, b) => rank(a.model) - rank(b.model))[0];
    if (cheaper) {
      out.push({
        kind,
        from: rule.model,
        to: cheaper.model,
        why: `${cheaper.model} merged green ${cheaper.merged_green}/${cheaper.n} against ${current.merged_green}/${current.n} on ${rule.model}`,
      });
      continue;
    }
    const stronger = others
      .filter((c) => rank(c.model) > rank(rule.model) && c.rate >= current.rate + RATE_GAIN)
      .sort((a, b) => b.rate - a.rate)[0];
    if (current.rate < RATE_FLOOR && stronger) {
      out.push({
        kind,
        from: rule.model,
        to: stronger.model,
        why: `${rule.model} merged green ${current.merged_green}/${current.n}, under ${RATE_FLOOR * 100} percent, and ${stronger.model} ${stronger.merged_green}/${stronger.n}`,
      });
    }
  }
  return out;
}

export interface TrialStatus {
  kind: string;
  model: string;
  against: string;
  percent: number;
  n: number;
  against_n: number;
  // "collecting" until both cells hold MIN_SAMPLE outcomes; then whether the evidence
  // supports moving the kind's rule to the arm's model. Never applied here.
  verdict: "collecting" | "supports" | "does not support";
  why: string;
}

const money = (usd: number | null): string =>
  usd === null ? "no cost recorded" : `${formatMoney(usd, "usd", { scale: 0 })} a job`;

/** Each trial arm read against its kind's rule: what it has collected and whether the
 *  evidence supports the rule change. "supports" holds exactly when proposeRuleChanges
 *  proposes that change; the seat makes the edit. */
export function trialStatus(cells: readonly Cell[]): TrialStatus[] {
  const proposals = proposeRuleChanges(cells);
  return TRIAL_ARMS.map((arm) => {
    const rule = ROUTING_RULES.find((r) => r.when.kind === arm.kind)!;
    const mine = cells.find((c) => c.kind === arm.kind && c.model === arm.model);
    const theirs = cells.find((c) => c.kind === arm.kind && c.model === rule.model);
    const base = {
      kind: arm.kind,
      model: arm.model,
      against: rule.model,
      percent: arm.percent,
      n: mine?.n ?? 0,
      against_n: theirs?.n ?? 0,
    };
    if (!mine?.enough || !theirs?.enough) {
      return {
        ...base,
        verdict: "collecting" as const,
        why: `${base.n} of ${MIN_SAMPLE} outcomes on ${arm.model} and ${base.against_n} of ${MIN_SAMPLE} on ${rule.model}; nothing is read from fewer`,
      };
    }
    const scores = `${arm.model} merged green ${mine.merged_green}/${mine.n} at ${money(mine.cost_mean_usd)}, ${rule.model} ${theirs.merged_green}/${theirs.n} at ${money(theirs.cost_mean_usd)}`;
    const proposed = proposals.some((p) => p.kind === arm.kind && p.to === arm.model);
    return proposed
      ? {
          ...base,
          verdict: "supports" as const,
          why: `${scores}: the evidence supports moving ${arm.kind} to ${arm.model}, for the seat to approve`,
        }
      : {
          ...base,
          verdict: "does not support" as const,
          why: `${scores}: ${arm.kind} stays on ${rule.model}`,
        };
  });
}
