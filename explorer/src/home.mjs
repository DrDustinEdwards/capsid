// The front page: what Capsid is, shown by its own parts at work rather than described. The
// hero plays a job's life on Capsid's real insides; below it, the served tools to choose from,
// how a claim becomes done, the weekly jobs as bars, six of its parts each with a working
// fragment, the family as a ledger, and the three flows step by step. Pure, as pages.mjs is.
//
// Every number is from the public numbers or the model; every sentence that states a fact about
// how Capsid works is one its own docs state (README.md, docs/work-queue.md, docs/backups.md).
import { systemMapHtml } from "capsomer/behaviour/system-map";

import { escapeHtml, flowPath, flowsOf, layout, mapData, markStep, minutes, percent, stepPath, systemPath } from "./pages.mjs";
import { toolPath } from "./tools.mjs";

const RING_WORD = { core: "Runs everything", shared: "Shared part", used: "What people use" };

/** A bar's height class, 0 to 100 in whole percent (explorer.css), so no style attribute is needed. @param {number} v @param {number} max */
export const heightClass = (v, max) => `h-${max > 0 ? Math.round((v / max) * 100) : 0}`;

/** The week each bar of a weekly series ends on, labelled as the numbers page does. @param {any} stats */
export function weekLabels(stats) {
  const end = new Date(Date.parse(`${stats.as_of}T00:00:00Z`) - 86_400_000);
  return stats.jobs.completed_by_week.map((/** @type {number} */ _c, /** @type {number} */ i, /** @type {number[]} */ all) =>
    new Date(end.getTime() - (all.length - 1 - i) * 7 * 86_400_000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).replace("Sept", "Sep")
  );
}

/** The hero: the headline and its action, and the core drawn inside, playing a job's life. */
function hero(/** @type {any} */ model, /** @type {any} */ stats, /** @type {any[]} */ tools) {
  const core = model.systems.find((/** @type {any} */ s) => s.ring === "core");
  const flows = flowsOf(model).filter((f) => core && f.steps.every((x) => x.touches.every((p) => p.system === core.id)));
  const life = flows.find((f) => f.id === "job-life") ?? flows[0];
  let stage = "";
  if (life) {
    const data = { ...mapData(model), flows: flows.map((f) => ({ id: f.id, name: f.name, steps: f.steps.map((x) => ({ from: x.from.id, to: x.to.id, toward: x.toward, text: x.text, lights: x.lights.map((p) => p.id) })) })) };
    const map = markStep(systemMapHtml(data, { id: "hero-map", label: `Inside ${core.name}`, headingLevel: 2 }), life.steps[0]);
    stage = `<div class="hero-stage" data-ui>
<div class="map-host flow-map hero-map" data-flow="${escapeHtml(life.id)}" data-step="1" data-steps="${life.steps.length}" data-player>${map}</div>
<p class="hero-play"><button class="cap-btn" type="button" data-autoplay hidden>Play</button><span class="hint">${escapeHtml(life.name)}, in ${life.steps.length} steps, over Capsid's real parts.</span></p>
</div>`;
  }
  const lifeHref = life ? stepPath(life.id, 1) : "/flows/";
  return `<section class="hero" aria-labelledby="hero-title">
<div class="hero-text">
<h1 id="hero-title">The control plane behind every project</h1>
<p class="hero-sub">Capsid holds the knowledge, the work queue and the keys for ${model.systems.length} systems, and checks what every agent claims against GitHub before a job counts as done.</p>
<p class="hero-actions"><a class="cap-btn" data-variant="primary" href="${lifeHref}" data-play-hero>Watch a job's life</a><a class="arrow" href="/systems/">See all ${model.systems.length} systems</a></p>
<dl class="hero-facts">
<div><dt>Tools served</dt><dd>${tools.length}</dd></div>
<div><dt>Documents</dt><dd>${stats.store.documents.toLocaleString("en-GB")}</dd></div>
<div><dt>Claims agreeing with GitHub</dt><dd>${percent(stats.verification.agreement_rate_90d)}</dd></div>
<div><dt>Sites up, last 7 days</dt><dd>${percent(stats.sites.uptime_7d)}</dd></div>
</dl>
</div>
${stage}
</section>`;
}

/** What Capsid is, in one lead and four short answers. */
function intro(/** @type {any} */ model, /** @type {any} */ stats, /** @type {any[]} */ tools) {
  const own = model.containers.filter((/** @type {any} */ c) => c.system === "capsid" && c.kind !== "external");
  const capsidTools = tools.filter((t) => t.server === "Capsid").length;
  return `<section class="intro band" aria-labelledby="intro-title">
<h2 id="intro-title" class="cap-sr-only">What Capsid is</h2>
<p class="intro-lead">Capsid is one Cloudflare Worker that every project and every AI session runs through. It stores what they know, queues what they do, holds the keys they may use, and records what each agent claims beside what GitHub says happened.</p>
<div class="intro-cols">
<p><strong>What it holds.</strong> ${stats.store.documents.toLocaleString("en-GB")} documents in ${stats.store.namespaces} namespaces, one per project, found by keyword and by meaning. Every overwrite keeps the body before it, for 90 days.</p>
<p><strong>Who runs it.</strong> Dustin Edwards and named co-owners, signed in through Cloudflare Access. Agents carry keys scoped to their namespaces and grants, and every call passes one scope check.</p>
<p><strong>Where it runs.</strong> ${own.length} parts on Cloudflare: ${own.map((/** @type {any} */ c) => escapeHtml(c.name)).join(", ")}. A merge to master deploys it, and CI reads the live /health before calling the deploy good.</p>
<p><strong>How agents reach it.</strong> Over MCP, ${capsidTools} tools on Capsid and ${tools.length - capsidTools} on Capsid Admin, each naming the grant it needs. <a href="/tools/">Every tool and its arguments</a>.</p>
</div>
</section>`;
}

/** The tools to choose from: the panel shows one, the rows beside it choose. */
function toolShowcase(/** @type {any[]} */ tools) {
  const words = (/** @type {any} */ t) => [t.hints.readOnlyHint ? "Reads only" : t.hints.destructiveHint ? "Can change or remove" : "Adds", t.server === "Capsid Admin" ? "Admin only" : `${t.grant} grant`];
  const first = (/** @type {string} */ text) => text.split("\n\n")[0];
  const panels = tools
    .map(
      (t, i) => `<div class="tool-view" id="tv-${escapeHtml(t.name)}"${i ? " hidden" : ""}>
<p class="tool-name"><code>${escapeHtml(t.name)}</code></p>
<h3>${escapeHtml(t.title)}</h3>
<p>${escapeHtml(first(t.description)).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>
<p class="tool-tags">${words(t).map((w) => `<span class="cap-pill">${escapeHtml(w)}</span>`).join("")}</p>
${t.actions.length ? `<ul class="tool-actions">${t.actions.map((/** @type {any} */ a) => `<li><code>${escapeHtml(a.name)}</code> ${escapeHtml(a.summary || "")}</li>`).join("")}</ul>` : `<p class="hint">One action, ${t.params.length} argument${t.params.length === 1 ? "" : "s"}.</p>`}
<p><a href="${toolPath(t.name)}">Every argument of ${escapeHtml(t.name)}</a></p>
</div>`
    )
    .join("");
  const rows = tools
    .map(
      (t, i) =>
        `<li><a class="tool-row" href="${toolPath(t.name)}" data-tool="tv-${escapeHtml(t.name)}"${i ? "" : ' aria-current="true"'}><span>${escapeHtml(t.title)}</span><span class="tool-row-n">${t.actions.length || 1}</span></a></li>`
    )
    .join("");
  return `<section class="showcase wrap" aria-labelledby="tools-title">
<h2 id="tools-title">Every tool it serves</h2>
<p class="section-sub">${tools.length} tools over MCP, read from the registrations the Worker makes. Choose one to see what it does.</p>
<div class="tool-panel" data-ui data-tool-panel>
<div class="tool-stage">${panels}</div>
<div class="tool-list"><p class="tool-list-head"><span>Tool</span><span>Actions</span></p><ul>${rows}</ul></div>
</div>
<p class="hint"><a href="/tools/">The full catalogue</a>, filterable by what each tool may do.</p>
</section>`;
}

/** How a claim becomes done: three statements, and one job fragment changing with them. */
function pinned(/** @type {any} */ stats) {
  const v = stats.verification;
  const g = stats.gates;
  const j = stats.jobs;
  const statements = [
    ["An agent takes a job and works one branch.", `${j.open} jobs are open today and ${j.blocked} are blocked on a person. Half of last month's jobs took under ${minutes(j.median_duration_minutes_30d)}.`],
    ["Risky steps wait for a person or a signed policy.", `${g.waits_30d} waits in the last 30 days, half of them answered within ${minutes(g.median_wait_minutes_30d)}; ${percent(g.share_ended_by_policy_30d)} were ended by the signed auto-merge policy.`],
    ["Done means GitHub agrees.", `Of ${v.evaluations_90d} claims checked in 90 days, ${percent(v.agreement_rate_90d)} matched GitHub. ${percent(v.pr_merge_rate_90d)} of claimed pull requests merged, and ${percent(v.ci_green_rate_90d)} were green.`],
  ];
  const row = (/** @type {string} */ k, /** @type {string} */ val, /** @type {string} */ tone = "") => `<div class="job-row"><dt>${k}</dt><dd${tone ? ` data-tone="${tone}"` : ""}>${val}</dd></div>`;
  const states = [
    `<p class="job-state" data-tone="info">Claimed</p><dl>${row("Job", "Fix the export button on Safari")}${row("Namespace", "sample")}${row("Branch", "<code>fix/safari-export</code>")}${row("Holder", "one session, until it finishes")}</dl>`,
    `<p class="job-state" data-tone="warn">Waiting for approval</p><dl>${row("Step", "Merge pull request #12")}${row("Command", "<code>capsid_close_pr merge</code>")}${row("Asked", "a person, or the signed policy")}${row("Resumes", "the moment either answers")}</dl>`,
    `<p class="job-state" data-tone="ok">Done, checked</p><dl>${row("Pull request merged", "claimed yes, GitHub yes", "ok")}${row("CI green on its head", "claimed yes, GitHub yes", "ok")}${row("Live /health sha", "matches the merge", "ok")}${row("Agreement", "agree", "ok")}</dl>`,
  ];
  return `<section class="pin wrap" aria-labelledby="pin-title" data-pin>
<h2 id="pin-title">How work becomes done</h2>
<div class="pin-grid">
<ol class="pin-steps">${statements.map(([head, sub], i) => `<li class="pin-step" data-pin-step="${i}"><p class="pin-head">${escapeHtml(head)}</p><p>${escapeHtml(sub)}</p></li>`).join("")}</ol>
<div class="pin-stage" data-ui aria-label="A sample job, as Capsid records it" role="img">${states.map((html, i) => `<div class="job-card" data-pin-state="${i}">${html}</div>`).join("")}<p class="pin-note">A sample job. The numbers beside it are Capsid's own.</p></div>
</div>
</section>`;
}

/** The weekly jobs as bars standing on the page's edge, the busiest week in the accent. */
function bars(/** @type {any} */ stats) {
  const weeks = weekLabels(stats);
  const values = stats.jobs.completed_by_week;
  const max = Math.max(...values, 1);
  const top = values.indexOf(Math.max(...values));
  const labelled = new Set([top, 0, values.length - 1]);
  return `<section class="edge band" aria-labelledby="edge-title">
<div class="wrap edge-head">
<p class="edge-figure">${stats.jobs.completed_30d}</p>
<h2 id="edge-title">jobs finished in 30 days</h2>
<p class="section-sub">Each bar is one whole week; the tallest, the week ending ${escapeHtml(weeks[top])}, is marked. <a href="/numbers/">Every number, with its trends</a>.</p>
</div>
<ol class="edge-bars" data-ui>${values
    .map(
      (/** @type {number} */ v, /** @type {number} */ i) =>
        `<li class="edge-bar ${heightClass(v, max)}${i === top ? " is-top" : ""}" tabindex="0"><span class="edge-value${labelled.has(i) ? " is-shown" : ""}">${v}</span><span class="edge-week">${escapeHtml(weeks[i])}</span><span class="cap-sr-only">: ${v} jobs in the week ending ${escapeHtml(weeks[i])}</span></li>`
    )
    .join("")}</ol>
</section>`;
}

/** Six of Capsid's parts, each a cell with its own working fragment. */
function features(/** @type {any} */ model, /** @type {any} */ stats, /** @type {any} */ codeIndex) {
  const backup = flowsOf(model).find((f) => f.id === "nightly-backup");
  const cells = [
    {
      title: "The knowledge store",
      text: `Rulings, research, jobs and notes for every project: ${stats.store.documents.toLocaleString("en-GB")} documents in ${stats.store.namespaces} namespaces, each overwrite versioned.`,
      href: "/tools/capsid_find_docs/",
      link: "How a session searches it",
      ui: `<div class="frag frag-search"><p class="frag-field"><span class="frag-icon" aria-hidden="true"></span>search by meaning</p><ul><li><strong>capsid/research/design-hybrid-search.md</strong><span>keyword and meaning</span></li><li><strong>capsid/research/improvement-list.md</strong><span>meaning</span></li><li><strong>capsid/core.md</strong><span>meaning</span></li></ul></div>`,
    },
    {
      title: "The work queue",
      text: `Signed job bodies, each held by one agent until it finishes, and done only on evidence. ${stats.jobs.open} open today, ${stats.jobs.blocked} blocked.`,
      href: "/tools/capsid_work_jobs/",
      link: "The queue's actions",
      ui: `<div class="frag frag-queue"><p><span>Open</span><strong>${stats.jobs.open}</strong></p><p><span>Blocked</span><strong>${stats.jobs.blocked}</strong></p><p><span>Done, 7 days</span><strong>${stats.jobs.completed_7d}</strong></p><p><span>Failed, 30 days</span><strong>${stats.jobs.failed_30d}</strong></p></div>`,
    },
    {
      title: "Approval gates",
      text: "A push, a deploy, a secret or a merge stops the agent until a person or the signed policy says yes.",
      href: "/numbers/#gates",
      link: "Waits, week by week",
      ui: `<div class="frag frag-gate"><p class="frag-gate-q">Merge #12 into master?</p><p class="frag-gate-a"><span class="cap-btn" data-variant="primary" aria-hidden="true">Approve</span><span class="cap-btn" aria-hidden="true">Ask why</span></p><p class="hint">${percent(stats.gates.share_ended_by_policy_30d)} ended by policy, last 30 days</p></div>`,
    },
    {
      title: "The watcher",
      text: `Every five minutes it reads each of ${stats.sites.watched} sites: its health route, CI, deploys and live answers.`,
      href: "/numbers/#sites",
      link: "Uptime and what it measures",
      ui: `<div class="frag frag-uptime"><p><strong>${percent(stats.sites.uptime_7d)}</strong> of ${stats.sites.slots_measured_7d.toLocaleString("en-GB")} half-hours answered</p><div class="frag-strip" aria-hidden="true">${Array.from({ length: 48 }, (_, i) => (i < Math.round((1 - (stats.sites.uptime_7d ?? 1)) * 48) ? '<span class="down"></span>' : "<span></span>")).join("")}</div></div>`,
    },
    {
      title: "The nightly backup",
      text: "Every table to R2 with a completion marker, kept on a schedule, copied off the account, rehearsed weekly.",
      href: backup ? flowPath(backup.id) : "/flows/",
      link: backup ? `${backup.name}, in ${backup.steps.length} steps` : "The flows",
      ui: backup ? `<ol class="frag frag-steps">${backup.steps.slice(0, 4).map((st) => `<li>${escapeHtml(st.text.split(":")[0])}</li>`).join("")}</ol>` : "",
    },
    {
      title: "Code health",
      text: codeIndex ? `${codeIndex.modules.toLocaleString("en-GB")} modules in ${codeIndex.repos} public repos, each function scored for risk and for how well its tests catch bugs.` : "Each public repo's modules, scored for risk once their code maps are built.",
      href: "/code/",
      link: "The riskiest functions",
      ui: codeIndex?.worst
        ? `<div class="frag frag-code"><p><code>${escapeHtml(codeIndex.worst.name)}</code></p><p class="hint">${escapeHtml(codeIndex.worst.path)}</p><p><span class="cap-pill" data-tone="crit">CRAP ${Math.round(codeIndex.worst.crap)}</span> complexity ${codeIndex.worst.cc}</p></div>`
        : "",
    },
  ];
  return `<section class="features wrap" aria-labelledby="features-title">
<h2 id="features-title">What it is made of</h2>
<div class="feature-grid">${cells
    .map(
      (c, i) => `<article class="feature${i % 2 ? " is-flip" : ""}"><div class="feature-text"><h3>${escapeHtml(c.title)}</h3><p>${escapeHtml(c.text)}</p><p><a class="arrow" href="${c.href}">${escapeHtml(c.link)}</a></p></div><div class="feature-ui" data-ui>${c.ui}</div></article>`
    )
    .join("")}</div>
</section>`;
}

/** The family as a ledger: one row a system, its preview beside the column. */
function ledger(/** @type {any} */ model) {
  const parts = (/** @type {string} */ id) => model.containers.filter((/** @type {any} */ c) => c.system === id && c.kind !== "external").length;
  const links = (/** @type {string} */ id) => model.relationships.filter((/** @type {any} */ r) => r.from === id || r.to === id).length;
  const rows = model.systems
    .map(
      (/** @type {any} */ s) => `<li><a class="ledger-row" href="${systemPath(s.id)}" data-preview="lp-${escapeHtml(s.id)}"><span class="ledger-name">${escapeHtml(s.name)}</span><span class="ledger-kind">${escapeHtml(RING_WORD[/** @type {keyof typeof RING_WORD} */ (s.ring)] ?? s.ring)}${s.private ? ", private" : ""}</span><span class="ledger-domain">${escapeHtml(s.domain || "")}</span></a></li>`
    )
    .join("");
  const previews = model.systems
    .map(
      (/** @type {any} */ s) => `<div class="ledger-preview" id="lp-${escapeHtml(s.id)}" hidden><p class="ledger-preview-name">${escapeHtml(s.name)}</p><p>${escapeHtml(s.description ?? (s.private ? "Private: its name and address only." : ""))}</p><p class="hint">${parts(s.id)} parts drawn, ${links(s.id)} connections</p></div>`
    )
    .join("");
  return `<section class="ledger wrap" aria-labelledby="ledger-title">
<h2 id="ledger-title">The ${model.systems.length} systems</h2>
<div class="ledger-grid"><ul class="ledger-list" data-ledger>${rows}</ul><div class="ledger-side" aria-hidden="true">${previews}</div></div>
<p class="hint"><a href="/systems/">The family drawn as a capsid</a>, with every connection.</p>
</section>`;
}

/** The flows as tabs, each a banded list of its steps. */
function flowTabs(/** @type {any} */ model) {
  const flows = flowsOf(model);
  if (!flows.length) return "";
  const systems = new Map(model.systems.map((/** @type {any} */ s) => [s.id, s.name]));
  const tabs = flows
    .map((f, i) => `<button type="button" class="cap-tab" role="tab" id="ft-${escapeHtml(f.id)}" aria-selected="${i ? "false" : "true"}" aria-controls="fp-${escapeHtml(f.id)}" tabindex="${i ? "-1" : "0"}">${escapeHtml(f.name)}<span class="cap-tab-count">${f.steps.length}</span></button>`)
    .join("");
  const panels = flows
    .map((f, i) => {
      const touched = [...new Set(f.steps.flatMap((st) => st.touches.map((p) => systems.get(p.system) ?? p.system)))];
      return `<div class="cap-tabs-panel" role="tabpanel" id="fp-${escapeHtml(f.id)}" aria-labelledby="ft-${escapeHtml(f.id)}" tabindex="0"${i ? " hidden" : ""}>
<p class="section-sub">${escapeHtml(f.description ?? "")} Over ${touched.map((n) => escapeHtml(String(n))).join(", ")}. <a href="${stepPath(f.id, 1)}">Play it</a>.</p>
<ol class="bands">${f.steps.map((st) => `<li><a href="${stepPath(f.id, st.n)}"><span class="band-text">${escapeHtml(st.text)}</span><span class="band-parts">${st.touches.map((p) => escapeHtml(p.name)).join(", ")}</span></a></li>`).join("")}</ol>
</div>`;
    })
    .join("");
  return `<section class="flows-home wrap" aria-labelledby="flows-title">
<div class="flows-head"><h2 id="flows-title">What runs, step by step</h2><a class="cap-btn" href="/flows/">Every flow</a></div>
<div class="cap-tabs" data-cap="tabs"><div class="cap-tabs-list" role="tablist" aria-label="Flows">${tabs}</div>${panels}</div>
</section>`;
}

/**
 * @param {any} model @param {any} stats @param {any[]} tools the served tools (src/surface.mjs)
 * @param {any} codeIndex totals over the code maps (code.mjs, codeTotals), or null
 */
export function homePage(model, stats, tools, codeIndex) {
  const body = [hero(model, stats, tools), intro(model, stats, tools), toolShowcase(tools), pinned(stats), bars(stats), features(model, stats, codeIndex), ledger(model), flowTabs(model)].join("\n");
  return layout({
    title: "Capsid, inside and out",
    description: `Capsid runs ${model.systems.length} systems and the AI sessions that work on them: its parts, its tools, its flows and its daily numbers.`,
    path: "/",
    body,
    asOf: stats.as_of,
    wide: true,
  });
}

