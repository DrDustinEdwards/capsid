// The screenshots in docs/images (npm run shots) render only the sample fixtures: the
// feed in dev/sample-feed.json and the responses dev/mock-api.ts seeds. A picture cannot
// be searched for a leaked value, so this checks the text the pictures are drawn from.
// It fails, and names each value, on:
//   - an email address outside example.com and example.org;
//   - a hostname other than example.com or example.org (and their subdomains),
//     github.com under an example owner, and mcp.dustinedwards.info;
//   - a portfolio name (a real site, project or person);
//   - a job id that is not the sample shape, or one the mock names that the feed lacks;
//   - a token-shaped string (the shapes src/redact.ts redacts, restated here because a
//     plain .mjs cannot import the Worker's TypeScript).
//
// Run: node scripts/shots-privacy.mjs [file ...]. With no files it checks the two
// fixtures. playwright.shots.config.ts runs it as globalSetup, so no shot is taken from
// fixtures that fail it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_FILES = ["../dev/sample-feed.json", "../dev/mock-api.ts"].map((p) => fileURLToPath(new URL(p, import.meta.url)));

const ALLOWED_EMAIL_DOMAIN = /^(?:[a-z0-9-]+\.)*example\.(?:com|org)$/i;
const ALLOWED_HOST = /^(?:(?:[a-z0-9-]+\.)*example\.(?:com|org)|mcp\.dustinedwards\.info|github\.com)$/i;
// github.com is allowed only as a path under an example owner.
const GITHUB_OK = /^github\.com\/example(?:-org)?\//i;

const TLDS = "com|org|net|info|app|io|dev|ai|co|us|me|xyz|site|tech|edu|gov|biz|page|cloud|sh|gg|tv|fm|ly|so|live|blog|news|studio|design";
const HOST = new RegExp(String.raw`(?<![A-Za-z0-9@.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${TLDS}))\b(\/[^\s"'\`)]*)?`, "gi");
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;

// Names from the real portfolio. The allowed Worker host is taken out before this runs.
const REAL_NAMES = /\b(?:dustin|edwards|dustinedwards|foxing|foxhound|foxhoundapp|germomics|txasm|julie|julieedwards|recova|carrel|bsw)\b/gi;

// The sample job shape: job_ and 12 hex digits, with an optional -s<n> session suffix.
const JOB_ANY = /\bjob_[A-Za-z0-9_-]+/g;
const JOB_SAMPLE = /^job_[0-9a-f]{12}(?:-s\d+)?$/;
const NOT_A_JOB = new Set(["job_id"]);

// src/redact.ts, its shapes. VALUE and SECRET_NAME match redact.ts.
const VALUE = String.raw`(?!\[REDACTED)[^\s"',;&]{6,}`;
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|signing[_-]?key|credential)[A-Za-z0-9_.-]*`;
const TOKEN_RULES = [
  ["private-key", /-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY( BLOCK)?-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["slack-token", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g],
  ["aws-access-key-id", /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[A-Z0-9]{16}\b/g],
  ["auth", new RegExp(String.raw`\bauthorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token|digest)\s+)?${VALUE}`, "gi")],
  ["auth", /\b(?:Bearer|Basic)\s+(?=[A-Za-z0-9._~+/-]*[0-9+/=])[A-Za-z0-9._~+/-]{8,}=*/gi],
  ["api-key", /\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{20,}/g],
];
// Applied to the prose parts (segments) and JSON only.
const ASSIGNMENT = new RegExp(String.raw`(?<![A-Za-z0-9_.-])(["']?)(${SECRET_NAME})\1\s*[:=]\s*["']?(${VALUE})`, "gi");
const HIGH_ENTROPY = /\b(?:secret|token|key|password|passwd|credential)s?\b[^\n]{0,24}?([A-Za-z0-9+/_-]{32,}={0,2})/gi;
const looksRandom = (run) => (/^[0-9a-f]+$/i.test(run) && /\d/.test(run)) || (/\d/.test(run) && /[A-Za-z]/.test(run));

// The prose in a TypeScript source, each part with its offset: string literals ("...",
// '...', `...`) and comments. Hostnames and secret-named values are looked for only
// here, so code such as `raw.live` or `token = randomUUID()` is not taken for one.
function segments(src) {
  const out = [];
  const re = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  // A template's ${...} is code, blanked to keep the offsets.
  for (const m of src.matchAll(re)) out.push({ text: m[0].replace(/\$\{[^}]*\}/g, (c) => " ".repeat(c.length)), index: m.index });
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// Every problem in one file's text, as "file:line: what".
export function scan(name, text, feedJobIds) {
  const problems = [];
  const at = (i, msg) => problems.push(`${name}:${lineOf(text, i)}: ${msg}`);

  for (const m of text.matchAll(EMAIL)) {
    if (!ALLOWED_EMAIL_DOMAIN.test(m[1])) at(m.index, `email address outside example.com/example.org: ${m[0]}`);
  }
  const parts = name.endsWith(".json") ? [{ text, index: 0 }] : segments(text);
  for (const p of parts) {
    for (const m of p.text.matchAll(HOST)) {
      const host = m[1].toLowerCase();
      // The domain part of an email is judged by the email check.
      if (p.text[m.index - 1] === "@") continue;
      if (!ALLOWED_HOST.test(host)) at(p.index + m.index, `hostname that is not a sample host: ${host}`);
      else if (host === "github.com" && !GITHUB_OK.test(`${host}${m[2] ?? ""}`)) at(p.index + m.index, `github.com outside an example owner: ${m[0]}`);
    }
  }
  const withoutWorker = text.replace(/capsid\.dustin-edwards\.workers\.dev/gi, (s) => " ".repeat(s.length));
  for (const m of withoutWorker.matchAll(REAL_NAMES)) at(m.index, `a real portfolio name: ${m[0]}`);

  for (const m of text.matchAll(JOB_ANY)) {
    const id = m[0];
    if (NOT_A_JOB.has(id)) continue;
    if (!JOB_SAMPLE.test(id)) at(m.index, `job id not of the sample shape job_<12 hex>: ${id}`);
    else if (feedJobIds && !feedJobIds.has(id.replace(/-s\d+$/, ""))) at(m.index, `job id the sample feed does not define: ${id}`);
  }

  for (const [kind, re] of TOKEN_RULES) {
    for (const m of text.matchAll(re)) at(m.index, `token-shaped string (${kind}): ${m[0].slice(0, 12)}...`);
  }
  for (const p of parts) {
    for (const m of p.text.matchAll(ASSIGNMENT)) at(p.index + m.index, `secret-named value (assignment): ${m[2]}=...`);
    for (const m of p.text.matchAll(HIGH_ENTROPY)) if (looksRandom(m[1])) at(p.index + m.index, `random-looking value after a secret word: ${m[1].slice(0, 8)}...`);
  }
  return problems;
}

function feedJobs(files) {
  const feed = files.find((f) => f.endsWith("sample-feed.json"));
  if (!feed) return null;
  const parsed = JSON.parse(readFileSync(feed, "utf8"));
  const jobs = parsed?.live?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error(`shots-privacy: ${feed} has no live.jobs to check job ids against`);
  return new Set(jobs.map((j) => j.id));
}

export function check(files = DEFAULT_FILES) {
  if (files.length === 0) throw new Error("shots-privacy: no files to check");
  const ids = feedJobs(files);
  const problems = [];
  for (const f of files) problems.push(...scan(f, readFileSync(f, "utf8"), ids));
  return problems;
}

// playwright.shots.config.ts globalSetup: throws, so no shot is taken, when a fixture fails.
export default function globalSetup() {
  const problems = check();
  if (problems.length) throw new Error(`shots-privacy: the fixtures hold ${problems.length} value(s) that look real:\n${problems.join("\n")}`);
  console.log(`shots-privacy: ${DEFAULT_FILES.length} fixture files checked, nothing real-looking`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const files = args.length ? args : DEFAULT_FILES;
  const problems = check(files);
  if (problems.length) {
    console.error(`shots-privacy: ${problems.length} value(s) that look real:\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(`shots-privacy: ${files.length} file(s) checked, nothing real-looking`);
}
