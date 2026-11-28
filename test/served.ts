import { COMPOSITES, SINGLE_TOOLS } from "../src/tools/surface.ts";
import { requiredForAction, type ToolRequirement } from "../src/scope.ts";

export interface Served {
  tool: string;
  action: string | undefined;
  requirement: ToolRequirement;
}

export function servedOperations(): Array<Served & { op: string }> {
  const out: Array<Served & { op: string }> = [];
  for (const [tool, single] of Object.entries(SINGLE_TOOLS))
    out.push({
      op: single.op,
      tool,
      action: undefined,
      requirement: requiredForAction(tool, undefined),
    });
  for (const spec of COMPOSITES) {
    for (const [action, a] of Object.entries(spec.actions))
      out.push({
        op: a.op,
        tool: spec.name,
        action,
        requirement: requiredForAction(spec.name, action),
      });
  }
  return out;
}

export const servedAs = (op: string): Served[] => servedOperations().filter((s) => s.op === op);
