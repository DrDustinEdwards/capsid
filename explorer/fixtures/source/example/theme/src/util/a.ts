import { same } from "./b";

export function pick<T>(value: T): T {
  return same(value) ? value : value;
}
