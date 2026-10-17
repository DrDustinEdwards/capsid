// The code level (capsid/research/design-system-explorer.md, section 5; slice 9 of its build
// order): a public system's modules by folder, each with its worst CRAP and its mutation score,
// its import cycles as text, and each module's functions over its numbered source at the commit
// the map measured. Pure, as pages.mjs is: build.mjs reads the code document and the source and
// passes them in.
//
// Every status is Capsomer's: a glyph whose shape carries it, a word, and the tone's colour
// (components/status). A number nobody measured is "No data" with its reason, never a zero.
import { graphSvg } from "./graph.mjs";
import { escapeHtml, layout, systemPath } from "./pages.mjs";

/** @param {string} id */
export const codePath = (id) => `/s/${id}/code/`;
/** A module's page, its repo path under the system's code page. @param {string} id @param {string} path */
export const modulePath = (id, path) => `/s/${id}/code/${path}/`;

// Section 5: CRAP up to 5 ok, 5 to 30 watch, over 30 critical (crap4j's threshold); mutation
// 80% and up ok, 60 to 80 watch, under 60 critical.
const CRAP_WATCH = 5;
const CRAP_CRIT = 30;
const SCORE_OK = 80;
const SCORE_WATCH = 60;

const GLYPH = {
  crit: '<path fill="currentColor" fill-rule="evenodd" d="M5 1h6l4 4v6l-4 4H5l-4-4V5zM7.2 4h1.6v5H7.2zM7.2 10.4h1.6V12H7.2z"/>',
  warn: '<path fill="currentColor" fill-rule="evenodd" d="M8 1.2 15.4 14H.6zM7.3 6h1.4v4H7.3zM7.3 11h1.4v1.4H7.3z"/>',
  ok: '<path fill="currentColor" fill-rule="evenodd" d="M8 1a7 7 0 1 0 0 14A7 7 0 1 0 8 1zM3.9 9l3 3 5.2-5.6-1.4-1.4-3.8 4.2-1.6-1.6z"/>',
  nodata: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 8h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};
const WORD = { crit: "Critical", warn: "Watch", ok: "Ok" };

/**
 * Capsomer's status: glyph, word, then the number. No data says why, in two words and a
 * screen-reader reason, as Capsomer writes it for a table cell.
 * @param {"crit" | "warn" | "ok" | "nodata"} tone @param {string} value @param {string} [reason]
 */
function status(tone, value, reason) {
  const glyph = `<svg class="cap-status-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${GLYPH[tone]}</svg>`;
  if (tone === "nodata") return `<span class="cap-status" data-tone="nodata" title="${escapeHtml(reason ?? "")}">${glyph}No data<span class="cap-sr-only">: ${escapeHtml(reason ?? "")}</span></span>`;
  return `<span class="cap-status" data-tone="${tone}">${glyph}${WORD[tone]}<span class="code-num">${escapeHtml(value)}</span></span>`;
}

/** @param {number | null} crap @returns {"crit" | "warn" | "ok" | "nodata"} */
const crapTone = (crap) => (crap === null ? "nodata" : crap > CRAP_CRIT ? "crit" : crap > CRAP_WATCH ? "warn" : "ok");
/** @param {number | null} score @returns {"crit" | "warn" | "ok" | "nodata"} */
const scoreTone = (score) => (score === null ? "nodata" : score >= SCORE_OK ? "ok" : score >= SCORE_WATCH ? "warn" : "crit");
const crapText = (/** @type {number} */ crap) => `CRAP ${Math.round(crap * 10) / 10}`;

/** @param {number | null} crap @param {string} reason */
export function crapStatus(crap, reason) {
  return crap === null ? status("nodata", "", reason) : status(crapTone(crap), crapText(crap));
}

/** @param {number | null} score @param {string} reason */
export function scoreStatus(score, reason) {
  return score === null ? status("nodata", "", reason) : status(scoreTone(score), `${score}%`);
}

/**
 * A box's status lines in the drawing: its worst CRAP, and its mutation score once mutation has
 * run on the repo. @param {any} map @param {any[]} mods the modules the box stands for
 */
function boxLines(map, mods) {
  const fns = mods.flatMap((m) => m.functions);
  const worst = worstCrap({ functions: fns });
  const lines = [{ tone: crapTone(worst), text: worst !== null ? crapText(worst) : fns.length ? "no coverage" : "no functions" }];
  if (map.tools.mutation) {
    const score = moduleScore({ functions: fns });
    lines.push({ tone: scoreTone(score), text: score === null ? "no mutants" : `mutation ${score}%` });
  }
  return lines;
}

/** Why a number is missing, from what the map says ran. @param {any} map */
const reasons = (map) => ({
  fnCrap: "no coverage report in this map",
  score: map.tools.mutation ? "no mutants in this code" : "mutation testing has not run on this repo yet",
});

/** The largest of a module's function CRAPs, or null when none was measured. @param {any} m */
const worstCrap = (m) => m.functions.reduce((/** @type {number | null} */ w, /** @type {any} */ f) => (f.crap === null ? w : Math.max(w ?? 0, f.crap)), null);

/** A module's mutation score over all its functions' mutants, or null. @param {any} m */
function moduleScore(m) {
  const measured = m.functions.filter((/** @type {any} */ f) => f.mutants !== null && f.mutants > 0 && f.score !== null);
  const mutants = measured.reduce((/** @type {number} */ n, /** @type {any} */ f) => n + f.mutants, 0);
  if (mutants === 0) return null;
  const detected = measured.reduce((/** @type {number} */ n, /** @type {any} */ f) => n + (f.score / 100) * f.mutants, 0);
  return Math.round((detected / mutants) * 1000) / 10;
}

/** @param {string} path */
const folderOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
/** @param {string} path */
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

/** A repo's GitHub address from its "owner/name". @param {string} repo */
const repoUrl = (repo) => `https://github.com/${repo}`;
/** @param {any} map @param {string} path @param {number} [line] @param {number} [end] */
const blobUrl = (map, path, line, end) => `${repoUrl(map.repo)}/blob/${map.sha}/${path}${line ? `#L${line}${end && end !== line ? `-L${end}` : ""}` : ""}`;

const scroller = (/** @type {string} */ id, /** @type {string} */ inner, /** @type {string} */ label) =>
  `<div class="scroller" id="${id}" role="region" aria-label="${escapeHtml(label)}" tabindex="0">${inner}</div>`;

/**
 * The code maps of public systems, checked against the model: a map for a system the model does
 * not have as public stops the build, as a flow touching a private part does (design section 2,
 * rule 2), so the explorer can never draw a private system's code.
 * @param {any} model @param {any} code
 * @returns {Map<string, any[]>} system id to its maps
 */
export function codeBySystem(model, code) {
  const systems = new Map(model.systems.map((/** @type {any} */ s) => [s.id, s]));
  /** @type {Map<string, any[]>} */
  const out = new Map();
  for (const map of code?.maps ?? []) {
    const s = systems.get(map.system);
    if (!s || s.private !== false) throw new Error(`the code map of ${map.repo} belongs to ${map.system}, which is not a public system in the model`);
    const theirs = out.get(s.id) ?? [];
    // A module's address is its path under the system, so two repos of one system must not share a path.
    const clash = map.modules.find((/** @type {any} */ m) => theirs.some((o) => o.modules.some((/** @type {any} */ x) => x.path === m.path)));
    if (clash) throw new Error(`two code maps of ${s.id} both have ${clash.path}`);
    out.set(s.id, [...theirs, map]);
  }
  return out;
}

/** The one-line summary a system page links with. @param {any[]} maps */
export function codeSummary(maps) {
  const modules = maps.reduce((n, m) => n + m.modules.length, 0);
  const functions = maps.reduce((n, m) => n + m.modules.reduce((/** @type {number} */ k, /** @type {any} */ x) => k + x.functions.length, 0), 0);
  return `${modules} modules and ${functions} functions, measured ${maps[0].date}`;
}

/** @param {any} s the system @param {any[]} maps @param {string} asOf */
export function codePage(s, maps, asOf) {
  const sections = maps.map((map) => {
    const r = reasons(map);
    const fns = map.modules.flatMap((/** @type {any} */ m) => m.functions);
    const counts = { crit: 0, warn: 0, ok: 0 };
    for (const f of fns) if (f.crap !== null) counts[f.crap > CRAP_CRIT ? "crit" : f.crap > CRAP_WATCH ? "warn" : "ok"]++;
    const folders = new Map();
    for (const m of map.modules) folders.set(folderOf(m.path), [...(folders.get(folderOf(m.path)) ?? []), m]);
    const repoName = map.repo.split("/")[1];
    const id = (/** @type {string} */ suffix) => `${escapeHtml(repoName)}-${suffix}`;
    const folderId = (/** @type {string} */ folder) => `${id("f")}-${escapeHtml(folder.replace(/[^A-Za-z0-9]+/g, "-"))}`;
    const folderName = (/** @type {string} */ folder) => (folder === "." ? "The top folder" : `${folder}/`);
    // Folders first when there are several: a box per folder, a wire where any module imports
    // across, each box leading to its folder's own drawing and table below.
    const folderGraph =
      folders.size > 1
        ? graphSvg({
            id: id("folders"),
            title: `The folders of ${map.repo} and the imports between them`,
            boxes: [...folders].map(([folder, mods]) => ({ id: folder, label: folderName(folder), href: `#${folderId(folder)}`, lines: boxLines(map, mods), cycle: mods.some((/** @type {any} */ m) => m.cycle) })),
            wires: map.modules.flatMap((/** @type {any} */ m) => m.imports.map((/** @type {string} */ to) => ({ from: folderOf(m.path), to: folderOf(to) }))),
          })
        : "";
    /** The modules of one folder and the imports among them. @param {string} folder @param {any[]} mods */
    const moduleGraph = (folder, mods) =>
      mods.length > 1
        ? graphSvg({
            id: `${folderId(folder)}-graph`,
            title: `The modules of ${folderName(folder)} and the imports among them${folders.size > 1 ? "; imports from other folders are on each module's page" : ""}`,
            boxes: mods.map((m) => ({ id: m.path, label: baseName(m.path), href: modulePath(s.id, m.path), lines: boxLines(map, [m]), cycle: !!m.cycle })),
            wires: mods.flatMap((m) => m.imports.map((/** @type {string} */ to) => ({ from: m.path, to }))),
          })
        : "";
    return `<section aria-labelledby="${id("title")}">
<h2 id="${id("title")}">${escapeHtml(map.repo)}</h2>
<p>Measured on ${escapeHtml(map.date)} at commit <a href="${repoUrl(map.repo)}/tree/${escapeHtml(map.sha)}"><code>${escapeHtml(map.sha.slice(0, 7))}</code></a>: ${map.modules.length} modules, ${fns.length} functions. ${
      map.tools.coverage ? `By CRAP, ${counts.crit} critical, ${counts.warn} to watch and ${counts.ok} ok.` : "No coverage report, so no CRAP scores."
    } ${map.tools.mutation ? "" : "Mutation testing has not run on it yet."}</p>
<h3 id="${id("cycles")}">Import cycles</h3>
${map.cycles.length ? `<ul>${map.cycles.map((/** @type {string[]} */ c) => `<li>${c.map((p) => `<a href="${modulePath(s.id, p)}">${escapeHtml(p)}</a>`).join(" imports ")}, and back</li>`).join("")}</ul>` : "<p>None: no module imports itself, however indirectly.</p>"}
${folderGraph}
${[...folders].map(([folder, mods]) => `<div class="code-folder" id="${folderId(folder)}">${moduleGraph(folder, mods)}${scroller(`${folderId(folder)}-table`, `<table class="cap-table code-table"><caption>${escapeHtml(folderName(folder))}</caption>
<thead><tr><th scope="col">Module</th><th scope="col">Lines</th><th scope="col">Functions</th><th scope="col">Worst function</th><th scope="col">Mutation</th></tr></thead>
<tbody>${mods.map((/** @type {any} */ m) => `<tr${m.cycle ? ' data-cycle=""' : ""}><th scope="row"><a href="${modulePath(s.id, m.path)}">${escapeHtml(baseName(m.path))}</a>${m.cycle ? ' <span class="cap-pill" data-variant="outline">cycle</span>' : ""}</th><td>${m.loc}</td><td>${m.functions.length}</td><td>${m.functions.length ? crapStatus(worstCrap(m), r.fnCrap) : '<span class="code-none">No functions</span>'}</td><td>${scoreStatus(moduleScore(m), r.score)}</td></tr>`).join("")}</tbody></table>`, `${folder}, ${map.repo}`)}</div>`).join("\n")}
</section>`;
  });
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Capsid explorer</a> / <a href="${systemPath(s.id)}">${escapeHtml(s.name)}</a> / <span aria-current="page">Code</span></nav>
<h1>The code of ${escapeHtml(s.name)}</h1>
<p class="lead">Each module by folder, with its riskiest function by CRAP (complexity weighed against how much of it the tests run: over ${CRAP_CRIT} is critical, over ${CRAP_WATCH} worth watching) and its mutation score (the share of deliberate bugs its tests catch: under ${SCORE_WATCH}% is critical, under ${SCORE_OK}% worth watching). Choose a module for its functions and source.</p>
${sections.join("\n")}`;
  return layout({ title: `The code of ${s.name}, in the Capsid explorer`, description: `${s.name}'s modules, import cycles and riskiest functions.`, path: codePath(s.id), body, asOf });
}

/**
 * One module: its functions, what it imports and what imports it, and its numbered source, each
 * function linked to its lines.
 * @param {any} s the system @param {any} map @param {any} m the module @param {string | undefined} source @param {string} asOf
 */
export function modulePage(s, map, m, source, asOf) {
  const r = reasons(map);
  const importers = map.modules.filter((/** @type {any} */ x) => x.imports.includes(m.path));
  const lines = source === undefined ? [] : source.replace(/\n$/, "").split("\n");
  const link = (/** @type {string} */ p) => `<a href="${modulePath(s.id, p)}">${escapeHtml(p)}</a>`;
  const fnRows = m.functions
    .map(
      (/** @type {any} */ f) =>
        `<tr><th scope="row"><a href="#L${f.line}">${escapeHtml(f.name)}</a></th><td>${f.line} to ${f.end}</td><td>${f.cc}</td><td>${f.coverage === null ? status("nodata", "", r.fnCrap) : `${Math.round(f.coverage * 100)}%`}</td><td>${crapStatus(f.crap, r.fnCrap)}</td><td>${scoreStatus(f.mutants ? f.score : null, r.score)}</td></tr>`
    )
    .join("");
  const code = lines.length
    ? `<pre class="code" tabindex="0" aria-label="${escapeHtml(m.path)}, ${lines.length} lines"><code>${lines.map((l, i) => `<span class="code-line" id="L${i + 1}"><span class="code-ln" aria-hidden="true">${i + 1}</span>${escapeHtml(l)}\n</span>`).join("")}</code></pre>`
    : `<p>The source was not read for this build. <a href="${blobUrl(map, m.path)}">Read it on GitHub</a>.</p>`;
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Capsid explorer</a> / <a href="${systemPath(s.id)}">${escapeHtml(s.name)}</a> / <a href="${codePath(s.id)}">Code</a> / <span aria-current="page">${escapeHtml(m.path)}</span></nav>
<h1><code>${escapeHtml(m.path)}</code></h1>
<p class="lead">${m.loc} lines and ${m.functions.length} functions in ${escapeHtml(map.repo)}, at commit <code>${escapeHtml(map.sha.slice(0, 7))}</code> on <span class="nowrap">${escapeHtml(map.date)}</span>.${m.cycle ? " It is in an import cycle." : ""} <a href="${blobUrl(map, m.path)}">This file on GitHub</a>.</p>
<section aria-labelledby="fns-title"><h2 id="fns-title">Functions</h2>
${m.functions.length ? scroller("fns", `<table class="cap-table code-table"><caption>The functions of ${escapeHtml(baseName(m.path))}</caption>
<thead><tr><th scope="col">Function</th><th scope="col">Lines</th><th scope="col">Complexity</th><th scope="col">Covered</th><th scope="col">CRAP</th><th scope="col">Mutation</th></tr></thead>
<tbody>${fnRows}</tbody></table>`, `The functions of ${m.path}`) : "<p>None: it only declares types or values.</p>"}
</section>
<section aria-labelledby="imports-title"><h2 id="imports-title">Imports</h2>
<p>${m.imports.length ? `It imports ${m.imports.map(link).join(", ")}.` : "It imports no other module of this repo."} ${importers.length ? `Imported by ${importers.map((/** @type {any} */ x) => link(x.path)).join(", ")}.` : "No module of this repo imports it."}</p>
</section>
<section aria-labelledby="source-title"><h2 id="source-title">Source</h2>${code}</section>`;
  return layout({ title: `${m.path}, ${s.name}, in the Capsid explorer`, description: `${m.path} in ${map.repo}: ${m.functions.length} functions.`, path: modulePath(s.id, m.path), body, asOf });
}

/**
 * Every code page: one per public system with a map, and one per module in it.
 * @param {any} model @param {Map<string, any[]>} bySystem @param {(repo: string, path: string) => string | undefined} sourceOf @param {string} asOf
 * @returns {Array<[string, string]>}
 */
export function codePages(model, bySystem, sourceOf, asOf) {
  /** @type {Array<[string, string]>} */
  const pages = [];
  for (const [id, maps] of bySystem) {
    const s = model.systems.find((/** @type {any} */ x) => x.id === id);
    pages.push([codePath(id), codePage(s, maps, asOf)]);
    for (const map of maps) for (const m of map.modules) pages.push([modulePath(id, m.path), modulePage(s, map, m, sourceOf(map.repo, m.path), asOf)]);
  }
  return pages;
}
