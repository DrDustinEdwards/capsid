export interface TruthFinding {
  // What was checked, and what did not pass.
  check: string;
  subject: string;
  detail: string;
}

export interface TruthCheck {
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
  // Good standing over subjects, across every check that had a subject to judge.
  // Null when nothing was checkable, which is not the same as 100 percent.
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

// The shape src/counts.ts returns, mirrored so this module stays a pure function
// over plain data.
export interface ReportCountClaim {
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
  // Repo paths on the default branch. Undefined when the repo could not be read,
  // which makes the drift check unrun rather than clean.
  repoPaths?: Set<string>;
}

// A published decision older than this is worth re-reading. A prompt, not a defect.
export const STALE_DECISION_DAYS = 180;

// The lint cadence in capsid/conventions.md: consolidate at roughly five.
export const UNCONSOLIDATED_CADENCE = 5;

// Matches a repo path in prose: at least one slash, a file extension, and no
// spaces. `capsid/conventions.md` matches too and is excluded below, because a
// Capsid document path is not a repo path.
//
// The lookbehind, not a word boundary. A word boundary does not fall between a space
// and a dot, so a match would start one character late: `.github/workflows/ci.yml`
// would be captured as `github/workflows/ci.yml` and reported absent from a repo that
// has it, and the dotted paths are the ones canon names most. The lookbehind also
// stops the same path matching again after the dot.
//
// The extension must start with a letter, which excludes section numbers such as
// `2/2.1` and `5a-1/5a-3/1.5`: two slashes and a dot, and not a file.
const REPO_PATH = /(?<![A-Za-z0-9_./-])(\.?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z][A-Za-z0-9]{0,4})\b/g;

// Namespace prefixes that mean "a Capsid document", not "a file in the repo".
// A path starting with one of these is a store address and is skipped.
const NAMESPACE_PREFIXES = ["capsid/", "germomics/", "foxing/", "foxhound/", "dustinedwards/", "julieedwards/", "txasm/", "bsw/", "claude-skills/", "recova/"];

// The stored report's path prefix.
export const REPORTS_PREFIX = "reports/";

// Prefixes that are not subjects of the report. `archive/` is consumed history.
// `reports/` holds earlier reports: `report` stores its result as an ordinary
// document, and the next run would read it back, so every finding it wrote becomes a
// finding it finds, a quote describing a fixed contradiction is parsed as a fresh
// one, and drift paths are attributed to the report that merely listed them. Left
// alone it ratchets integrity down on every run while the store improves. A report is
// an observation of the store, not a member of it.
const UNSCANNED_PREFIXES = ["archive/", REPORTS_PREFIX];

export function isUnscanned(path: string): boolean {
  return UNSCANNED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

function parseStamp(value: string): Date | null {
  // D1 writes `YYYY-MM-DD HH:MM:SS` with no zone. Read as UTC rather than local,
  // or the same document is stale on one machine and fresh on another.
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

// A document is "standing" if it is part of the canon rather than raw material.
// archive/ is consumed history and is not held to any of this.
const isArchived = (doc: ReportDoc) => doc.path.startsWith("archive/");

export function buildTruthReport(input: TruthInput): TruthReport {
  const { namespace, now, docs } = input;
  // `archived` is counted on its own, not as "everything not standing", so the
  // reports/ exclusion does not inflate it.
  const standing = docs.filter((d) => !isUnscanned(d.path));
  const archived = docs.filter(isArchived).length;

  const byType: Record<string, number> = {};
  for (const doc of docs) {
    const type = doc.type ?? "(untyped)";
    byType[type] = (byType[type] ?? 0) + 1;
  }

  const checks: TruthCheck[] = [];

  // 1. Contradictions: the count claim, prose asserting a number the artifact
  //    disagrees with (src/counts.ts). A claim in an excluded document is dropped
  //    here as well as by the caller.
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
  // Every claim returned is a mismatch, so the population is the standing documents:
  // what fraction carry a wrong claim.
  const contradicting = new Set(countClaims.map((c) => c.path));
  checks[0] = {
    check: "contradictions",
    subjects: standing.length,
    ok: standing.length - [...contradicting].filter((p) => standing.some((d) => d.path === p)).length,
    findings: checks[0].findings,
  };

  // 2. Stale decisions: published and untouched in half a year. A state claim is
  //    re-verified before it is acted on, and a reader cannot apply that rule to a
  //    document whose age they cannot see.
  const decisions = standing.filter((d) => d.type === "decision" && (d.status ?? "published") === "published");
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

  // 3. Unbound specs: no typed edge in either direction, so a reader cannot find
  //    from the store whether the work happened.
  const specs = standing.filter((d) => d.type === "spec" || d.type === "protocol" || d.type === "procedural");
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

  // 4. Broken links, from gather, counted against the whole edge population.
  const namespaceEdges = input.edges.filter((e) => e.from_ns === namespace || e.to_ns === namespace);
  checks.push({
    check: "broken_links",
    subjects: namespaceEdges.length,
    ok: namespaceEdges.length - input.danglingEdges.length,
    findings: input.danglingEdges.map((e) => ({
      check: "broken_links",
      subject: `${e.from_ns}/${e.from_path} -[${e.type}]-> ${e.to_ns}/${e.to_path}`,
      detail: e.source_missing ? "the source document no longer exists" : "the target document no longer exists",
    })),
  });

  // 5. Doc-vs-code drift: a repo path named in canon that is no longer in the repo.
  //    The repo is gated and the store is not, so the store is where a path rots.
  //    Unrun is not clean: when the repo could not be read the check has zero
  //    subjects and is excluded from integrity, rather than reporting zero findings,
  //    which would read as perfect.
  if (input.repoPaths) {
    // A candidate counts only when its first segment is a top-level entry of this
    // namespace's mapped repo. That separates `src/gone.ts`, which this repo could
    // really be missing, from `apps/web/...` in another portfolio repo or a path in
    // another repo entirely, which are not drift here.
    const repoRoots = new Set([...input.repoPaths].map((p) => p.split("/")[0]));
    // A document path in this namespace is a store address, whatever it looks like.
    // The prefix list cannot reach these: the Worker writes `jobs/<id>.md` itself, and
    // `improve/` is both a store prefix and a real directory, so the root check would
    // pass it through. Every document counts, excluded ones included, because an
    // address does not stop being an address.
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
          detail: "NOT RUN: the repo tree could not be read, so this check is excluded from integrity rather than counted as clean",
        },
      ],
    });
  }

  // 6. Unconsolidated: a backlog, not a defect. At or under the cadence it is not a
  //    finding and does not lower integrity, so integrity always traces to a finding.
  const unconsolidated = standing.filter((d) => d.type === "episodic" || d.type === "source");
  const overCadence = unconsolidated.length > UNCONSOLIDATED_CADENCE;
  checks.push({
    check: "unconsolidated",
    subjects: standing.length,
    ok: overCadence ? standing.length - unconsolidated.length : standing.length,
    findings:
      overCadence
        ? [
            {
              check: "unconsolidated",
              subject: namespace,
              detail: `${unconsolidated.length} unconsolidated documents, over the lint cadence of ~5 in capsid/conventions.md`,
            },
          ]
        : [],
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

// The integrity line is first and in a fixed shape, because `improve_status` parses
// it back out.
export const INTEGRITY_LINE = /^integrity:\s*([0-9]+(?:\.[0-9]+)?)%\s*$/m;

export function renderTruthReport(report: TruthReport): string {
  const lines: string[] = [];
  lines.push(`# Truth report - ${report.namespace} - ${report.generated.slice(0, 10)}`);
  lines.push("");
  // Not measured is not zero. `integrity` is null when no check had a subject, and
  // "0%" would read as a store in the worst state it can be in. INTEGRITY_LINE does
  // not match the words, so integrityOf returns null and improve_status reports no
  // report, the same answer a missing document gets.
  lines.push(`integrity: ${report.integrity === null ? "not measured" : `${report.integrity}%`}`);
  lines.push("");
  lines.push(
    "One number and the checks it is made of. Integrity is subjects in good standing over subjects judged, across every check that had a subject to judge. " +
      "A check that could not run is excluded rather than counted as clean. Nothing here judges whether a ruling is CORRECT; it counts what a program can count without an opinion."
  );
  lines.push("");
  lines.push("## Documents");
  lines.push("");
  lines.push(`- total: ${report.documents.total}`);
  lines.push(`- archived: ${report.documents.archived}`);
  lines.push(`- unconsolidated: ${report.documents.unconsolidated}`);
  for (const [type, n] of Object.entries(report.documents.by_type).sort()) {
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
  lines.push("Generated by `lint` mode `report`. The trend is the point: compare this against the previous dated report in this directory.");
  lines.push("");
  return lines.join("\n");
}

// One document per namespace per day; a second run the same day overwrites.
export function reportPath(date: Date): string {
  return `${REPORTS_PREFIX}lint-${date.toISOString().slice(0, 10)}.md`;
}

// Pull the integrity number back out of a stored report. Returns null on anything
// unexpected, which `improve_status` reports as "no report" rather than as zero.
export function integrityOf(body: string | null | undefined): number | null {
  if (!body) return null;
  const match = INTEGRITY_LINE.exec(body);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
