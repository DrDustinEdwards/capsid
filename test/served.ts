import { COMPOSITES, SINGLE_TOOLS } from "../src/tools/surface.ts";
import { requiredForAction, type ToolRequirement } from "../src/scope.ts";

// Which served tool and action runs each operation, and what that action requires, read
// from the surface itself (src/tools/surface.ts), so the scanners follow the surface
// rather than a copy of it.

export interface Served {
  tool: string;
  action: string | undefined;
  requirement: ToolRequirement;
}

export function servedAs(op: string): Served[] {
  const out: Served[] = [];
  for (const [tool, single] of Object.entries(SINGLE_TOOLS)) {
    if (single.op === op) out.push({ tool, action: undefined, requirement: requiredForAction(tool, undefined) });
  }
  for (const spec of COMPOSITES) {
    for (const [action, a] of Object.entries(spec.actions)) {
      if (a.op === op) out.push({ tool: spec.name, action, requirement: requiredForAction(spec.name, action) });
    }
  }
  return out;
}

/** Every operation a served tool runs, with the tool and action. */
export function servedOperations(): Array<Served & { op: string }> {
  const out: Array<Served & { op: string }> = [];
  for (const [tool, single] of Object.entries(SINGLE_TOOLS)) out.push({ op: single.op, tool, action: undefined, requirement: requiredForAction(tool, undefined) });
  for (const spec of COMPOSITES) {
    for (const [action, a] of Object.entries(spec.actions)) out.push({ op: a.op, tool: spec.name, action, requirement: requiredForAction(spec.name, action) });
  }
  return out;
}
