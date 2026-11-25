// The reviewer model's answer (review.ts): the verdict and finding shapes and reading them back.

export const MAX_FINDINGS = 5;

const VERDICTS = ["APPROVE", "CHANGES", "BLOCK"] as const;
export type Verdict = (typeof VERDICTS)[number];
const FINDING_KINDS = [
  "misread job",
  "skipped requirement",
  "weak test",
  "bug",
  "security",
] as const;
type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
  kind: FindingKind;
  file: string;
  line: number | null;
  note: string;
}

// The answer as structured output: one call of this tool, its arguments read whole. DeepSeek
// V4.1 Flash supports function calling on Workers AI; JSON mode does not list it yet.
export const REPORT_TOOL = {
  type: "function",
  function: {
    name: "report_review",
    description: "Report the review of this pull request.",
    parameters: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: [...VERDICTS] },
        summary: { type: "string", description: "One or two plain sentences." },
        findings: {
          type: "array",
          maxItems: MAX_FINDINGS,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...FINDING_KINDS] },
              file: { type: "string", description: "A path from the diff." },
              line: {
                type: ["integer", "null"],
                description: "The line in the new file, or null.",
              },
              note: {
                type: "string",
                description: "What is wrong and why, in one or two sentences.",
              },
            },
            required: ["kind", "file", "line", "note"],
          },
        },
      },
      required: ["verdict", "summary", "findings"],
    },
  },
} as const;

// The arguments of the model's report_review call, in either answer shape Workers AI gives (its own
// `tool_calls`, or the OpenAI `choices`), parsed whole. Null when there is none.
export function toolArguments(answer: unknown): unknown {
  const a = answer as {
    tool_calls?: Array<{
      name?: string;
      arguments?: unknown;
      function?: { name?: string; arguments?: unknown };
    }>;
    choices?: Array<{
      message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
    }>;
  } | null;
  const calls = [...(a?.tool_calls ?? []), ...(a?.choices?.[0]?.message?.tool_calls ?? [])];
  const call = calls.find(
    (c) => ((c as { name?: string }).name ?? c.function?.name) === "report_review",
  );
  const args =
    (call as { arguments?: unknown } | undefined)?.arguments ?? call?.function?.arguments;
  if (typeof args !== "string") return args ?? null;
  try {
    return JSON.parse(args);
  } catch {
    return null;
  }
}

/** Whether the model stopped at max_tokens, which leaves no tool call to read. */
export function ranOut(answer: unknown): boolean {
  return (
    (answer as { choices?: Array<{ finish_reason?: string }> } | null)?.choices?.[0]
      ?.finish_reason === "length"
  );
}

// The model's answer, held to the shape the check shows: a known verdict, at most five findings of
// a known kind on a file the pull request changed. Anything else is null.
export function parseVerdict(
  args: unknown,
  changed: ReadonlySet<string>,
): { verdict: Verdict; summary: string; findings: Finding[] } | null {
  if (!args || typeof args !== "object") return null;
  const raw = args as { verdict?: unknown; summary?: unknown; findings?: unknown };
  const verdict =
    typeof raw.verdict === "string" ? (raw.verdict.trim().toUpperCase() as Verdict) : null;
  if (!verdict || !VERDICTS.includes(verdict)) return null;
  const findings: Finding[] = [];
  for (const f of Array.isArray(raw.findings)
    ? (raw.findings as Array<Record<string, unknown>>)
    : []) {
    const kind = typeof f?.kind === "string" ? (f.kind.trim().toLowerCase() as FindingKind) : null;
    const file = typeof f?.file === "string" ? f.file.trim().replace(/^[ab]\//, "") : "";
    const note = typeof f?.note === "string" ? f.note.trim().slice(0, 600) : "";
    if (!kind || !FINDING_KINDS.includes(kind) || !changed.has(file) || !note) continue;
    const line =
      typeof f.line === "number" && Number.isInteger(f.line) && f.line > 0 ? f.line : null;
    findings.push({ kind, file, line, note });
    if (findings.length === MAX_FINDINGS) break;
  }
  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, 600) : "";
  return { verdict, summary, findings };
}
