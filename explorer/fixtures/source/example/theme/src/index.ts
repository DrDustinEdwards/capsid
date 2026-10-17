import { pick } from "./util/a";
import type { Token } from "./tokens";

export function choose(tokens: Token[], dark: boolean, wide: boolean): Token | undefined {
  for (const t of tokens) {
    if (dark && t.dark) return t;
    if (wide && t.wide) return t;
    if (!dark && !wide) return pick(t);
  }
  return undefined;
}
