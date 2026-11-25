import { parseSqlTime } from "@dustinedwards/site-runtime/time";
import { ruleDocCap, ruleDocProblem, staleSummary, type RuleDocProblem } from "./rule-docs";
import { DAY_MS, utcDay } from "./time";
interface TruthFinding {
  check: string;
  subject: string;
  detail: string;
}

interface TruthCheck {
  check: string;
  subjects: number;
  ok: number;
  findings: TruthFinding[];
}

export interface TruthReport {
  namespace: string;
  generated: string;
  documents: {
    total: number;
    by_type: Record<string, number>;
    unconsolidated: number;
    archived: number;
  };
  checks: TruthCheck[];
  // Null when nothing was checkable, which is not 100 percent.
  integrity: number | null;
  findings: TruthFinding[];
}

export interface ReportDoc {
  path: string;
  type: string | null;
  status: string | null;
  title: string | null;
  body: string | null;
  updated_at: string;
}

export interface ReportEdge {
  from_ns: string;
  from_path: string;
  type: string;
  to_ns: string;
  to_path: string;
  source_missing?: number;
  target_missing?: number;
}

interface ReportCountClaim {
  path: string;
  noun: string;
  states: string;
  authoritative: string;
  quote: string;
}

export interface TruthInput {
  namespace: string;
  now: Date;
  docs: ReportDoc[];
  edges: ReportEdge[];
  danglingEdges: ReportEdge[];
  countClaims: ReportCountClaim[];
  // Undefined when the repo could not be read, which makes the drift check unrun rather than clean.
  repoPaths?: Set<string>;
}

export const STALE_DECISION_DAYS = 180;

export const UNCONSOLIDATED_CADENCE = 5;

// `capsid/conventions.md` matches too and is excluded below: a Capsid document path is not a repo path.
const REPO_PATH =
  /(?<![A-Za-z0-9_./-])(\.?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z][A-Za-z0-9]{0,4})\b/g;

const NAMESPACE_PREFIXES = [
  "capsid/",
  "germomics/",
  "foxing/",
  "foxhound/",
  "dustinedwards/",
  "julieedwards/",
  "txasm/",
  "bsw/",
  "claude-skills/",
  "recova/",
];

export const REPORTS_PREFIX = "reports/";

// `reports/` holds earlier reports; reading them back would turn each finding into one it finds, and
// integrity would ratchet down every run.
const UNSCANNED_PREFIXES = ["archive/", REPORTS_PREFIX];

export function isUnscanned(path: string): boolean {
  return UNSCANNED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / DAY_MS;
}

function parseStamp(value: string): Date | null {
  // D1 writes `YYYY-MM-DD HH:MM:SS` with no zone; parseSqlTime reads it as UTC, so the
  // same document is not stale on one machine and fresh on another.
  const ms = parseSqlTime(value);
  return ms === null ? null : new Date(ms);
}

const isArchived = (doc: ReportDoc) => doc.path.startsWith("archive/");

export function buildTruthReport(input: TruthInput): TruthReport {
  const { namespace, now, docs } = input;
  // `archived` is counted on its own so the reports/ exclusion does not inflate it.
  const standing = docs.filter((d) => !isUnscanned(d.path));
  const archived = docs.filter(isArchived).length;

  const byType: Record<string, number> = {};
  for (const doc of docs) {
    const type = doc.type ?? "(untyped)";
    byType[type] = (byType[type] ?? 0) + 1;
  }

  const checks: TruthCheck[] = [];

  // Contradictions (src/counts.ts); a claim in an excluded document is dropped here too.
  const countClaims = input.countClaims.filter((claim) => !isUnscanned(claim.path));
  checks.push({
    check: "contradictions",
    subjects: countClaims.length,
    ok: 0,
    findings: countClaims.map((claim) => ({
      check: "contradictions",
      subject: `${namespace}/${claim.path}`,
      detail: `states ${claim.states} ${claim.noun}; the artifact says ${claim.authoritative}. In: ${claim.quote}`,
    })),
  });
  const contradicting = new Set(countClaims.map((c) => c.path));
  checks[0] = {
    check: "contradictions",
    subjects: standing.length,
    ok:
      standing.length - [...contradicting].filter((p) => standing.some((d) => d.path === p)).length,
    findings: checks[0].findings,
  };

  // Stale decisions: a reader cannot apply the re-verify rule to a document whose age they cannot see.
  const decisions = standing.filter(
    (d) => d.type === "decision" && (d.status ?? "published") === "published",
  );
  const staleDecisions = decisions.filter((d) => {
    const stamp = parseStamp(d.updated_at);
    return stamp !== null && daysBetween(now, stamp) > STALE_DECISION_DAYS;
  });
  checks.push({
    check: "stale_decisions",
    subjects: decisions.length,
    ok: decisions.length - staleDecisions.length,
    findings: staleDecisions.map((d) => ({
      check: "stale_decisions",
      subject: `${namespace}/${d.path}`,
      detail: `last written ${d.updated_at}, over ${STALE_DECISION_DAYS} days ago, and still published`,
    })),
  });

  // Unbound specs: no typed edge, so the store cannot say whether the work happened.
  const specs = standing.filter(
    (d) => d.type === "spec" || d.type === "protocol" || d.type === "procedural",
  );
  const bound = new Set<string>();
  for (const edge of input.edges) {
    if (edge.from_ns === namespace) bound.add(edge.from_path);
    if (edge.to_ns === namespace) bound.add(edge.to_path);
  }
  const unbound = specs.filter((d) => !bound.has(d.path));
  checks.push({
    check: "unbound_specs",
    subjects: specs.length,
    ok: specs.length - unbound.length,
    findings: unbound.map((d) => ({
      check: "unbound_specs",
      subject: `${namespace}/${d.path}`,
      detail: `type '${d.type}' with no typed edge in either direction; nothing in the store points at it and it points at nothing`,
    })),
  });

  const namespaceEdges = input.edges.filter(
    (e) => e.from_ns === namespace || e.to_ns === namespace,
  );
  checks.push({
    check: "broken_links",
    subjects: namespaceEdges.length,
    ok: namespaceEdges.length - input.danglingEdges.length,
    findings: input.danglingEdges.map((e) => ({
      check: "broken_links",
      subject: `${e.from_ns}/${e.from_path} -[${e.type}]-> ${e.to_ns}/${e.to_path}`,
      detail: e.source_missing
        ? "the source document no longer exists"
        : "the target document no longer exists",
    })),
  });

  // Doc-vs-code drift: the repo is gated and the store is not, so the store is where a path rots.
  if (input.repoPaths) {
    // Counts only when its first segment is a top-level entry of this namespace's mapped repo, which
    // separates `src/gone.ts` from another repo's `apps/web/...`.
    const repoRoots = new Set([...input.repoPaths].map((p) => p.split("/")[0]));
    // A document path in this namespace is a store address, whatever it looks like (the prefix list
    // cannot reach `jobs/<id>.md`, and `improve/` is also a real directory). Excluded documents count.
    const documentPaths = new Set(docs.map((d) => d.path));
    const cited = new Map<string, Set<string>>();
    for (const doc of standing) {
      for (const match of (doc.body ?? "").matchAll(REPO_PATH)) {
        const path = match[1];
        if (NAMESPACE_PREFIXES.some((p) => path.startsWith(p))) continue;
        if (documentPaths.has(path)) continue;
        if (!repoRoots.has(path.split("/")[0])) continue;
        if (!cited.has(path)) cited.set(path, new Set());
        cited.get(path)!.add(doc.path);
      }
    }
    const missing = [...cited.entries()].filter(([path]) => !input.repoPaths!.has(path));
    checks.push({
      check: "doc_vs_code_drift",
      subjects: cited.size,
      ok: cited.size - missing.length,
      findings: missing.map(([path, docPaths]) => ({
        check: "doc_vs_code_drift",
        subject: path,
        detail: `named in ${[...docPaths].sort().join(", ")} and absent from the repo`,
      })),
    });
  } else {
    checks.push({
      check: "doc_vs_code_drift",
      subjects: 0,
      ok: 0,
      findings: [
        {
          check: "doc_vs_code_drift",
          subject: namespace,
          detail:
            "NOT RUN: the repo tree could not be read, so this check is excluded from integrity rather than counted as clean",
        },
      ],
    });
  }

  // A backlog, not a defect: at or under the cadence it does not lower integrity.
  const unconsolidated = standing.filter((d) => d.type === "episodic" || d.type === "source");
  const overCadence = unconsolidated.length > UNCONSOLIDATED_CADENCE;
  checks.push({
    check: "unconsolidated",
    subjects: standing.length,
    ok: overCadence ? standing.length - unconsolidated.length : standing.length,
    findings: overCadence
      ? [
          {
            check: "unconsolidated",
            subject: namespace,
            detail: `${unconsolidated.length} unconsolidated documents, over the consolidation threshold of 5`,
          },
        ]
      : [],
  });

  // Rule documents (src/rule-docs.ts): a namespace with none has nothing judged here.
  const ruleDocs = standing.filter((d) => ruleDocCap(namespace, d.path) !== null);
  const problems = ruleDocs
    .map((d) => ruleDocProblem(namespace, d.path, d.body ?? ""))
    .filter((p): p is RuleDocProblem => p !== null);
  const oversize = problems.filter((p) => p.oversize);
  checks.push({
    check: "rule_doc_caps",
    subjects: ruleDocs.length,
    ok: ruleDocs.length - oversize.length,
    findings: oversize.map((p) => ({
      check: "rule_doc_caps",
      subject: `${namespace}/${p.path}`,
      detail: `${p.bytes} bytes, over its ${p.cap}-byte cap`,
    })),
  });
  const stale = problems.filter((p) => p.stale.length > 0);
  checks.push({
    check: "stale_tool_names",
    subjects: ruleDocs.length,
    ok: ruleDocs.length - stale.length,
    findings: stale.map((p) => ({
      check: "stale_tool_names",
      subject: `${namespace}/${p.path}`,
      detail: `names ${staleSummary(p.stale)}`,
    })),
  });

  const judged = checks.filter((c) => c.subjects > 0);
  const subjects = judged.reduce((sum, c) => sum + c.subjects, 0);
  const good = judged.reduce((sum, c) => sum + c.ok, 0);
  const integrity = subjects > 0 ? Math.round((good / subjects) * 1000) / 10 : null;

  return {
    namespace,
    generated: input.now.toISOString(),
    documents: {
      total: docs.length,
      by_type: byType,
      unconsolidated: unconsolidated.length,
      archived,
    },
    checks,
    integrity,
    findings: checks.flatMap((c) => c.findings),
  };
}

// The integrity line is first and in a fixed shape, because `capsid_read_status` action `status` parses
// it back out.
export const INTEGRITY_LINE = /^integrity:\s*([0-9]+(?:\.[0-9]+)?)%\s*$/m;

export function renderTruthReport(report: TruthReport): string {
  const lines: string[] = [];
  lines.push(`# Truth report - ${report.namespace} - ${report.generated.slice(0, 10)}`);
  lines.push("");
  // integrity is null when no check had a subject: "0%" would read as the worst state, and INTEGRITY_LINE does not match the words, so status reports no report.
  lines.push(`integrity: ${report.integrity === null ? "not measured" : `${report.integrity}%`}`);
  lines.push("");
  lines.push(
    "One number and the checks it is made of. Integrity is subjects in good standing over subjects judged, across every check that had a subject to judge. " +
      "A check that could not run is excluded rather than counted as clean. Nothing here judges whether a ruling is CORRECT; it counts what a program can count without an opinion.",
  );
  lines.push("");
  lines.push("## Documents");
  lines.push("");
  lines.push(`- total: ${report.documents.total}`);
  lines.push(`- archived: ${report.documents.archived}`);
  lines.push(`- unconsolidated: ${report.documents.unconsolidated}`);
  for (const [type, n] of Object.entries(report.documents.by_type).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    lines.push(`- type ${type}: ${n}`);
  }
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  lines.push("| check | subjects | ok | findings |");
  lines.push("| --- | --- | --- | --- |");
  for (const check of report.checks) {
    lines.push(`| ${check.check} | ${check.subjects} | ${check.ok} | ${check.findings.length} |`);
  }
  lines.push("");
  if (report.findings.length === 0) {
    lines.push("## Findings");
    lines.push("");
    lines.push("None.");
  } else {
    lines.push("## Findings");
    lines.push("");
    for (const check of report.checks) {
      if (check.findings.length === 0) continue;
      lines.push(`### ${check.check}`);
      lines.push("");
      for (const finding of check.findings) {
        lines.push(`- **${finding.subject}**: ${finding.detail}`);
      }
      lines.push("");
    }
  }
  lines.push(
    "Generated by `capsid_lint_namespace` mode `report`. The trend is the point: compare this against the previous dated report in this directory.",
  );
  lines.push("");
  return lines.join("\n");
}

export function reportPath(date: Date): string {
  return `${REPORTS_PREFIX}lint-${utcDay(date)}.md`;
}

// Pull the integrity number back out of a stored report. Returns null on anything
// unexpected, which `capsid_read_status` action `status` reports as "no report" rather than as zero.
export function integrityOf(body: string | null | undefined): number | null {
  if (!body) return null;
  const match = INTEGRITY_LINE.exec(body);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
