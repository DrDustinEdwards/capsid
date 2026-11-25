import { JOB_KINDS, MODELS, ROUTING_RULES, TRIAL_ARMS, type RoutedModel } from "./model-routing";

// Below this many outcomes a rate is noise: one merged job reads as 100 percent.
export const MIN_SAMPLE = 10;
export const RATE_FLOOR = 0.6;
export const RATE_GAIN = 0.1;

export interface OutcomeFact {
  kind: string | null;
  // The model Capsid chose; the session's own model_id only drops an outcome when it names another model (src/model-learning.ts).
  model: string | null;
  prs_merged: number | null;
  ci_green: number | null;
  corrections: number | null;
  undone?: boolean;
}

export interface Cell {
  kind: string;
  model: string;
  n: number;
  merged_green: number;
  rate: number;
  corrections_mean: number | null;
  enough: boolean;
}

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
    cells.push({
      kind,
      model,
      n: rows.length,
      merged_green: good,
      rate: good / rows.length,
      corrections_mean: corr.length
        ? corr.reduce((s, r) => s + (r.corrections ?? 0), 0) / corr.length
        : null,
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

// Never applied: the seat approves each. A cheaper model is proposed when it did as well as the current one;
// a more capable one when the current is under the floor and the other clearly better.
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
  // "collecting" until both cells hold MIN_SAMPLE outcomes; never applied here.
  verdict: "collecting" | "supports" | "does not support";
  why: string;
}

// "supports" holds exactly when proposeRuleChanges proposes that change.
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
    const scores = `${arm.model} merged green ${mine.merged_green}/${mine.n}, ${rule.model} ${theirs.merged_green}/${theirs.n}`;
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
