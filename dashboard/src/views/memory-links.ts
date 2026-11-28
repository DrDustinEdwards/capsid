import { routePath } from "../app/ctx";

/** One document in Memory, by its namespace and path. */
export function memoryDocHref(ns: string, path: string): string {
  return `${routePath("memory")}?${new URLSearchParams({ doc: `${ns}/${path}` }).toString()}`;
}
