// The tools Capsid serves over MCP: one page listing them all, filterable by what each may do,
// and one page per tool with its actions and every argument. Built from the Worker's own
// registrations (src/surface.mjs), so the catalog cannot drift from what is served. Pure.
import { escapeHtml, layout, pageHead, scroller } from "./pages.mjs";

/** @param {string} name */
export const toolPath = (name) => `/tools/${name}/`;

const GRANT = {
  read: "read access",
  write: "write access",
  action: "read or write access, by action",
  admin: "admin and write access",
  admin_read: "admin and read access",
};

/** Text from a tool's description, its `code` spans kept as code. @param {string} text */
const prose = (text) => escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");

/** A description's first sentence, for a card. @param {string} text */
const sentence = (text) => text.split("\n\n")[0].match(/^[\s\S]*?[.:](?=\s|$)/)?.[0].replace(/:$/, ".") ?? text.split("\n\n")[0];

/** What a tool may do, in words a reader can filter by. @param {any} t */
export function kindsOf(t) {
  const kinds = [t.hints.readOnlyHint ? "reads" : t.hints.destructiveHint ? "changes" : "adds"];
  if (t.server === "Capsid Admin") kinds.push("admin");
  if (t.hints.openWorldHint) kinds.push("outside");
  return kinds;
}

const KIND_WORD = { reads: "Reads only", changes: "Can change or remove", adds: "Adds, never removes", admin: "Admin only", outside: "Reaches GitHub or Cloudflare" };

/** @param {any} t */
const pills = (t) => kindsOf(t).map((k) => `<span class="cap-pill" data-kind="${k}">${KIND_WORD[/** @type {keyof typeof KIND_WORD} */ (k)]}</span>`).join("");

/**
 * One paragraph of a description, laid out as it is meant to be read. A run of lines each opened
 * by an action's name ("post: queue a job") is a list, each line beside its name; a long
 * paragraph breaks where a sentence turns to the next action or mode.
 * @param {string} para
 */
function said(para) {
  let out = "";
  let list = "";
  for (const line of para.split("\n")) {
    const m = line.match(/^([a-z_]+(?:(?: \/ |, )[a-z_]+)*): ([\s\S]+)$/);
    if (m) list += `<li><code>${escapeHtml(m[1])}</code><span>${prose(m[2])}</span></li>`;
    else if (list) list += `<li class="said-note"><span>${prose(line)}</span></li>`;
    else out += line.split(/(?<=\. )(?=(?:action|mode) ["'][a-z_]+["'])/).map((x) => `<p class="measure">${prose(x)}</p>`).join("");
  }
  return out + (list ? `<ul class="said">${list}</ul>` : "");
}

/** @param {any[]} tools @param {string} asOf */
export function toolsPage(tools, asOf) {
  const servers = ["Capsid", "Capsid Admin"];
  const chips = [["all", "All"], ["reads", "Reads only"], ["changes", "Can change"], ["admin", "Admin only"], ["outside", "Reaches outside"]];
  const body = `${pageHead([["/", "Overview"]], "Tools", "Every tool Capsid serves", `${tools.length} tools over MCP, ${tools.filter((t) => t.server === "Capsid").length} on Capsid for project work and ${tools.filter((t) => t.server === "Capsid Admin").length} on Capsid Admin for the admin only. Each entry comes straight from the server's code: the access it needs, what it can change, its actions and its arguments.`)}
<div class="filter-bar" data-filter="tools" hidden>
<label class="cap-sr-only" for="tool-q">Filter the tools</label>
<input class="cap-input" id="tool-q" type="search" placeholder="Filter by name, action or argument" autocomplete="off" data-filter-q>
<div class="chips" role="group" aria-label="Show">${chips.map(([k, label], i) => `<button type="button" class="cap-btn" data-size="sm" data-chip="${k}" aria-pressed="${i ? "false" : "true"}">${label}</button>`).join("")}</div>
<p class="hint" role="status" data-filter-count></p>
</div>
${servers
  .map(
    (server) => `<section aria-labelledby="srv-${server === "Capsid" ? "capsid" : "admin"}">
<h2 id="srv-${server === "Capsid" ? "capsid" : "admin"}">${server}</h2>
<p class="section-sub">${server === "Capsid" ? "On <code>/mcp</code> for the owners and <code>/ops/mcp</code> for agents with a key." : "On <code>/mcp/admin</code> and <code>/ops/mcp/admin</code>, for the administrator identity only."}</p>
<ul class="tool-cards">${tools
      .filter((t) => t.server === server)
      .map(
        (t) => `<li class="tool-card" data-item data-kinds="${kindsOf(t).join(" ")}" data-text="${escapeHtml([t.name, t.title, ...t.actions.map((/** @type {any} */ a) => a.name), ...t.params.map((/** @type {any} */ p) => p.name)].join(" ").toLowerCase())}">
<a href="${toolPath(t.name)}"><code>${escapeHtml(t.name)}</code><span class="tool-card-title">${escapeHtml(t.title)}</span></a>
<p>${prose(sentence(t.description))}</p>
<p class="tool-tags">${pills(t)}</p>
<p class="hint">${t.actions.length ? `${t.actions.length === 1 ? "One action" : `${t.actions.length} actions`}: ${t.actions.map((/** @type {any} */ a) => escapeHtml(a.name)).join(", ")}` : "One action"}; ${t.params.length} argument${t.params.length === 1 ? "" : "s"}.</p>
</li>`
      )
      .join("")}</ul>
</section>`
  )
  .join("\n")}
<p class="hint" data-filter-empty hidden>No tool matches that.</p>`;
  return layout({ title: "Tools, Capsid", description: `The ${tools.length} MCP tools Capsid serves, with their actions and arguments.`, path: "/tools/", body, asOf });
}

/**
 * The paragraphs of a tool's description. A composite tool's description holds one paragraph per
 * action, opened by its name in quotes; those go with their action, the rest stay in order.
 * @param {any} t
 */
function split(t) {
  const names = new Set(t.actions.map((/** @type {any} */ a) => a.name));
  /** @type {Map<string, string>} */
  const byAction = new Map();
  const rest = [];
  for (const para of t.description.split("\n\n")) {
    // A paragraph may open with several actions' names: '"merge", "close": ...'.
    const m = para.match(/^((?:"[a-z_]+"(?:, )?)+): ([\s\S]*)$/);
    const named = m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
    if (m && named.length && named.every((n) => names.has(n))) for (const n of named) byAction.set(n, m[2]);
    else if (!/^Actions: /.test(para)) rest.push(para);
  }
  return { byAction, rest };
}

/** @param {any} t @param {any[]} tools @param {string} asOf */
export function toolPage(t, tools, asOf) {
  const { byAction, rest } = split(t);
  const i = tools.indexOf(t);
  const near = [tools[i - 1], tools[i + 1]].filter(Boolean);
  const hint = (/** @type {boolean} */ on, /** @type {string} */ yes, /** @type {string} */ no) => `<li data-on="${on}">${on ? yes : no}</li>`;
  const params = t.params.length
    ? scroller(
        "params",
        `<table class="cap-table"><caption>The arguments of ${escapeHtml(t.name)}</caption>
<thead><tr><th scope="col">Argument</th><th scope="col">Type</th><th scope="col">Needed</th><th scope="col">What it is</th></tr></thead>
<tbody>${t.params
          .map(
            (/** @type {any} */ p) =>
              `<tr id="arg-${escapeHtml(p.name)}"><th scope="row"><code>${escapeHtml(p.name)}</code></th><td>${escapeHtml(p.type)}${p.values.length ? `: ${p.values.map((/** @type {string} */ v) => `<code>${escapeHtml(v)}</code>`).join(", ")}` : ""}</td><td>${p.required ? "always" : "no"}</td><td data-wrap>${prose(p.description)}</td></tr>`
          )
          .join("")}</tbody></table>`,
        `The arguments of ${t.name}`
      )
    : "<p>None.</p>";
  const actions = t.actions.length
    ? `<section aria-labelledby="actions-title"><h2 id="actions-title">Its ${t.actions.length} actions</h2>
<p class="section-sub">Chosen by the <code>action</code> argument${t.params.some((/** @type {any} */ p) => p.name === "action" && !p.required) ? ", with a default when it is left out" : ""}.</p>
<dl class="actions">${t.actions
        .map(
          (/** @type {any} */ a) => `<div class="action" id="action-${escapeHtml(a.name)}"><dt><code>${escapeHtml(a.name)}</code> ${escapeHtml(a.summary)}</dt><dd>${byAction.has(a.name) ? `<p>${prose(byAction.get(a.name) ?? "")}</p>` : ""}<p class="hint">${
            a.params.length ? `Takes ${a.params.map((/** @type {string} */ p) => `<a href="#arg-${escapeHtml(p)}"><code>${escapeHtml(p)}</code></a>`).join(", ")}.` : "Takes nothing else."
          }</p></dd></div>`
        )
        .join("")}</dl></section>`
    : "";
  const body = `${pageHead([["/", "Overview"], ["/tools/", "Tools"]], t.name, escapeHtml(t.title), `<code>${escapeHtml(t.name)}</code>, on ${escapeHtml(t.server)}. Needs ${GRANT[/** @type {keyof typeof GRANT} */ (t.grant)] ?? escapeHtml(t.grant)}.`)}
<p class="tool-tags">${pills(t)}</p>
<section aria-labelledby="does-title"><h2 id="does-title">What it does</h2>${rest.map(said).join("")}</section>
<section aria-labelledby="hints-title"><h2 id="hints-title">What a client is told</h2>
<p class="section-sub">The MCP hints it carries, so a client can ask before it acts (src/tool-annotations.ts).</p>
<ul class="hints">${hint(t.hints.readOnlyHint, "Reads only: no action changes anything.", "Writes: some action changes state.")}${hint(t.hints.destructiveHint, "Can overwrite or remove what exists.", "Never overwrites or removes.")}${hint(t.hints.idempotentHint, "Repeating a call changes nothing further.", "A repeat can change things again.")}${hint(t.hints.openWorldHint, "Reaches GitHub, Cloudflare or a live site.", "Stays inside Capsid.")}</ul>
</section>
${actions}
<section aria-labelledby="args-title"><h2 id="args-title">Arguments</h2>${params}</section>
<nav class="pager" aria-label="Other tools">${near.map((n) => `<a href="${toolPath(n.name)}" rel="${tools.indexOf(n) < i ? "prev" : "next"}">${tools.indexOf(n) < i ? "Previous" : "Next"}: <code>${escapeHtml(n.name).replaceAll("_", "_<wbr>")}</code></a>`).join("")}</nav>`;
  return layout({ title: `${t.name}, Capsid tools`, description: `${t.title}: ${t.description.split("\n\n")[0]}`, path: toolPath(t.name), body, asOf });
}

/** Every tools page. @param {any[]} tools @param {string} asOf @returns {Array<[string, string]>} */
export function toolPages(tools, asOf) {
  if (!tools.length) return [];
  return [["/tools/", toolsPage(tools, asOf)], ...tools.map((t) => /** @type {[string, string]} */ ([toolPath(t.name), toolPage(t, tools, asOf)]))];
}
