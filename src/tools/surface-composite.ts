import { z, type ZodType } from "zod";
import { READ_ACTIONS } from "../scope";
import { hintsFor, READ_VIEW_HINTS } from "../tool-annotations";
import { type OperationResult, type Operations, type Shape } from "./operations";
import { toolOutput } from "./outputs";

interface ActionSpec {
  op: string;
  inject?: Record<string, unknown>;
  summary: string;
  // Narrower than the operation: the rest are neither exposed for this action nor accepted (one
  // sent is refused).
  fields?: readonly string[];
}

export interface CompositeSpec {
  name: string;
  title: string;
  summary: string;
  actions: Record<string, ActionSpec>;
  defaultAction?: string;
}

const optional = (t: ZodType): boolean => t.safeParse(undefined).success;

// Descriptions are left out: two actions' `namespace` differ only in wording, while search's and
// bing's `report` differ in accepted values.
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
  // Every differently shaped schema a key has across actions, so the tool accepts what any does;
  // each operation still checks its own.
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

export function compositeConfig(ops: Operations, spec: CompositeSpec) {
  for (const a of Object.values(spec.actions))
    if (!ops.has(a.op)) throw new Error(`${spec.name}: no operation '${a.op}'`);
  // Closed: an argument no action takes is refused by the SDK, never stripped; one another action
  // takes is refused by compositeHandler, naming what this action takes.
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
    // Refused, not dropped: a caller that sent a sha with close meant something the call would not
    // do.
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

// A caller holding only the read grant is served the read view of a tool whose action decides its
// grant: same tool and handler, action narrowed to READ_ACTIONS, so the listed tool is read-only in
// fact and annotated so (area 11, T7).
const READ_VIEWS: Record<string, { key: string; fields: readonly string[] }> = {
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
