import { z, type ZodType } from "zod";
import { READ_ACTIONS } from "../scope";
import { hintsFor, READ_VIEW_HINTS } from "../tool-annotations";
import { type OperationResult, type Operations, type Shape } from "./operations";
import { toolOutput } from "./outputs";

// How a tool's spec becomes its served config and handler (src/tools/surface.ts holds the
// specs and the registrations): the merged input schema, the description and the dispatch.

interface ActionSpec {
  op: string;
  // Operation arguments the action fixes. Not exposed in the tool's schema.
  inject?: Record<string, unknown>;
  // What this action does, in the tool's description. The operation's own description
  // follows it.
  summary: string;
  // The operation arguments this action takes, where it takes fewer than the operation
  // declares (close_pr's close takes none of manage_pr's merge_method). The rest are neither
  // exposed for this action nor accepted: one sent is refused.
  fields?: readonly string[];
}

export interface CompositeSpec {
  name: string;
  title: string;
  summary: string;
  actions: Record<string, ActionSpec>;
  // The action an omitted `action` means. A tool with none requires it.
  defaultAction?: string;
}

const optional = (t: ZodType): boolean => t.safeParse(undefined).success;

// A schema's shape without its descriptions: two actions' `namespace` differ only in wording,
// while search's and bing's `report` differ in the values they accept.
function shapeKey(t: ZodType): string {
  const strip = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(strip)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => k !== "description")
              .map(([k, x]) => [k, strip(x)]),
          )
        : v;
  return JSON.stringify(strip(z.toJSONSchema(t, { unrepresentable: "any" })));
}

function mergedShape(ops: Operations, spec: CompositeSpec): Shape {
  const actions = Object.values(spec.actions);
  const first = new Map<string, ZodType>();
  // Every differently shaped schema a key has across the actions, so the tool's schema
  // accepts what any action does; each operation still checks its own (Operations.run).
  const variants = new Map<string, Map<string, ZodType>>();
  const requiredBy = new Map<string, number>();
  for (const a of actions) {
    for (const [key, type] of Object.entries(ops.config(a.op).inputSchema)) {
      if (a.inject && Object.hasOwn(a.inject, key)) continue;
      if (a.fields && !a.fields.includes(key)) continue;
      if (key === "action")
        throw new Error(
          `${spec.name}: operation ${a.op} takes its own 'action', which the tool's action must fix through inject`,
        );
      if (!first.has(key)) first.set(key, type as ZodType);
      const seen = variants.get(key) ?? new Map<string, ZodType>();
      const k = shapeKey(type as ZodType);
      if (!seen.has(k)) seen.set(k, type as ZodType);
      variants.set(key, seen);
      if (!optional(type as ZodType)) requiredBy.set(key, (requiredBy.get(key) ?? 0) + 1);
    }
  }
  for (const [key, seen] of variants) {
    if (seen.size > 1) {
      const types = [...seen.values()] as [ZodType, ZodType, ...ZodType[]];
      const union = z.union(types);
      first.set(key, types.every(optional) ? union.optional() : union);
    }
  }
  const names = Object.keys(spec.actions) as [string, ...string[]];
  const choice = z
    .enum(names)
    .describe(
      names.map((n) => n).join(" | ") +
        (spec.defaultAction ? `. Defaults to ${spec.defaultAction}.` : "."),
    );
  const shape: Record<string, ZodType> = {
    action: spec.defaultAction ? choice.optional() : choice,
  };
  for (const [key, type] of first) {
    const everyAction = requiredBy.get(key) === actions.length;
    shape[key] = everyAction || optional(type) ? type : type.optional();
  }
  return shape;
}

// The tool's summary, its actions, then each operation's own description once, headed by
// the actions it serves.
function describe(ops: Operations, spec: CompositeSpec): string {
  const actions = Object.entries(spec.actions);
  const list = actions
    .map(([name, a]) => (a.summary ? `${name} (${a.summary.replace(/\.$/, "")})` : name))
    .join("; ");
  const byOp = new Map<string, string[]>();
  for (const [name, a] of actions) byOp.set(a.op, [...(byOp.get(a.op) ?? []), name]);
  const details = [...byOp].map(
    ([op, names]) => `${names.map((n) => `"${n}"`).join(", ")}: ${ops.config(op).description}`,
  );
  return `${spec.summary}\n\nActions: ${list}.\n\n${details.join("\n\n")}`;
}

// The tool's config: title, description and merged input schema. The registration in
// buildServer supplies the hints, so each literal call names its own.
export function compositeConfig(ops: Operations, spec: CompositeSpec) {
  for (const a of Object.values(spec.actions))
    if (!ops.has(a.op)) throw new Error(`${spec.name}: no operation '${a.op}'`);
  // Closed (additionalProperties: false; area 11, T4), so an argument no action of the
  // tool takes is refused by the SDK, never stripped; one another action takes is
  // refused by compositeHandler, which names what this action takes.
  const namespaceActions = Object.entries(spec.actions)
    .filter(
      ([, a]) =>
        Object.hasOwn(ops.config(a.op).inputSchema, "namespace") &&
        !(a.inject && Object.hasOwn(a.inject, "namespace")) &&
        (!a.fields || a.fields.includes("namespace")),
    )
    .map(([name]) => name);
  return {
    title: spec.title,
    description: describe(ops, spec),
    inputSchema: z.strictObject(mergedShape(ops, spec)),
    outputSchema: toolOutput(Object.values(spec.actions).map((a) => a.op)),
    annotations: hintsFor(spec.name),
    namespaceActions,
  };
}

export function compositeHandler(ops: Operations, spec: CompositeSpec) {
  return async (args: Record<string, unknown>): Promise<OperationResult> => {
    const { action: asked, ...rest } = args;
    const action = typeof asked === "string" ? asked : spec.defaultAction;
    const chosen =
      action !== undefined && Object.hasOwn(spec.actions, action)
        ? spec.actions[action]
        : undefined;
    if (!chosen) {
      return {
        content: [
          {
            type: "text",
            text: `${spec.name}: unknown action ${JSON.stringify(asked)}. Use one of ${Object.keys(spec.actions).join(", ")}.`,
          },
        ],
        isError: true,
      };
    }
    // An argument this action does not take is refused, not dropped: a caller that sent
    // a sha with close meant something the call would not do.
    const fields = chosen.fields;
    const extra = fields
      ? Object.keys(rest).filter((k) => !fields.includes(k) && rest[k] !== undefined)
      : [];
    if (extra.length > 0) {
      return {
        content: [
          {
            type: "text",
            text: `${spec.name} action '${action}' does not take ${extra.join(", ")}. It takes ${fields!.join(", ")}.`,
          },
        ],
        isError: true,
      };
    }
    return ops.run(chosen.op, { ...rest, ...chosen.inject }, `${spec.name} action '${action}'`);
  };
}

// A tool that is one operation, served under its own schema, closed (area 11, T4) so an
// argument it does not take is refused rather than stripped.
export function singleConfig(
  ops: Operations,
  name: string,
  title: string,
  op: string,
  summary?: string,
) {
  const config = ops.config(op);
  return {
    title,
    description: summary ? `${summary}\n\n${config.description}` : config.description,
    inputSchema: z.strictObject(config.inputSchema),
    outputSchema: toolOutput([op]),
    annotations: hintsFor(name),
  };
}

// What a caller holding only the read grant is served of a tool whose action decides its
// grant (TOOL_GRANTS "action"): the argument that picks the action, narrowed to the
// actions that only read (READ_ACTIONS in src/scope.ts), and the arguments those take.
// The same tool and handler, so no new tool: the caller could never run the other actions
// (the handler refuses them for want of the write grant), and now cannot ask for them, so
// the tool it lists is read-only in fact and is annotated so (area 11, T7).
const READ_VIEWS: Record<string, { key: string; fields: readonly string[] }> = {
  capsid_work_jobs: {
    key: "action",
    fields: ["namespace", "status", "view", "stale", "since", "id"],
  },
  capsid_lint_namespace: { key: "mode", fields: ["namespace"] },
};

export function readViewConfig(ops: Operations, name: string, title: string, op: string) {
  const view = READ_VIEWS[name];
  const actions = READ_ACTIONS[name];
  const full = ops.config(op).inputSchema;
  const own = full[view.key];
  // Worded as checkScope words a grant refusal, since that is what it is.
  const choice = z
    .enum(actions, {
      error: `'${name}' requires the write grant for any ${view.key} but ${actions.join(", ")}.`,
    })
    .describe(
      actions.join(" | ") +
        ". This caller holds the read grant, so only the actions that read are served.",
    );
  const shape: Shape = { [view.key]: optional(own) ? choice.optional() : choice };
  for (const field of view.fields) shape[field] = full[field];
  const config = ops.config(op);
  return {
    title,
    description: `Served to this caller, which holds the read grant, with ${view.key} ${actions.join(", ")} only; the rest need the write grant.\n\n${config.description}`,
    inputSchema: z.strictObject(shape),
    outputSchema: toolOutput([op]),
    annotations: READ_VIEW_HINTS[name],
  };
}

export function singleHandler(ops: Operations, name: string, op: string) {
  return (args: Record<string, unknown>): Promise<OperationResult> => ops.run(op, args ?? {}, name);
}
