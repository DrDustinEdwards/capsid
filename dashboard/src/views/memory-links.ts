import { routePath } from "../app/ctx";

export function memoryDocHref(ns: string, path: string): string {
  return `${routePath("memory")}?${new URLSearchParams({ doc: `${ns}/${path}` }).toString()}`;
}
