import type { Agent } from "./agents";
import type { ActionParams, Surface } from "./controls-base";
import type { Env } from "./env";

export function required(params: ActionParams, field: string): string | null {
  const value = params[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type ActionResult =
  | { ok: true; summary: string; warning: string | null }
  | { ok: false; refusal: string };

/**
 * One action in flight: the caller, the click's audit writer, and `state`, which a mutator sets
 * once it has run so the catch knows whether the action happened. `warning` is a done action's
 * caveat the Portal shows beside the success.
 */
export type PerformContext = {
  env: Env;
  agent: Agent;
  actor: string;
  now: Date;
  params: ActionParams;
  surface: Surface;
  switchReason: string | null;
  undo: boolean;
  click: string;
  state: { committed: boolean; summary: string; warning: string | null };
  auditClick: (namespace: string | null, detail: object, name?: string) => Promise<void>;
  switchDetail: (result: object) => object;
};
