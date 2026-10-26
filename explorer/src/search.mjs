// Search over everything the explorer publishes: systems, parts, flows and their steps, tools,
// their actions, and each measured repo's code page. The index is one JSON
// file the search page's script reads from the explorer itself, so no request leaves the site.
// Each entry is [kind, name, detail, address]. Pure.
import { codePath } from "./code.mjs";
import { flowPath, layout, pageHead, partPath, stepPath, systemPath } from "./pages.mjs";
import { toolPath } from "./tools.mjs";

/**
 * @param {any} model @param {Map<string, any[]>} bySystem @param {any[]} flows resolved (pages.mjs, flowsOf) @param {any[]} tools
 * @returns {{ entries: Array<[string, string, string, string]> }}
 */
export function searchIndex(model, bySystem, flows, tools) {
  /** @type {Array<[string, string, string, string]>} */
  const entries = [];
  const names = new Map(model.systems.map((/** @type {any} */ s) => [s.id, s.name]));
  for (const s of model.systems) entries.push(["System", s.name, [s.description, s.domain].filter(Boolean).join(" · "), systemPath(s.id)]);
  for (const c of model.containers) entries.push(["Part", c.name, `${names.get(c.system) ?? c.system} · ${c.technology}${c.description ? ` · ${c.description}` : ""}`, partPath(c)]);
  for (const f of flows) {
    entries.push(["Flow", f.name, f.description ?? `${f.steps.length} steps`, flowPath(f.id)]);
    for (const st of f.steps) entries.push(["Step", `${f.name}, step ${st.n}`, st.text, stepPath(f.id, st.n)]);
  }
  for (const t of tools) {
    entries.push(["Tool", t.name, `${t.title} · ${t.server}`, toolPath(t.name)]);
    for (const a of t.actions) entries.push(["Action", `${t.name} ${a.name}`, a.summary, `${toolPath(t.name)}#action-${a.name}`]);
  }
  const seen = new Set();
  for (const [id, maps] of bySystem) {
    for (const map of maps) {
      if (seen.has(map.repo)) continue;
      seen.add(map.repo);
      entries.push(["Code", map.repo.split("/")[1], `${map.modules.length} modules, measured ${map.date}`, codePath(id)]);
    }
  }
  return { entries };
}

/** @param {string} asOf */
export function searchPage(asOf) {
  const body = `${pageHead([["/", "Overview"]], "Search", "Search", "Find any system, part, step, tool or repo on this site. Press / on any page to jump here.")}
<form class="search-form" action="/search/" method="get" role="search">
<label class="cap-sr-only" for="q">Search the explorer</label>
<input class="cap-input search-input" id="q" name="q" type="search" placeholder="Try “backup”, “merge” or “session”" autocomplete="off" data-search>
</form>
<p class="hint" role="status" data-search-count>Search needs JavaScript. Without it, browse <a href="/systems/">the systems</a>, <a href="/tools/">the tools</a> or <a href="/code/">the code</a>.</p>
<ol class="search-results" data-search-results></ol>`;
  return layout({ title: "Search, Capsid", description: "Search every system, part, step, tool and repo in the Capsid explorer.", path: "/search/", body, asOf });
}

