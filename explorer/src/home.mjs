// Pure, as pages.mjs is. Every number is from the public numbers or the model, and every sentence stating how
// Capsid works is the model's own flow text.

import { graph, thing, website } from "@drdustinedwards/site-helpers/schema";
import { escapeHtml } from "@dustinedwards/site-runtime/html";
import { Hero } from "capsomer/react/hero";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ORIGIN,
  SITE,
  flowStage,
  flowsOf,
  layout,
  manualHead,
  sectionAt,
  stepPath,
  stepWords,
} from "./pages.mjs";
import { NEED, reachSentence, reaches } from "./rules.mjs";
import { toolPath } from "./tools.mjs";

const DESCRIPTION =
  "Capsid is an open-source MCP server for AI coding agents. It gives them a shared memory and limits what each one can do.";
// A function, because pages.mjs imports this module.
const siteData = (
  AUTHOR = { "@type": "Person", "@id": `${SITE}/#person`, name: "Dustin Edwards", url: SITE },
) =>
  graph([
    website({
      origin: ORIGIN,
      name: "Capsid",
      description: DESCRIPTION,
      searchUrl: `${ORIGIN}/search/?q={search_term_string}`,
      publisher: AUTHOR,
    }),
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

const BREAKERS = [
  ["read", "Read", "Read notes and repos"],
  ["write", "Write", "Edit notes, branches and pull requests"],
  ["admin", "Admin", "Create agents and change settings"],
];

/** The grant a tool cannot work without beyond read (src/scope.ts, needFor). */
const FEEDS = {
  read: "read",
  action: "write",
  write: "write",
  admin_read: "admin",
  admin: "admin",
};

function hero() {
  const words = renderToStaticMarkup(
    h(Hero, {
      title: "One memory and one set of rules for your AI agents.",
      lead: "Capsid is an open-source MCP server you run on Cloudflare. Your agents start every session from the same project notes. Each one can use only the tools you allow.",
      actions: [
        h(
          "a",
          {
            key: "install",
            className: "cap-btn",
            "data-variant": "primary",
            "data-size": "lg",
            href: "https://github.com/DrDustinEdwards/capsid#installation",
          },
          "Install it",
        ),
        h("a", { key: "tour", className: "hero-link", href: "#tour" }, "See how it works"),
      ],
    }),
  );
  return `<div class="front cap-page">
${manualHead("/")}
${words}
</div>`;
}

// canon is the current conventions, core or decisions, which rank first (src/doc-index.ts, isCanon). Fake data, in
// the namespace "sample", as the public repo's fixtures are (CLAUDE.md, public repo rule).
/** @type {{ q: string, retired: number, rows: [string, string, boolean, boolean, boolean][] }[]} */
const SEARCHES = [
  {
    q: "Which tools may a read-only agent use?",
    retired: 1,
    rows: [
      ["Decisions", "sample/decisions.md", false, true, true],
      ["Grants and flags", "sample/specs/grants.md", true, true, false],
      ["Agent tokens", "sample/specs/agents.md", false, true, false],
      ["Session: the read grant", "sample/sessions/2026-10-20.md", true, false, false],
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

const BRIEF = [
  ["Rules for every project", "capsid/conventions.md", 6],
  ["Project overview", "sample/core.md", 9],
  ["Decisions", "sample/decisions.md", 11],
  ["3 open tasks", "sample/tasks/", 5],
  ["Last 3 session notes", "sample/sessions/", 6],
];

/** @param {any} model @param {any} stats */
function knowledge(model, stats) {
  const more = (/** @type {string} */ id, /** @type {string} */ words) =>
    flowsOf(model).some((f) => f.id === id)
      ? `<p class="kb-more"><a href="/flows/${id}/">${words}</a></p>`
      : "";
  const tag = (/** @type {boolean} */ kw, /** @type {boolean} */ mean) =>
    kw && mean ? "both" : kw ? "keyword" : "meaning";
  const results = SEARCHES.map(
    (x, i) =>
      `<ol class="kb-results" data-q="${i}"${i ? " hidden" : ""}>${x.rows
        .map(
          ([title, path, kw, mean, canon]) =>
            `<li${kw ? " data-kw" : ""}${mean ? " data-mean" : ""}><span class="kb-doc"><span class="kb-title">${escapeHtml(title)}</span><code>${escapeHtml(path)}</code></span><span class="kb-tags">${canon ? `<span class="kb-tag" data-canon>core</span>` : ""}<span class="kb-tag kb-how">${tag(kw, mean)}</span><span class="kb-tag kb-kw">keyword</span></span></li>`,
        )
        .join(
          "",
        )}</ol><p class="kb-left" data-q="${i}"${i ? " hidden" : ""}>${x.retired ? `Left out ${x.retired} closed or replaced ${x.retired === 1 ? "document" : "documents"}.` : "No closed or replaced documents matched."} Capsid rereads every meaning match from the database first, so it never shows a deleted document.</p><p class="kb-left kb-kwnote" data-q="${i}"${i ? " hidden" : ""}>Keywords alone find ${x.rows.filter((r) => r[2]).length} of ${x.rows.length}. Add meaning to find documents that use other words.</p>`,
  ).join("");
  const total = BRIEF.reduce((n, b) => n + Number(b[2]), 0);
  return `<section class="kb cap-page" id="memory" aria-labelledby="kb-title">
<h2 id="kb-title">Agents remember the project</h2>
<p class="lead">Capsid keeps each project's notes, decisions and session logs in one place. Agents search it, and every new session starts from it. Each edit keeps the old version. This server holds ${stats.store.documents.toLocaleString("en-US")} documents in ${stats.store.namespaces} namespaces.</p>
<div class="kb-grid">
<div class="kb-box" data-ui data-kb-search data-mode="hybrid">
<h3 class="kb-head">Search it <span>Example notes</span></h3>
<div class="kb-qs" role="group" aria-label="The question">${SEARCHES.map((x, i) => `<button type="button" class="kb-q" data-ask="${i}" aria-pressed="${i === 0}">${escapeHtml(x.q)}</button>`).join("")}</div>
<div class="kb-modes" role="group" aria-label="How it searches"><button type="button" class="kb-mode" data-mode-set="keyword" aria-pressed="false">Keyword</button><button type="button" class="kb-mode" data-mode-set="hybrid" aria-pressed="true">Keyword and meaning</button></div>
<div class="kb-out" aria-live="polite">${results}</div>
${more("doc-search", "How search works")}
</div>
<div class="kb-box" data-ui data-session>
<h3 class="kb-head">Start a session</h3>
<p class="kb-actions"><button type="button" class="cap-btn" data-variant="primary" data-start>Start a session</button><button type="button" class="cap-btn" data-write disabled>Write a note</button></p>
<ol class="kb-brief">${BRIEF.map(([name, path, kb]) => `<li data-brief><span class="kb-doc"><span class="kb-title">${name}</span><code>${path}</code></span><span class="kb-size">${kb} KB</span></li>`).join("")}<li data-brief data-mine hidden><span class="kb-doc"><span class="kb-title">Your note from last session</span><code>sample/sessions/2026-10-25.md</code></span><span class="kb-size">1 KB</span></li></ol>
<div class="kb-budget"><div class="cap-meter" data-cap="meter" data-size="sm"><span class="cap-meter-label" id="kb-budget-label">The session's brief</span><span class="cap-meter-value" data-budget-words>${total} KB of the 40 KB limit. Nothing cut.</span><span class="cap-meter-bar" role="meter" aria-labelledby="kb-budget-label" aria-valuemin="0" aria-valuemax="40" aria-valuenow="${total}" aria-valuetext="${total} KB of the 40 KB limit" data-budget><span class="cap-meter-fill"></span></span></div></div>
<p class="kb-said" role="status" data-session-said></p>
${more("session-start", "How a session starts")}
</div>
</div>
</section>`;
}

/** @param {any[]} tools */
function board(tools) {
  const held = { read: true, write: false, admin: false };
  const circuit = (/** @type {any} */ t) => {
    const on = reaches(t.grant, held);
    return `<li class="circuit" data-need="${escapeHtml(t.grant)}"${on ? ` data-on="${on}"` : ""}><a href="${toolPath(t.name)}"><span class="lamp" aria-hidden="true"></span><span class="circuit-name">${escapeHtml(t.title)}</span></a><span class="cap-sr-only">: needs ${NEED[/** @type {keyof typeof NEED} */ (t.grant)] ?? escapeHtml(t.grant)}</span></li>`;
  };
  const cols = BREAKERS.map(([grant, name, does]) => {
    const fed = tools.filter((t) => FEEDS[/** @type {keyof typeof FEEDS} */ (t.grant)] === grant);
    return `<div class="board-col"><button type="button" class="breaker" data-grant="${grant}" aria-pressed="${grant === "read"}"><span class="breaker-slot" aria-hidden="true"><span class="breaker-handle"></span></span><span class="breaker-name">${name}</span><span class="breaker-does">${does}</span></button>
<ol class="circuits" aria-label="Tools that need ${name.toLowerCase()} access">${fed.map(circuit).join("")}</ol></div>`;
  }).join("");
  return `<section class="board cap-page" aria-labelledby="board-title">
<h2 id="board-title">Agents use only what you allow</h2>
<div class="board-panel" data-ui data-board data-read>
<p class="board-count" role="status" data-board-count>${reachSentence(
    tools.map((t) => t.grant),
    held,
  )}</p>
<div class="board-cols">${cols}</div>
</div>
</section>`;
}

function tour(/** @type {any} */ model) {
  const core = model.systems.find((/** @type {any} */ s) => s.ring === "core");
  const flows = flowsOf(model).filter(
    (f) => core && f.steps.every((x) => x.touches.every((p) => p.system === core.id)),
  );
  const life = flows.find((f) => f.id === "session-start") ?? flows[0];
  if (!life) return "";
  const chapters = life.steps
    .map((st) => {
      const { name, text } = stepWords(st);
      return `<li class="chapter" data-tour-step="${st.n}">
<h3>${escapeHtml(name)} <span class="chapter-n">${st.n} of ${life.steps.length}</span></h3>
<p>${escapeHtml(text)}</p>
<p class="chapter-parts">${st.touches.map((p) => `<span class="part-name" data-part="${escapeHtml(p.id)}">${escapeHtml(p.name)}</span>`).join("")}</p>
<p class="chapter-link"><a href="${stepPath(life.id, st.n)}">Open this step</a></p>
</li>`;
    })
    .join("");
  return `<section class="tour" id="tour" aria-labelledby="tour-title">
<div class="tour-grid cap-page">
<div class="tour-words">
<h2 class="tour-title" id="tour-title">${escapeHtml(life.name)}</h2>
<p class="lead">${escapeHtml(life.description ?? "")}</p>
<ol class="tour-steps">${chapters}</ol>
</div>
<div class="tour-stage tour-map" data-ui>${flowStage(model, flows, life, "tour-map", false)}</div>
</div>
</section>`;
}

function holds(
  /** @type {any} */ model,
  /** @type {any} */ stats,
  /** @type {any[]} */ tools,
  /** @type {any} */ codeIndex,
) {
  const rows = [
    ["/systems/", `${model.systems.length} drawn with their parts`],
    ["/flows/", `${flowsOf(model).length} told step by step`],
    ["/tools/", `${tools.length} served over MCP`],
    ["/numbers/", `${stats.store.documents.toLocaleString("en-US")} documents held`],
    ...(codeIndex
      ? [["/code/", `${codeIndex.modules.toLocaleString("en-US")} modules scored`]]
      : []),
  ];
  return `<section class="holds cap-page" aria-labelledby="holds-title">
<h2 id="holds-title">Contents</h2>
<ol class="cap-leader-index contents">${rows
    .map(([href, fact]) => {
      const section = sectionAt(href);
      return `<li><a class="cap-leader-index-link" href="${href}"><span class="cap-leader-index-no">${section?.no}.0</span><span class="cap-leader-index-name">${section?.label}</span><span class="cap-leader-index-dots" aria-hidden="true"></span><span class="cap-leader-index-fact">${escapeHtml(fact)}</span></a></li>`;
    })
    .join("")}</ol>
</section>`;
}

/** @param {any} model @param {any} stats @param {any[]} tools @param {any} codeIndex */
export function homePage(model, stats, tools, codeIndex) {
  const body = [
    hero(),
    knowledge(model, stats),
    board(tools),
    tour(model),
    holds(model, stats, tools, codeIndex),
  ].join("\n");
  return layout({
    title: "Capsid: shared memory and access control for AI coding agents",
    fullTitle: true,
    description: DESCRIPTION,
    path: "/",
    body,
    asOf: stats.as_of,
    wide: true,
    data: [siteData()],
  });
}
