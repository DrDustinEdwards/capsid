// The no-bloat report (capsid/decisions.md 2026-10-01, "no bloat, as a standing plan";
// job_372c30140e24). WARN-ONLY by ruling: defaults, not laws. It runs Knip on the Worker
// package and on the dashboard, and jscpd over the source, compares each count with the
// baseline in scripts/no-bloat-baseline.json, and says what grew: a ::warning:: line in
// the job log and a table in the job summary. It always exits 0, so it never blocks a
// merge (ci.yml sets no continue-on-error, and this step needs none). A tool that cannot
// run is said as a warning with its error, never passed over in silence.
//
// Page weight is reported by the dashboard build step, dashboard/scripts/size-budget.mjs,
// which already prints each asset's gzip size against its budget.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
const baseline = JSON.parse(readFileSync(join(import.meta.dirname, "no-bloat-baseline.json"), "utf8"));
const bin = (name) => join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);

function run(name, args) {
  // A .cmd shim on Windows needs cmd.exe; elsewhere the bin runs directly.
  const [file, argv] = process.platform === "win32" ? ["cmd.exe", ["/c", bin(name), ...args]] : [bin(name), args];
  const r = spawnSync(file, argv, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${name} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout;
}

/** Knip's compact report as counts per heading, e.g. { "Unused exports": 12 }. */
export function knipCounts(text) {
  const counts = {};
  for (const m of text.matchAll(/^([A-Z][A-Za-z ]+) \((\d+)\)$/gm)) counts[m[1]] = Number(m[2]);
  return counts;
}

function main() {
  const rows = [];
  const warnings = [];

  for (const [label, args] of [
    ["knip (Worker)", ["--no-exit-code", "--reporter", "compact"]],
    ["knip (dashboard)", ["--directory", "dashboard", "--no-exit-code", "--reporter", "compact"]],
  ]) {
    try {
      const now = knipCounts(run("knip", args));
      const was = baseline[label] ?? {};
      for (const key of [...new Set([...Object.keys(was), ...Object.keys(now)])]) {
        const a = was[key] ?? 0;
        const b = now[key] ?? 0;
        rows.push([label, key, a, b]);
        if (b > a) warnings.push(`${label}: ${key} went from ${a} to ${b}. Run \`npx knip${label.includes("dashboard") ? " --directory dashboard" : ""}\` to see which.`);
      }
    } catch (err) {
      warnings.push(`${label} could not run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const out = mkdtempSync(join(tmpdir(), "jscpd-"));
  try {
    run("jscpd", ["--reporters", "json", "--output", out, "--silent"]);
    const report = JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8"));
    const total = report.statistics.total;
    const was = baseline.jscpd;
    rows.push(["jscpd", "clones", was.clones, total.clones]);
    rows.push(["jscpd", "duplicated lines %", was.percentage, Number(total.percentage.toFixed(2))]);
    if (total.clones > was.clones) warnings.push(`jscpd: clones went from ${was.clones} to ${total.clones} (${total.percentage.toFixed(2)}% of lines, baseline ${was.percentage}%). Run \`npx jscpd\` to see them.`);
  } catch (err) {
    warnings.push(`jscpd could not run: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }

  const table = [
    `### No-bloat report (warn-only; baseline ${baseline.measured_at})`,
    "",
    "| Tool | Finding | Baseline | Now |",
    "|---|---|---|---|",
    ...rows.map(([tool, key, a, b]) => `| ${tool} | ${key} | ${a} | ${b}${b > a ? " (up)" : ""} |`),
    "",
    warnings.length ? warnings.map((w) => `- ${w}`).join("\n") : "Nothing grew past the baseline.",
  ].join("\n");
  console.log(table);
  for (const w of warnings) console.log(`::warning::${w}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
