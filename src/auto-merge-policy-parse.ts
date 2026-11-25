import { onRoster } from "./roster";
import { POLICY_ID_ITEM, policyField } from "./signed-docs";

export interface MergePolicy {
  version: string;
  enabled: boolean;
  namespaces: string[];
  checks: string[];
  refusedPaths: string[];
  allowedPaths: string[];
  authors: string[];
  units: string[];
  requiredCi: string[];
}

const PATH_ITEM = /^- path `([^`]+)`/;
const STEP_ITEM = /^- step `([^`]+)`/;
const AUTHOR_ITEM = /^- author `([^`]+)`/;
const ALLOW_ITEM = /^- allow `([^`]+)`/;
const UNIT_ITEM = /^- unit `([^`]+)`/;
const UNITS_HEADING = /^##\s+Auto units\s*$/i;

const PROMOTABLE_PATH_CLASSES: readonly string[] = [
  "docs",
  "dashboard-css",
  "tests",
  "dashboard-code",
  "deps-own",
  "src-routine",
  "deps-other",
  "src-worth",
];
// The heading a required step is filed under: `## Required CI, <namespace>`. A step written before
// any such heading is a refusal rather than a step belonging to whichever namespace came first.
const CI_HEADING = /^##\s+Required CI,\s*([a-z0-9-]+)\s*$/i;
// The heading an allowed path is filed under: `## Allowed paths, <namespace>`. Same rule: an
// allowed path under no such heading is a refusal, never a limit on some namespace.
const ALLOW_HEADING = /^##\s+Allowed paths,\s*([a-z0-9-]+)\s*$/i;

export function parseMergePolicy(body: string): { policy: MergePolicy } | { error: string } {
  const version = policyField(body, "version");
  if (!version) {
    return {
      error:
        "the policy document names no version. A merge audited against an unnamed policy cannot be traced to what it allowed.",
    };
  }
  const enabled = policyField(body, "enabled");
  if (enabled === null) return { error: "the policy document does not say whether it is enabled." };
  const namespaces = (policyField(body, "namespaces") ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (namespaces.length === 0)
    return { error: "the policy document covers no namespaces, so it authorizes nothing." };
  const unknown = namespaces.filter((n) => !onRoster(n));
  if (unknown.length > 0) {
    return {
      error: `the policy names ${unknown.join(", ")}, which is not on the roster. A policy cannot widen the set of repos this Worker reaches.`,
    };
  }
  const checks: string[] = [];
  const refusedPaths: string[] = [];
  const authors: string[] = [];
  const requiredCi: string[] = [];
  const allowedPaths: string[] = [];
  const units: string[] = [];
  let ciNamespace: string | null = null;
  let allowNamespace: string | null = null;
  let inUnits = false;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    // Any heading closes the section, so a step under `## What a merge means` is not filed under the
    // last namespace that appeared above it.
    if (trimmed.startsWith("##")) {
      const heading = CI_HEADING.exec(trimmed);
      ciNamespace = heading ? heading[1] : null;
      const allowHeading = ALLOW_HEADING.exec(trimmed);
      allowNamespace = allowHeading ? allowHeading[1] : null;
      inUnits = UNITS_HEADING.test(trimmed);
      continue;
    }
    const unitItem = UNIT_ITEM.exec(trimmed);
    if (unitItem) {
      if (!inUnits)
        return {
          error: `the policy lists unit '${unitItem[1]}' outside the ## Auto units section, so whether it is promoted is unstated.`,
        };
      const m = /^([a-z0-9-]+)\s*\/\s*([a-z-]+)$/.exec(unitItem[1]!.trim());
      if (!m)
        return { error: `the policy's unit '${unitItem[1]}' is not '<namespace> / <path class>'.` };
      const [, ns, cls] = m;
      if (!PROMOTABLE_PATH_CLASSES.includes(cls!)) {
        return {
          error: `the policy's unit '${unitItem[1]}' names path class '${cls}', which is ${cls === "money" || cls === "migration" || cls === "workflow" ? "never promoted to auto" : "not a path class this Worker knows"}. Refusing the whole document rather than guessing what it widens.`,
        };
      }
      if (!namespaces.includes(ns!))
        return {
          error: `the policy's unit '${unitItem[1]}' names ${ns}, which the policy does not cover.`,
        };
      const unit = `${ns} / ${cls}`;
      if (units.includes(unit)) return { error: `the policy lists unit '${unit}' twice.` };
      units.push(unit);
      continue;
    }
    const check = POLICY_ID_ITEM.exec(trimmed);
    if (check) checks.push(check[1]);
    const path = PATH_ITEM.exec(trimmed);
    if (path) refusedPaths.push(path[1]);
    const author = AUTHOR_ITEM.exec(trimmed);
    if (author) authors.push(author[1]);
    const step = STEP_ITEM.exec(trimmed);
    if (step) {
      if (!ciNamespace) {
        return {
          error: `the policy lists required CI step '${step[1]}' under no namespace heading, so which repo's CI it describes is unstated.`,
        };
      }
      requiredCi.push(`${ciNamespace} / ${step[1]}`);
    }
    const allow = ALLOW_ITEM.exec(trimmed);
    if (allow) {
      if (!allowNamespace) {
        return {
          error: `the policy lists allowed path '${allow[1]}' under no namespace heading, so which namespace it limits is unstated.`,
        };
      }
      allowedPaths.push(`${allowNamespace} / ${allow[1]}`);
    }
  }
  // Fails closed: a document with no author allowlist loads nothing.
  if (authors.length === 0) {
    return {
      error:
        "the policy document names no PR author, so it authorizes no pull request. Refusing rather than merging with no author allowlist.",
    };
  }
  return {
    policy: {
      version,
      enabled: enabled.toLowerCase() === "true",
      namespaces,
      checks,
      refusedPaths,
      allowedPaths,
      authors,
      requiredCi,
      units,
    },
  };
}
