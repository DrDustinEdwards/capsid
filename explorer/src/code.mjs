// The code level (capsid/research/design-system-explorer.md, section 5; slice 9 of its build
// order): a public system's modules by folder, each with its worst CRAP and its mutation score,
// its import cycles as text, and each module's functions over its numbered source at the commit
// the map measured. Pure, as pages.mjs is: build.mjs reads the code document and the source and
// passes them in.
//
// Every status is Capsomer's: a glyph whose shape carries it, a word, and the tone's colour
// (components/status). A number nobody measured is "No data" with its reason, never a zero.
import { graphSvg } from "./graph.mjs";
import { escapeHtml, layout, pageHead, reading, scroller, systemPath } from "./pages.mjs";

/** The most modules a folder's drawing shows. */
const MAX_DRAWN = 40;

/** @param {string} id */
export const codePath = (id) => `/s/${id}/code/`;
/** A repo path as GitHub's URLs take it, each segment escaped. */
export const escapePath = (/** @type {string} */ path) => path.split("/").map(encodeURIComponent).join("/");

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
    lines.push({ tone: scoreTone(score), text: score !== null ? `mutation ${score}%` : fns.some((f) => f.stale) ? "mutation stale" : "no mutants" });
  }
  return lines;
}

/** Why a number is missing, from what the map says ran. @param {any} map */
const reasons = (map) => ({
  fnCrap: "no coverage report in this map",
  score: map.tools.mutation ? "no mutants in this code" : "mutation testing has not run on this repo yet",
  stale: "changed since the last mutation run",
});

/** Why a module or function has no mutation score: stale beats no mutants. @param {any} r @param {any[]} fns */
const scoreReason = (r, fns) => (fns.some((f) => f.stale) ? r.stale : r.score);

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

/**
 * When the mutation scores are from an older commit than the map, say so, and how many
 * functions changed since and so show none. @param {any} map @param {any[]} fns
 */
function mutationNote(map, fns) {
  if (!map.mutated) return "";
  const stale = fns.filter((f) => f.stale).length;
  return `Mutation scores are from the run on <span class="nowrap">${escapeHtml(map.mutated.date)}</span> at commit <code>${escapeHtml(map.mutated.sha.slice(0, 7))}</code>${
    stale ? `; ${stale === 1 ? "1 function has" : `${stale} functions have`} changed since and show${stale === 1 ? "s" : ""} none until the next run.` : "."
  }`;
}

/** @param {string} path */
const folderOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
/** @param {string} path */
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

/** A repo's GitHub address from its "owner/name". @param {string} repo */
const repoUrl = (repo) => `https://github.com/${repo}`;
/** @param {any} map @param {string} path @param {number} [line] @param {number} [end] */
const blobUrl = (map, path, line, end) => `${repoUrl(map.repo)}/blob/${map.sha}/${escapePath(path)}${line ? `#L${line}${end && end !== line ? `-L${end}` : ""}` : ""}`;


/**
 * The code maps of public systems, checked against the model: a map for a system the model does
 * not have as public stops the build, as a flow touching a private part does (design section 2,
 * rule 2), so the explorer can never draw a private system's code. Two systems that share a repo
 * (a site and its admin connector) get its pages once, under the system named after the repo, or
 * else the first to list it, so no page is served twice under two addresses.
 * @param {any} model @param {any} code
 * @returns {Map<string, any[]>} system id to its maps
 */
export function codeBySystem(model, code) {
  const systems = new Map(model.systems.map((/** @type {any} */ s) => [s.id, s]));
  const maps = code?.maps ?? [];
  /** @type {Map<string, any[]>} */
  const out = new Map();
  for (const map of maps) {
    const s = systems.get(map.system);
    if (!s || s.private !== false) throw new Error(`the code map of ${map.repo} belongs to ${map.system}, which is not a public system in the model`);
    const name = map.repo.split("/")[1];
    const owner = maps.find((/** @type {any} */ x) => x.repo === map.repo && x.system === name) ?? maps.find((/** @type {any} */ x) => x.repo === map.repo);
    if (owner !== map) continue;
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
    // The modules of one folder and the imports among them. Past MAX_DRAWN boxes a drawing is
    // a smear no one can read, so a folder that large has its table alone.
    /** @param {string} folder @param {any[]} mods */
    const moduleGraph = (folder, mods) =>
      mods.length > 1 && mods.length <= MAX_DRAWN
        ? graphSvg({
            id: `${folderId(folder)}-graph`,
            title: `The modules of ${folderName(folder)} and the imports among them`,
            boxes: mods.map((m) => ({ id: m.path, label: baseName(m.path), href: blobUrl(map, m.path), lines: boxLines(map, [m]), cycle: !!m.cycle })),
            wires: mods.flatMap((m) => m.imports.map((/** @type {string} */ to) => ({ from: m.path, to }))),
          })
        : "";
    return `<section aria-labelledby="${id("title")}">
<h2 id="${id("title")}">${escapeHtml(map.repo)}</h2>
<p>Measured on ${escapeHtml(map.date)} at commit <a href="${repoUrl(map.repo)}/tree/${escapeHtml(map.sha)}"><code>${escapeHtml(map.sha.slice(0, 7))}</code></a>: ${map.modules.length} modules, ${fns.length} functions. ${
      map.tools.coverage ? `By CRAP, ${counts.crit} critical, ${counts.warn} to watch and ${counts.ok} ok.` : "No coverage report, so no CRAP scores."
    } ${map.tools.mutation ? mutationNote(map, fns) : "Mutation testing has not run on it yet."}</p>
<h3 id="${id("cycles")}">Import cycles</h3>
${map.cycles.length ? `<ul>${map.cycles.map((/** @type {string[]} */ c) => `<li>${c.map((p) => `<a href="${blobUrl(map, p)}">${escapeHtml(p)}</a>`).join(" imports ")}, and back</li>`).join("")}</ul>` : "<p>None: no module imports itself, however indirectly.</p>"}
${folderGraph}
${[...folders].map(([folder, mods]) => `<div class="code-folder" id="${folderId(folder)}">${moduleGraph(folder, mods)}${scroller(`${folderId(folder)}-table`, `<table class="cap-table code-table"><caption>${escapeHtml(folderName(folder))}</caption>
<thead><tr><th scope="col">Module</th><th scope="col">Lines</th><th scope="col">Functions</th><th scope="col">Worst function</th><th scope="col">Mutation</th></tr></thead>
<tbody>${mods.map((/** @type {any} */ m) => `<tr${m.cycle ? ' data-cycle=""' : ""}><th scope="row"><a href="${blobUrl(map, m.path)}">${escapeHtml(baseName(m.path))}</a>${m.cycle ? ' <span class="cap-pill" data-variant="outline">cycle</span>' : ""}</th><td>${m.loc}</td><td>${m.functions.length}</td><td>${m.functions.length ? crapStatus(worstCrap(m), r.fnCrap) : '<span class="code-none">No functions</span>'}</td><td>${scoreStatus(moduleScore(m), scoreReason(r, m.functions))}</td></tr>`).join("")}</tbody></table>`, `${folder}, ${map.repo}`)}</div>`).join("\n")}
</section>`;
  });
  const body = `${pageHead([["/", "Overview"], ["/code/", "Code"], [systemPath(s.id), s.name]], "Code", `The code of ${escapeHtml(s.name)}`)}
<p class="lead">Each module by folder, with two scores. CRAP shows its riskiest function: it rises when code is complex and its tests cover little of it. Over ${CRAP_CRIT} is critical, and over ${CRAP_WATCH} is worth a look. The mutation score is the share of planted bugs its tests catch. Under ${SCORE_WATCH}% is critical, and under ${SCORE_OK}% is worth a look. Each module links to its source on GitHub.</p>
${sections.join("\n")}`;
  return layout({ title: `The code of ${s.name}, Capsid`, description: `${s.name}'s modules, import cycles and riskiest functions.`, path: codePath(s.id), body, asOf });
}

/**
 * Every code page: one per public system with a map.
 * @param {any} model @param {Map<string, any[]>} bySystem @param {string} asOf
 * @returns {Array<[string, string]>}
 */
export function codePages(model, bySystem, asOf) {
  return [...bySystem].map(([id, maps]) => [codePath(id), codePage(model.systems.find((/** @type {any} */ x) => x.id === id), maps, asOf)]);
}

/** Every public repo's map with the system its pages sit under. @param {any} model @param {Map<string, any[]>} bySystem */
function reposOf(model, bySystem) {
  return [...bySystem].flatMap(([id, maps]) => maps.map((map) => ({ repo: map.repo, system: model.systems.find((/** @type {any} */ s) => s.id === id), map })));
}

/**
 * The system whose code pages hold another system's repo, when the two share it, or undefined.
 * @param {any} model @param {Map<string, any[]>} bySystem @param {string} id
 */
export function codeHome(model, bySystem, id) {
  const repos = (model.systems.find((/** @type {any} */ s) => s.id === id)?.repos ?? []).map((/** @type {string} */ r) => r.replace(/^https:\/\/github\.com\//, ""));
  for (const [home, maps] of bySystem) if (home !== id && maps.some((map) => repos.includes(map.repo))) return model.systems.find((/** @type {any} */ s) => s.id === home);
  return undefined;
}

/** @param {any} map */
const functionsOf = (map) => map.modules.flatMap((/** @type {any} */ m) => m.functions.map((/** @type {any} */ f) => ({ ...f, path: m.path, href: blobUrl(map, m.path, f.line, f.end) })));

/**
 * Totals over every public repo's code map, for the front page and the code overview, or null
 * when there are no maps.
 * @param {any} model @param {Map<string, any[]>} bySystem
 */
export function codeTotals(model, bySystem) {
  const repos = reposOf(model, bySystem);
  if (!repos.length) return null;
  const fns = repos.flatMap((r) => functionsOf(r.map).map((/** @type {any} */ f) => ({ ...f, repo: r.repo, system: r.system.id })));
  const worst = fns.filter((f) => f.crap !== null).sort((a, b) => b.crap - a.crap)[0] ?? null;
  return {
    repos: repos.length,
    modules: repos.reduce((n, r) => n + r.map.modules.length, 0),
    functions: fns.length,
    lines: repos.reduce((n, r) => n + r.map.modules.reduce((/** @type {number} */ k, /** @type {any} */ m) => k + m.loc, 0), 0),
    worst: worst && { name: worst.name, path: `${worst.repo.split("/")[1]}/${worst.path}`, crap: worst.crap, cc: worst.cc, href: worst.href },
  };
}

/** A function's row in a table of the riskiest, linked to its lines on GitHub. @param {any} f @param {boolean} [repo] */
const riskRow = (f, repo = false) =>
  `<tr><th scope="row"><a href="${f.href}"><code>${escapeHtml(f.name)}</code></a></th>${repo ? `<td>${escapeHtml(f.repo.split("/")[1])}</td>` : ""}<td>${escapeHtml(f.path)}</td><td data-sort="${f.cc}">${f.cc}</td><td data-sort="${f.coverage ?? -1}">${f.coverage === null ? "" : `${Math.round(f.coverage * 100)}%`}</td><td data-sort="${f.crap ?? -1}">${crapStatus(f.crap, "no coverage report in this map")}</td></tr>`;

/** A system page's five riskiest functions, by CRAP. @param {string} id @param {any[]} maps */
export function riskiest(id, maps) {
  const fns = maps.flatMap(functionsOf).filter((/** @type {any} */ f) => f.crap !== null).sort((/** @type {any} */ a, /** @type {any} */ b) => b.crap - a.crap).slice(0, 5);
  if (!fns.length) return "";
  return `<section aria-labelledby="risk-title"><h2 id="risk-title">Its riskiest functions</h2>
<p class="section-sub">CRAP is a risk score: a function's complexity weighed against how much of it the tests run. Over ${CRAP_CRIT} is critical, and a complex function no test runs scores highest.</p>
${scroller("risk", `<table class="cap-table code-table"><caption>The five functions with the highest CRAP</caption><thead><tr><th scope="col">Function</th><th scope="col">Module</th><th scope="col">Complexity</th><th scope="col">Covered</th><th scope="col">CRAP</th></tr></thead><tbody>${fns.map((/** @type {any} */ f) => riskRow(f)).join("")}</tbody></table>`, "Its riskiest functions")}
<p><a class="arrow" href="${codePath(id)}">Every module</a></p></section>`;
}

/**
 * The code overview: every public repo with its size and health, then the riskiest functions
 * and the weakest-tested modules across all of them, each table sortable.
 * @param {any} model @param {Map<string, any[]>} bySystem @param {any} totals @param {string} asOf
 */
export function codeIndexPage(model, bySystem, totals, asOf) {
  const repos = reposOf(model, bySystem);
  const head = pageHead([["/", "Overview"]], "Code", "The code, measured", totals
    ? `${totals.lines.toLocaleString("en-US")} lines in ${totals.modules.toLocaleString("en-US")} modules and ${totals.functions.toLocaleString("en-US")} functions across ${totals.repos} public repos, measured after each push. Two scores flag risky code. CRAP rises when a function is complex and its tests cover little of it; over ${CRAP_CRIT} is critical. The mutation score is the share of planted bugs the tests catch; under ${SCORE_WATCH}% is critical.`
    : "No code maps have been published yet.");
  if (!totals) return layout({ title: "Code, Capsid", description: "The public repos' code, measured.", path: "/code/", body: head, asOf });
  const repoRows = repos
    .map((r) => {
      const fns = functionsOf(r.map);
      const crit = fns.filter((/** @type {any} */ f) => f.crap !== null && f.crap > CRAP_CRIT).length;
      const covered = fns.filter((/** @type {any} */ f) => f.coverage !== null);
      const coverage = covered.length ? covered.reduce((/** @type {number} */ n, /** @type {any} */ f) => n + f.coverage, 0) / covered.length : null;
      const score = moduleScore({ functions: fns });
      const loc = r.map.modules.reduce((/** @type {number} */ n, /** @type {any} */ m) => n + m.loc, 0);
      return `<tr><th scope="row"><a href="${codePath(r.system.id)}">${escapeHtml(r.repo.split("/")[1])}</a></th><td data-sort="${loc}">${loc.toLocaleString("en-US")}</td><td data-sort="${r.map.modules.length}">${r.map.modules.length}</td><td data-sort="${fns.length}">${fns.length}</td><td data-sort="${coverage ?? -1}">${coverage === null ? "" : `${Math.round(coverage * 100)}%`}</td><td data-sort="${crit}">${crit}</td><td data-sort="${r.map.cycles.length}">${r.map.cycles.length}</td><td data-sort="${score ?? -1}">${scoreStatus(score, r.map.tools.mutation ? "no mutants in this code" : "mutation testing has not run on this repo yet")}</td></tr>`;
    })
    .join("");
  const all = repos.flatMap((r) => functionsOf(r.map).map((/** @type {any} */ f) => ({ ...f, repo: r.repo, system: r.system.id })));
  const worst = all.filter((f) => f.crap !== null).sort((a, b) => b.crap - a.crap).slice(0, 25);
  const weak = repos
    .filter((r) => r.map.tools.mutation)
    .flatMap((r) => r.map.modules.map((/** @type {any} */ m) => ({ m, r, score: moduleScore(m) })))
    .filter((x) => x.score !== null)
    .sort((a, b) => /** @type {number} */ (a.score) - /** @type {number} */ (b.score))
    .slice(0, 15);
  const body = `${head}
<dl class="readings readings-row">${[
    [totals.repos, "public repos"],
    [totals.modules.toLocaleString("en-US"), "modules"],
    [totals.functions.toLocaleString("en-US"), "functions"],
    [totals.lines.toLocaleString("en-US"), "lines"],
  ]
    .map(([v, l]) => reading(String(v), String(l)))
    .join("")}</dl>
<section aria-labelledby="repos-title"><h2 id="repos-title">Every repo</h2>
${scroller("repos", `<table class="cap-table code-table" data-sortable><caption>Each public repo's size and health; choose a heading to sort</caption><thead><tr><th scope="col">Repo</th><th scope="col">Lines</th><th scope="col">Modules</th><th scope="col">Functions</th><th scope="col">Covered</th><th scope="col">Critical</th><th scope="col">Cycles</th><th scope="col">Mutation</th></tr></thead><tbody>${repoRows}</tbody></table>`, "Every repo")}
</section>
<section aria-labelledby="worst-title"><h2 id="worst-title">The 25 riskiest functions</h2>
${scroller("worst", `<table class="cap-table code-table" data-sortable><caption>By CRAP, highest first, across every public repo</caption><thead><tr><th scope="col">Function</th><th scope="col">Repo</th><th scope="col">Module</th><th scope="col">Complexity</th><th scope="col">Covered</th><th scope="col">CRAP</th></tr></thead><tbody>${worst.map((f) => riskRow(f, true)).join("")}</tbody></table>`, "The riskiest functions")}
</section>
${weak.length ? `<section aria-labelledby="weak-title"><h2 id="weak-title">The weakest-tested modules</h2>
<p class="section-sub">Mutation runs weekly on the repos that have it; these modules' tests caught the smallest share of deliberate bugs.</p>
${scroller("weak", `<table class="cap-table code-table" data-sortable><caption>By mutation score, lowest first</caption><thead><tr><th scope="col">Module</th><th scope="col">Repo</th><th scope="col">Functions</th><th scope="col">Mutation</th></tr></thead><tbody>${weak
    .map((x) => `<tr><th scope="row"><a href="${blobUrl(x.r.map, x.m.path)}">${escapeHtml(x.m.path)}</a></th><td>${escapeHtml(x.r.repo.split("/")[1])}</td><td>${x.m.functions.length}</td><td data-sort="${x.score}">${scoreStatus(x.score, "")}</td></tr>`)
    .join("")}</tbody></table>`, "The weakest-tested modules")}</section>` : ""}`;
  return layout({ title: "Code, Capsid", description: `${totals.modules} modules across ${totals.repos} public repos, scored for risk and for how well their tests catch bugs.`, path: "/code/", body, asOf });
}
