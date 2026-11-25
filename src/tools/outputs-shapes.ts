import { z, type ZodType } from "zod";
import type { Shape } from "./operations";

export const obj = z.looseObject({});
export const rows = z.array(obj);
export const str = z.string();
export const num = z.number();
export const bool = z.boolean();
export const strs = z.array(z.string());
export const nullable = (t: ZodType) => t.nullable();

// A key every variant returns is required; the rest are optional. A key whose type
// differs between variants takes either.
export function mergeOutputs(shapes: readonly Shape[]): Shape {
  const types = new Map<string, Map<string, ZodType>>();
  const present = new Map<string, number>();
  for (const shape of shapes) {
    for (const [key, type] of Object.entries(shape)) {
      const inner = type instanceof z.ZodOptional ? (type.unwrap() as ZodType) : type;
      const seen = types.get(key) ?? new Map<string, ZodType>();
      seen.set(JSON.stringify(z.toJSONSchema(inner, { unrepresentable: "any" })), inner);
      types.set(key, seen);
      if (!type.safeParse(undefined).success) present.set(key, (present.get(key) ?? 0) + 1);
    }
  }
  const merged: Shape = {};
  for (const [key, seen] of types) {
    const list = [...seen.values()];
    const type = list.length === 1 ? list[0] : z.union(list as [ZodType, ZodType, ...ZodType[]]);
    merged[key] = present.get(key) === shapes.length ? type : type.optional();
  }
  return merged;
}
