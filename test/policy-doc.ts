import {
  AUTO_MERGE_ALLOWED_PATHS,
  AUTO_MERGE_REFUSED_PATHS,
  AUTO_MERGE_REQUIRED_CI,
  POLICY_CHECKS,
  requiredCiLabel,
} from "../src/auto-merge-policy";

export const policyDocument = (
  version: string | number,
  { enabled = true, authors = ["DrDustinEdwards"] } = {},
): string =>
  [
    "# Auto-merge policy",
    "",
    `- version: ${version}`,
    `- enabled: ${enabled}`,
    "- namespaces: capsid",
    "",
    "## Checks",
    "",
    ...POLICY_CHECKS.map((c) => `- \`${c}\` refuses on its own.`),
    "",
    "## Allowed PR authors",
    "",
    ...authors.map((a) => `- author \`${a}\``),
    "",
    "## Refused paths",
    "",
    ...AUTO_MERGE_REFUSED_PATHS.map((p) => `- path \`${p.pattern.source}\` ${p.why}`),
    "",
    ...Object.entries(AUTO_MERGE_ALLOWED_PATHS).flatMap(([ns, rows]) => [
      `## Allowed paths, ${ns}`,
      "",
      ...rows.map((r) => `- allow \`${r.pattern.source}\` ${r.why}`),
      "",
    ]),
    // loadMergePolicy compares the document's steps with the code's in both directions.
    ...Object.entries(AUTO_MERGE_REQUIRED_CI).flatMap(([ns, rows]) => [
      `## Required CI, ${ns}`,
      "",
      ...rows.map((r) => `- step \`${requiredCiLabel(r)}\``),
      "",
    ]),
  ].join("\n");
