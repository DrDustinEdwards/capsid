// The front page. First what Capsid is, beside one claim checked against GitHub, which the
// reader can change. Then what it remembers: a search and a session start over an example
// store. Then the panel: every tool Capsid serves as a circuit, lit by the grants a
// caller holds, which the reader switches. Then one job's life as a guided tour, the drawing of
// Capsid's insides pinned beside the chapters, each with its day's figures; then everything it
// holds as the manual's contents. Pure, as pages.mjs is.
//
// Every number is from the public numbers or the model; every sentence that states a fact about
// how Capsid works is the model's own flow text.

import { graph, thing, website } from "@drdustinedwards/site-helpers/schema";

import { ORIGIN, SITE, escapeHtml, flowStage, flowsOf, layout, manualHead, minutes, percent, reading, sectionAt, stepPath, stepWords } from "./pages.mjs";
import { toolPath } from "./tools.mjs";

const DESCRIPTION = "Capsid is an MCP server on one Cloudflare Worker: a shared memory agents search and start from, a signed work queue, scoped grants checked at one point, and every agent's claim checked against GitHub.";
/** The front page's JSON-LD: this site, and the code it is about. A function, because pages.mjs imports this module. */
const siteData = (AUTHOR = { "@type": "Person", "@id": `${SITE}/#person`, name: "Dustin Edwards", url: SITE }) => graph([
  website({ origin: ORIGIN, name: "Capsid", description: DESCRIPTION, searchUrl: `${ORIGIN}/search/?q={search_term_string}`, publisher: AUTHOR }),
  thing("SoftwareSourceCode", {
    "@id": `${ORIGIN}/#code`,
    name: "Capsid",
    description: DESCRIPTION,
    url: ORIGIN,
    codeRepository: "https://github.com/DrDustinEdwards/capsid",
    license: "https://opensource.org/licenses/MIT",
    programmingLanguage: "TypeScript",
    runtimePlatform: "Cloudflare Workers",
    author: AUTHOR,
  }),
]);

/** The week each bar of a weekly series ends on, labeled as the numbers page does. @param {any} stats */
export function weekLabels(stats) {
  const end = new Date(Date.parse(`${stats.as_of}T00:00:00Z`) - 86_400_000);
  return stats.jobs.completed_by_week.map((/** @type {number} */ _c, /** @type {number} */ i, /** @type {number[]} */ all) =>
    new Date(end.getTime() - (all.length - 1 - i) * 7 * 86_400_000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).replace("Sept", "Sep")
  );
}

/**
 * The reading Capsid keeps for each moment of a job's life, by the step's own name (the words
 * before its colon in the model). A step with no reading of its own carries none.
 * @param {any} stats @returns {Record<string, [string, string][]>}
 */
function readingsByStep(stats) {
  const { jobs: j, verification: v, gates: g } = stats;
  return {
    posted: [[String(j.completed_30d), "jobs completed, last 30 days"]],
    claimed: [[String(j.open), "open today"], [String(j.blocked), "blocked on a person"]],
    worked: [[minutes(j.median_duration_minutes_30d), "half of last month's jobs took under"]],
    blocked: [[String(g.waits_30d), "approval waits, last 30 days"], [minutes(g.median_wait_minutes_30d), "median wait"]],
    "pull request": [[percent(v.pr_merge_rate_90d), "of claimed pull requests merged"]],
    merged: [[percent(g.share_ended_by_policy_30d), "of waits ended by the signed policy"]],
    deployed: [[percent(v.ci_green_rate_90d), "of claimed CI green on its head"]],
    verified: [[stats.capsid.sha7, "the commit live right now"]],
    "claims checked": [[percent(v.agreement_rate_90d), `of ${v.evaluations_90d} claims agreed with GitHub, 90 days`]],
  };
}

/** What each grant requirement asks of a caller, in words (src/scope.ts, needFor). */
const NEED = {
  read: "the read grant",
  write: "the write grant",
  action: "the read grant for some actions and the write grant for the rest",
  admin: "the admin identity and the write grant",
  admin_read: "the admin identity and the read grant",
};

/** The grants a caller can hold, as the panel's breakers. */
const BREAKERS = [
  ["read", "Read grant", "Reads documents, repos and the queue"],
  ["write", "Write grant", "Writes documents, branches and pull requests"],
  ["admin", "Admin identity", "Mints agents and holds the switches"],
];

/** The breaker each tool hangs under: the grant it cannot work without beyond read (src/scope.ts, needFor). */
const FEEDS = { read: "read", action: "write", write: "write", admin_read: "admin", admin: "admin" };

/**
 * Whether a caller holding these grants reaches a tool: "full", "part" (an action tool, some of
 * whose actions need the grant it lacks) or "" (src/scope.ts: needFor, checkScope). The script
 * runs the same rule as the breakers move (src/explorer.js, board).
 * @param {string} need @param {{ read: boolean, write: boolean, admin: boolean }} held
 */
export function reaches(need, held) {
  if (need === "read") return held.read ? "full" : "";
  if (need === "write") return held.write ? "full" : "";
  if (need === "admin") return held.admin && held.write ? "full" : "";
  if (need === "admin_read") return held.admin && held.read ? "full" : "";
  if (need === "action") return held.read && held.write ? "full" : held.read || held.write ? "part" : "";
  return "";
}

/** How many tools a caller with these grants reaches, in words. @param {any[]} tools @param {{ read: boolean, write: boolean, admin: boolean }} held */
export function reachSentence(tools, held) {
  const full = tools.filter((t) => reaches(t.grant, held) === "full").length;
  const part = tools.filter((t) => reaches(t.grant, held) === "part").length;
  return `${full} of ${tools.length} tools live${part ? `, ${part} in part` : ""}.`;
}

/**
 * The checks the Worker runs on a claim (src/job-claims.ts, WORKER_EVALUATIONS), as the hero's
 * example job: what GitHub reads for it, and the claim's words. ci_green is a yes or a no.
 */
/** @type {[string, string, number][]} */
const CHECKS = [
  ["pr_merged", "Pull requests merged", 2],
  ["commits", "Commits", 7],
  ["files_changed", "Files changed", 12],
  ["ci_green", "CI green", 1],
];

/** A check's value in words: a count as itself, CI green as yes or no. @param {string} kind @param {number} n */
export const valueWords = (kind, n) => (kind === "ci_green" ? (n ? "Yes" : "No") : String(n));

/**
 * What Capsid records for a claim (src/job-claims.ts, evaluationRows): GitHub's value, with the
 * agent's beside it and the two marked as agreeing or not. @param {string} kind @param {number} said @param {number} read
 */
export function verdict(kind, said, read) {
  const r = valueWords(kind, read);
  return said === read
    ? `Agrees. The record keeps GitHub's ${r}.`
    : `Caught. The record keeps GitHub's ${r}, with the agent's ${valueWords(kind, said)} beside it, marked as disagreeing.`;
}

/**
 * The first screen: what Capsid is, the two ways on, and one claim checked, which the reader
 * can change to see Capsid catch it. The example's numbers are an example; the figure under
 * it is this instance's own.
 * @param {any} stats
 */
function hero(stats) {
  const v = stats.verification;
  const [kind, , read] = CHECKS[0];
  return `<section class="hero" aria-labelledby="hero-title">
${manualHead("/")}
<div class="hero-words">
<h1 id="hero-title">One panel, every agent</h1>
<p class="lead">Capsid is an MCP server on one Cloudflare Worker. Agents start from a shared memory, claim signed jobs, act only through the grants they hold, and a job counts as done only when GitHub agrees.</p>
<p class="hero-actions"><a class="cap-btn" data-variant="primary" href="https://github.com/DrDustinEdwards/capsid#installation">Run your own</a><a class="hero-link" href="#tour">Follow one job</a></p>
<p class="hero-note">This is a live instance. Every tool, step and number here is its own, rebuilt each day.</p>
</div>
<div class="desk" data-ui data-desk>
<h2 class="desk-title" data-plain>A claim, checked <span>An example job. Change what the agent says.</span></h2>
<div class="desk-kinds" role="group" aria-label="What the agent claims">${CHECKS.map(([k, name, n], i) => `<button type="button" class="desk-kind" data-kind="${k}" data-read="${n}" aria-pressed="${i === 0}">${name}</button>`).join("")}</div>
<div class="desk-row">
<div class="desk-cell"><span class="desk-label">The agent says</span><span class="desk-value" data-desk-said>${valueWords(kind, read)}</span><span class="desk-step"><button type="button" data-desk-step="-1" aria-label="The agent claims one fewer">\u2212</button><button type="button" data-desk-step="1" aria-label="The agent claims one more">+</button></span></div>
<div class="desk-cell desk-github"><span class="desk-label">GitHub reads</span><span class="desk-value" data-desk-read>${valueWords(kind, read)}</span></div>
<div class="desk-cell desk-kept" data-agree><span class="desk-label">Capsid records</span><span class="desk-value" data-desk-kept>${valueWords(kind, read)}</span><span class="desk-stamp" aria-hidden="true" data-desk-stamp>Agrees</span></div>
</div>
<p class="desk-verdict" role="status" data-desk-verdict>${verdict(kind, read, read)}</p>
<p class="desk-play"><button type="button" class="cap-btn" data-variant="primary" data-desk-fool>Try to fool it</button><span data-desk-tally></span></p>
<p class="desk-fact">This instance has checked ${v.evaluations_90d.toLocaleString("en-US")} claims in 90 days, and ${percent(v.agreement_rate_90d)} agreed with GitHub. <a href="/numbers/">The numbers</a></p>
</div>
</section>`;
}

/**
 * The knowledge base's example store: three questions, and the documents each finds. A row
 * matches by keyword, by meaning or both; canon is the current conventions, core or decisions,
 * which rank first (src/doc-index.ts, isCanon). Fake data, in the namespace "sample", as the
 * public repo's fixtures are (CLAUDE.md, public repo rule).
 * @type {{ q: string, retired: number, rows: [string, string, boolean, boolean, boolean][] }[]}
 */
const SEARCHES = [
  {
    q: "How does an agent prove a job is done?",
    retired: 1,
    rows: [
      ["Decisions", "sample/decisions.md", false, true, true],
      ["Checking claims against GitHub", "sample/specs/verification.md", true, true, false],
      ["Outcome rows", "sample/specs/outcomes.md", false, true, false],
      ["Session: the claim check", "sample/sessions/2026-10-20.md", true, false, false],
    ],
  },
  {
    q: "Where do old versions of a document go?",
    retired: 0,
    rows: [
      ["Sample core", "sample/core.md", false, true, true],
      ["Document history", "sample/specs/versions.md", true, true, false],
      ["Restoring a page from a backup", "sample/runbooks/restore.md", false, true, false],
      ["Session: moved the old notes", "sample/sessions/2026-10-02.md", true, false, false],
    ],
  },
  {
    q: "Who is allowed to merge?",
    retired: 2,
    rows: [
      ["Decisions", "sample/decisions.md", false, true, true],
      ["The signed merge policy", "sample/specs/merge-policy.md", true, true, false],
      ["Grants and flags", "sample/specs/grants.md", false, true, false],
      ["Session: who may merge", "sample/sessions/2026-10-18.md", true, false, false],
    ],
  },
];

/** What Start a session hands over (src/tools/docs-read.ts, brief), for the example store: name, path, kilobytes. */
const BRIEF = [
  ["The conventions", "capsid/conventions.md", 6],
  ["The project's core", "sample/core.md", 9],
  ["Decisions and rulings", "sample/decisions.md", 11],
  ["Open tasks, 3", "sample/tasks/", 5],
  ["The latest session notes, 3", "sample/sessions/", 6],
];

/**
 * The knowledge base: what Capsid remembers, as two things a reader can do with the example
 * store. Ask it a question by keyword alone or by keyword and meaning; start a session, write a
 * note, and start again to find the note there. The figure under them is this instance's own.
 * Each links to its flow once the model has it.
 * @param {any} model @param {any} stats
 */
function knowledge(model, stats) {
  const more = (/** @type {string} */ id, /** @type {string} */ words) => (flowsOf(model).some((f) => f.id === id) ? `<p class="kb-more"><a href="/flows/${id}/">${words}</a></p>` : "");
  const tag = (/** @type {boolean} */ kw, /** @type {boolean} */ mean) => (kw && mean ? "both" : kw ? "keyword" : "meaning");
  const results = SEARCHES.map(
    (x, i) => `<ol class="kb-results" data-q="${i}"${i ? " hidden" : ""}>${x.rows
      .map(
        ([title, path, kw, mean, canon]) =>
          `<li${kw ? " data-kw" : ""}${mean ? " data-mean" : ""}><span class="kb-doc"><span class="kb-title">${escapeHtml(title)}</span><code>${escapeHtml(path)}</code></span><span class="kb-tags">${canon ? `<span class="kb-tag" data-canon>canon</span>` : ""}<span class="kb-tag kb-how">${tag(kw, mean)}</span><span class="kb-tag kb-kw">keyword</span></span></li>`
      )
      .join("")}</ol><p class="kb-left" data-q="${i}"${i ? " hidden" : ""}>${x.retired ? `${x.retired} closed or superseded ${x.retired === 1 ? "document" : "documents"} left out.` : "Nothing closed or superseded matched."} Every meaning hit is read back from the record before it is shown.</p><p class="kb-left kb-kwnote" data-q="${i}"${i ? " hidden" : ""}>${x.rows.filter((r) => r[2]).length} of ${x.rows.length} found by keyword alone. Add meaning to find the ones that say it in other words.</p>`
  ).join("");
  const total = BRIEF.reduce((n, b) => n + Number(b[2]), 0);
  return `<section class="kb wrap" id="memory" aria-labelledby="kb-title">
<h2 id="kb-title">What it remembers</h2>
<p class="lead">Every project's notes, decisions and session logs live in one store that agents search and start from, and every edit keeps the old version. This instance holds ${stats.store.documents.toLocaleString("en-US")} documents in ${stats.store.namespaces} namespaces.</p>
<div class="kb-grid">
<div class="kb-box" data-ui data-kb-search data-mode="hybrid">
<h3 class="kb-head">Ask it <span>An example store</span></h3>
<div class="kb-qs" role="group" aria-label="The question">${SEARCHES.map((x, i) => `<button type="button" class="kb-q" data-ask="${i}" aria-pressed="${i === 0}">${escapeHtml(x.q)}</button>`).join("")}</div>
<div class="kb-modes" role="group" aria-label="How it searches"><button type="button" class="kb-mode" data-mode-set="keyword" aria-pressed="false">Keyword</button><button type="button" class="kb-mode" data-mode-set="hybrid" aria-pressed="true">Keyword and meaning</button></div>
<div class="kb-out" aria-live="polite">${results}</div>
${more("doc-search", "How a search runs")}
</div>
<div class="kb-box" data-ui data-session>
<h3 class="kb-head">Start from it <span>The same store</span></h3>
<p class="kb-actions"><button type="button" class="cap-btn" data-variant="primary" data-start>Start a session</button><button type="button" class="cap-btn" data-write disabled>Write a note</button></p>
<ol class="kb-brief">${BRIEF.map(([name, path, kb]) => `<li data-brief><span class="kb-doc"><span class="kb-title">${name}</span><code>${path}</code></span><span class="kb-size">${kb} KB</span></li>`).join("")}<li data-brief data-mine hidden><span class="kb-doc"><span class="kb-title">Your note, from the last session</span><code>sample/sessions/2026-10-25.md</code></span><span class="kb-size">1 KB</span></li></ol>
<p class="kb-budget"><progress max="40" value="${total}" data-budget>${total} of 40 KB</progress><span data-budget-words>${total} KB of the 40 KB a start may hand over. Nothing trimmed.</span></p>
<p class="kb-said" role="status" data-session-said>One call hands a new session the project's notes.</p>
${more("session-start", "How a session starts")}
</div>
</div>
</section>`;
}

/**
 * The panel: every tool Capsid serves as a circuit, each lit when the grants switched on reach
 * it. It opens as a read-only agent sees it. Full width, so the whole board is in view.
 * @param {any[]} tools
 */
function board(tools) {
  const held = { read: true, write: false, admin: false };
  const circuit = (/** @type {any} */ t) => {
    const on = reaches(t.grant, held);
    return `<li class="circuit" data-need="${escapeHtml(t.grant)}"${on ? ` data-on="${on}"` : ""}><a href="${toolPath(t.name)}"><span class="lamp" aria-hidden="true"></span><span class="circuit-name">${escapeHtml(t.title)}</span></a><span class="cap-sr-only">: needs ${NEED[/** @type {keyof typeof NEED} */ (t.grant)] ?? escapeHtml(t.grant)}</span></li>`;
  };
  const cols = BREAKERS.map(([grant, name, does]) => {
    const fed = tools.filter((t) => FEEDS[/** @type {keyof typeof FEEDS} */ (t.grant)] === grant);
    return `<div class="board-col"><button type="button" class="breaker" data-grant="${grant}" aria-pressed="${grant === "read"}"><span class="breaker-slot" aria-hidden="true"><span class="breaker-handle"></span></span><span class="breaker-name">${name}</span><span class="breaker-does">${does}</span></button>
<ol class="circuits" aria-label="Tools under the ${name.toLowerCase()}">${fed.map(circuit).join("")}</ol></div>`;
  }).join("");
  return `<section class="board wrap" aria-labelledby="board-title">
<h2 id="board-title">What an agent can reach</h2>
<p class="lead">Every tool Capsid serves, under the grant it needs, lit by the grants an agent holds. Switch a grant on or off.</p>
<div class="board-panel" data-ui data-board data-read>
<p class="board-count" role="status" data-board-count>A read-only agent: ${reachSentence(tools, held)}</p>
<div class="board-cols">${cols}</div>
</div>
</section>`;
}

/** The tour: a chapter a step, the drawing pinned beside them. */
function tour(/** @type {any} */ model, /** @type {any} */ stats) {
  const core = model.systems.find((/** @type {any} */ s) => s.ring === "core");
  const flows = flowsOf(model).filter((f) => core && f.steps.every((x) => x.touches.every((p) => p.system === core.id)));
  const life = flows.find((f) => f.id === "job-life") ?? flows[0];
  if (!life) return "";
  const readings = readingsByStep(stats);
  const chapters = life.steps
    .map((st) => {
      const { name, text } = stepWords(st);
      const kept = readings[name.toLowerCase()] ?? [];
      return `<li class="chapter" data-tour-step="${st.n}">
<h3>${escapeHtml(name)} <span class="chapter-n">${st.n} of ${life.steps.length}</span></h3>
<p>${escapeHtml(text)}</p>
<p class="chapter-parts">${st.touches.map((p) => `<span class="part-name" data-part="${escapeHtml(p.id)}">${escapeHtml(p.name)}</span>`).join("")}</p>
${kept.length ? `<dl class="readings readings-small">${kept.map(([value, label]) => reading(value, label)).join("")}</dl>` : ""}
<p class="chapter-link"><a href="${stepPath(life.id, st.n)}">This step on its own</a></p>
</li>`;
    })
    .join("");
  return `<section class="tour" id="tour" aria-labelledby="tour-title">
<div class="tour-grid wrap">
<div class="tour-words">
<h2 class="tour-title" id="tour-title">Follow one job through it</h2>
<p class="lead">${escapeHtml(life.description ?? "")} Scroll, and the job moves through Capsid's real parts.</p>
<ol class="tour-steps">${chapters}</ol>
</div>
<div class="tour-stage tour-map" data-ui>${flowStage(model, flows, life, "tour-map", false)}</div>
</div>
</section>`;
}

/** What one Worker holds, as the manual's index sets it: each section by number and name, a dotted leader to what it holds. */
function holds(/** @type {any} */ model, /** @type {any} */ stats, /** @type {any[]} */ tools, /** @type {any} */ codeIndex) {
  const rows = [
    ["/systems/", `${model.systems.length} drawn with their parts`],
    ["/flows/", `${flowsOf(model).length} told step by step`],
    ["/tools/", `${tools.length} served over MCP`],
    ["/numbers/", `${stats.store.documents.toLocaleString("en-GB")} documents held`],
    ...(codeIndex ? [["/code/", `${codeIndex.modules.toLocaleString("en-GB")} modules scored`]] : []),
  ];
  return `<section class="holds wrap" aria-labelledby="holds-title">
<h2 id="holds-title">Contents</h2>
<ol class="contents">${rows
    .map(([href, fact]) => {
      const section = sectionAt(href);
      return `<li><a href="${href}"><span class="contents-no">${section?.no}.0</span><span class="contents-name">${section?.label}</span><span class="contents-dots" aria-hidden="true"></span><span class="contents-fact">${escapeHtml(fact)}</span></a></li>`;
    })
    .join("")}</ol>
</section>`;
}

/**
 * @param {any} model @param {any} stats @param {any[]} tools the served tools (src/surface.mjs)
 * @param {any} codeIndex totals over the code maps (code.mjs, codeTotals), or null
 */
export function homePage(model, stats, tools, codeIndex) {
  const body = [hero(stats), knowledge(model, stats), board(tools), tour(model, stats), holds(model, stats, tools, codeIndex)].join("\n");
  return layout({
    title: "Capsid: one panel for every AI agent",
    description: DESCRIPTION,
    path: "/",
    body,
    asOf: stats.as_of,
    wide: true,
    data: [siteData()],
  });
}
