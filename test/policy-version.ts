import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The version the shipped docs/policy/auto-merge.md says, so a test never hard-codes one. */
export const SHIPPED_VERSION = Number(
  /^- version: (\d+)$/m.exec(
    readFileSync(join(import.meta.dirname, "..", "docs", "policy", "auto-merge.md"), "utf8"),
  )![1],
);
