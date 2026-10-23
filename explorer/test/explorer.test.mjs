// The explorer's build, over explorer/fixtures (invented systems, example.com): the pages it
// writes, what they may and may not say, and the assets and headers beside them.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { build } from "../build.mjs";
import { codePage, codePath, modulePage, modulePath } from "../src/code.mjs";
import { numbersHtml } from "../src/numbers.mjs";
import { servedTools } from "../src/surface.mjs";
import { SITE, allPages, containersPath, flowPath, stepPath, systemPath } from "../src/pages.mjs";

const fixtures = new URL("../fixtures/", import.meta.url).pathname;
const read = (/** @type {string} */ name) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));
const model = read("model.json");
const stats = read("stats.json");
const code = read("code.json");
const withCode = { code: join(fixtures, "code.json"), source: join(fixtures, "source") };

/** Every file under a directory, as paths relative to it. */
function walk(/** @type {string} */ dir, /** @type {string} */ root = dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, root));
    else out.push(relative(root, full));
  }
  return out;
}

const out = mkdtempSync(join(tmpdir(), "explorer-"));
const built = await build({ model: join(fixtures, "model.json"), stats: join(fixtures, "stats.json"), ...withCode, out });
const files = walk(out);
const html = files.filter((f) => f.endsWith(".html")).map((f) => ({ file: f, text: readFileSync(join(out, f), "utf8") }));

test("every system has a page, a public one with parts has its parts page, every flow and each step of it a page, every tool a page, and nothing else is built", () => {
  const pages = files.filter((f) => f.endsWith(".html")).sort();
  const expected = [
    "404.html",
    "index.html",
    ...["systems", "flows", "numbers", "code", "search", "tools"].map((p) => `${p}/index.html`),
    ...servedTools().map((t) => `tools/${t.name}/index.html`),
    ...model.systems.map((/** @type {any} */ s) => `s/${s.id}/index.html`),
    "s/hub/containers/index.html",
    "s/theme/code/index.html",
    ...code.maps[0].modules.map((/** @type {any} */ m) => `s/theme/code/${m.path}/index.html`),
    ...model.flows.flatMap((/** @type {any} */ f) => [`flows/${f.id}/index.html`, ...f.steps.map((/** @type {any} */ _s, /** @type {number} */ i) => `flows/${f.id}/${i + 1}/index.html`)]),
  ].sort();
  assert.deepEqual(pages, expected);
  assert.equal(built.pages, expected.length);
});

test("every system page links to the same system on dustinedwards.info, and the front page to every system", () => {
  for (const s of model.systems) {
    const page = readFileSync(join(out, "s", s.id, "index.html"), "utf8");
    assert.ok(page.includes(`href="${SITE}/systems/${s.id}"`), `${s.id} has no link to dustinedwards.info`);
  }
  const home = readFileSync(join(out, "index.html"), "utf8");
  for (const s of model.systems) assert.ok(home.includes(`href="${systemPath(s.id)}"`), `the front page does not link ${s.id}`);
});

test("a private page says it is private and carries no repo link", () => {
  const vault = readFileSync(join(out, "s", "vault", "index.html"), "utf8");
  assert.match(vault, /<dd>Private<\/dd>/);
  assert.match(vault, /href="https:\/\/vault\.example\.org"/);
  assert.doesNotMatch(vault, /Source<\/dt>/);
  const gone = readFileSync(join(out, "s", "gone", "index.html"), "utf8");
  assert.match(gone, /Private: its repo is not public\./);
  assert.doesNotMatch(gone, /Address<\/dt>/);
});

test("the build refuses a model the privacy filter could not have written", async () => {
  const leaky = structuredClone(model);
  leaky.systems.find((/** @type {any} */ s) => s.id === "vault").repos = ["https://github.com/example-org/vault"];
  const file = join(mkdtempSync(join(tmpdir(), "explorer-leak-")), "model.json");
  writeFileSync(file, JSON.stringify(leaky));
  await assert.rejects(build({ model: file, stats: join(fixtures, "stats.json"), out: mkdtempSync(join(tmpdir(), "explorer-out-")) }));
});

test("a system with a code map links to it, and its code page shows each module's worst function and the cycle", () => {
  const theme = readFileSync(join(out, "s", "theme", "index.html"), "utf8");
  assert.ok(theme.includes(`href="${codePath("theme")}"`), "the system page does not link its code");
  assert.match(theme, /4 modules and 3 functions, measured 2026-10-17/);
  const hub = readFileSync(join(out, "s", "hub", "index.html"), "utf8");
  assert.ok(!hub.includes(codePath("hub")), "a system with no code map links to a code page");

  const page = readFileSync(join(out, "s", "theme", "code", "index.html"), "utf8");
  assert.match(page, /By CRAP, 1 critical, 1 to watch and 1 ok\./);
  // Each status is a glyph, a word and the number: never colour alone.
  assert.match(page, /data-tone="crit"><svg class="cap-status-glyph"[^>]*aria-hidden="true"[^>]*>.*?<\/svg>Critical<span class="code-num">CRAP 90<\/span>/);
  assert.match(page, /data-tone="warn">.*?Watch<span class="code-num">CRAP 12<\/span>/);
  assert.match(page, /data-tone="ok">.*?Ok<span class="code-num">CRAP 2<\/span>/);
  // A number nobody measured says why, never 0.
  assert.match(page, /No data<span class="cap-sr-only">: mutation testing has not run on this repo yet<\/span>/);
  assert.match(page, /src\/tokens\.ts.*?<span class="code-none">No functions<\/span>/s);
  assert.doesNotMatch(page, /CRAP 0\b|>0%</);
  assert.ok(page.includes(`<li><a href="${modulePath("theme", "src/util/a.ts")}">src/util/a.ts</a> imports <a href="${modulePath("theme", "src/util/b.ts")}">src/util/b.ts</a>, and back</li>`));
  assert.match(page, /<caption>src\/util\/<\/caption>/);
});

test("the code page draws the folders, then each folder's modules, every box linked and coloured by its worst function", () => {
  const page = readFileSync(join(out, "s", "theme", "code", "index.html"), "utf8");
  const figures = [...page.matchAll(/<figure class="code-graph">(.*?)<\/figure>/gs)].map((m) => m[1]);
  assert.equal(figures.length, 3, "one drawing of the folders and one for each folder with more than one module");
  assert.match(figures[0], /<figcaption[^>]*>The folders of example\/theme and the imports between them<\/figcaption>/);
  // A box per folder, leading to that folder's drawing and table; a wire from src/ to src/util/.
  assert.match(figures[0], /<a href="#theme-f-src" tabindex="-1"><g class="code-graph-box" data-tone="crit">/);
  assert.match(figures[0], /<a href="#theme-f-src-util" tabindex="-1"><g class="code-graph-box" data-tone="warn" data-cycle>/);
  assert.equal((figures[0].match(/class="code-graph-wire"/g) ?? []).length, 1);
  // The util folder's modules, each linked to its page, both in the cycle, with a wire each way.
  assert.ok(figures[2].includes(`<a href="${modulePath("theme", "src/util/a.ts")}" tabindex="-1"><g class="code-graph-box" data-tone="ok" data-cycle>`));
  assert.equal((figures[2].match(/class="code-graph-wire"/g) ?? []).length, 2);
  assert.equal((figures[2].match(/>cycle<\/text>/g) ?? []).length, 2);
  // The drawing repeats the table: hidden from assistive technology, its links no tab stop.
  for (const f of figures) {
    assert.match(f, /<svg class="code-graph-svg"[^>]*aria-hidden="true"/);
    assert.doesNotMatch(f, /<a href="[^"]*"(?! tabindex="-1")/);
    assert.match(f, /<div class="scroller" role="region" aria-labelledby="[^"]+-caption" tabindex="0">/);
  }
  for (const id of ["theme-f-src", "theme-f-src-util"]) assert.ok(page.includes(`id="${id}"`), `the folder anchor ${id} is missing`);
});

test("a route file name with $ and brackets gets a page under its own name, linked with the brackets escaped", async () => {
  const route = "src/routes/blog.$slug[.md].ts";
  const withRoute = structuredClone(code);
  withRoute.maps[0].modules.push({ path: route, loc: 1, imports: ["src/index.ts"], functions: [] });
  const dir = mkdtempSync(join(tmpdir(), "explorer-route-"));
  writeFileSync(join(dir, "code.json"), JSON.stringify(withRoute));
  const routeOut = mkdtempSync(join(tmpdir(), "explorer-route-out-"));
  await build({ model: join(fixtures, "model.json"), stats: join(fixtures, "stats.json"), code: join(dir, "code.json"), source: join(fixtures, "source"), out: routeOut });
  assert.equal(modulePath("theme", route), "/s/theme/code/src/routes/blog.%24slug%5B.md%5D.ts/");
  assert.ok(existsSync(join(routeOut, "s", "theme", "code", "src", "routes", "blog.$slug[.md].ts", "index.html")), "the page is not under the file's own name");
  const page = readFileSync(join(routeOut, "s", "theme", "code", "index.html"), "utf8");
  assert.ok(page.includes(`href="/s/theme/code/src/routes/blog.%24slug%5B.md%5D.ts/"`), "the code page does not link the route module escaped");
  const own = readFileSync(join(routeOut, "s", "theme", "code", "src", "routes", "blog.$slug[.md].ts", "index.html"), "utf8");
  assert.ok(own.includes("/blob/0123456789abcdef0123456789abcdef01234567/src/routes/blog.%24slug%5B.md%5D.ts"), "the GitHub link is not escaped");
});

test("a function changed since the mutation run shows no score and says why, and the page dates the run", () => {
  const map = structuredClone(code.maps[0]);
  map.tools.mutation = "stryker";
  map.mutated = { sha: "b".repeat(40), date: "2026-10-12" };
  const [index, , a, b] = map.modules;
  Object.assign(index.functions[0], { mutants: 10, score: 50 });
  Object.assign(a.functions[0], { stale: true });
  Object.assign(b.functions[0], { mutants: 4, score: 75 });
  const theme = model.systems.find((/** @type {any} */ s) => s.id === "theme");
  const page = codePage(theme, [map], "2026-10-17");
  assert.match(page, /Mutation scores are from the run on <span class="nowrap">2026-10-12<\/span> at commit <code>bbbbbbb<\/code>; 1 function has changed since and shows none until the next run\./);
  assert.match(page, /a\.ts<\/a>.*?No data<span class="cap-sr-only">: changed since the last mutation run<\/span>/s);
  assert.match(page, />mutation stale<\/text>/);
  assert.match(page, /data-tone="crit">.*?Critical<span class="code-num">50%<\/span>/);
  assert.match(page, /data-tone="warn">.*?Watch<span class="code-num">75%<\/span>/);
  assert.doesNotMatch(page, /mutation testing has not run/);
  const fn = modulePage(theme, map, a, undefined, "2026-10-17");
  assert.match(fn, /No data<span class="cap-sr-only">: changed since the last mutation run<\/span>/);
  assert.doesNotMatch(fn, /no mutants in this code/);
});

test("a module page lists its functions linked to their lines over its numbered source, and its imports both ways", () => {
  const page = readFileSync(join(out, "s", "theme", "code", "src", "index.ts", "index.html"), "utf8");
  assert.ok(page.includes('<a href="#L4">choose</a>'));
  assert.match(page, /<span class="code-line" id="L4"><span class="code-ln" aria-hidden="true">4<\/span>export function choose\(tokens: Token\[\], dark: boolean, wide: boolean\): Token \| undefined \{/);
  assert.ok(page.includes("&lt;") || !page.includes("<T>"), "source is not escaped");
  assert.ok(page.includes(`href="https://github.com/example/theme/blob/${code.maps[0].sha}/src/index.ts"`));
  assert.ok(page.includes(`It imports <a href="${modulePath("theme", "src/tokens.ts")}">src/tokens.ts</a>, <a href="${modulePath("theme", "src/util/a.ts")}">src/util/a.ts</a>.`));
  const a = readFileSync(join(out, "s", "theme", "code", "src", "util", "a.ts", "index.html"), "utf8");
  assert.ok(a.includes("&lt;T&gt;"), "a generic's angle brackets reached the page unescaped");
  assert.match(a, /It is in an import cycle\./);
  assert.match(a, /Imported by <a href="[^"]+">src\/index\.ts<\/a>, <a href="[^"]+">src\/util\/b\.ts<\/a>\./);
  const tokens = readFileSync(join(out, "s", "theme", "code", "src", "tokens.ts", "index.html"), "utf8");
  assert.match(tokens, /None: it only declares types or values\./);
});

test("the build refuses a code map for a system that is not public, and a code document with a field it does not name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "explorer-code-"));
  const write = (/** @type {string} */ name, /** @type {any} */ doc) => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(doc));
    return file;
  };
  const run = (/** @type {string} */ file) => build({ model: join(fixtures, "model.json"), stats: join(fixtures, "stats.json"), code: file, source: join(fixtures, "source"), out: mkdtempSync(join(tmpdir(), "explorer-out-")) });
  const vault = structuredClone(code);
  vault.maps[0].system = "vault";
  await assert.rejects(run(write("vault.json", vault)), /belongs to vault, which is not a public system/);
  const unknown = structuredClone(code);
  unknown.maps[0].system = "nowhere";
  await assert.rejects(run(write("unknown.json", unknown)), /belongs to nowhere/);
  const extra = structuredClone(code);
  extra.maps[0].secret = "CANARY";
  await assert.rejects(run(write("extra.json", extra)));
});

test("no page carries an inline script, an inline style or a time of day", () => {
  for (const { file, text } of html) {
    assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)[^>]*>/, `${file} has an inline script`);
    assert.doesNotMatch(text, /<style[\s>]/, `${file} has an inline style element`);
    assert.doesNotMatch(text, /\sstyle="/, `${file} has a style attribute`);
    assert.doesNotMatch(text, /\b\d{1,2}:\d{2}\b/, `${file} shows a time of day`);
    assert.ok(text.includes("2026-01-15"), `${file} does not say what day its data is of`);
  }
});

test("every link inside the explorer reaches a page or an asset it built", () => {
  const targets = new Set(files.map((f) => `/${f}`.replace(/index\.html$/, "")));
  for (const { file, text } of html) {
    for (const [, href] of text.matchAll(/(?:href|src)="(\/[^"#]*)"/g)) {
      assert.ok(targets.has(href ?? ""), `${file} links to ${href}, which the build did not write`);
    }
  }
});

test("a rate with too few cases is said so, and has no picture", () => {
  const thin = structuredClone(stats);
  thin.verification.agreement_rate_90d = null;
  thin.sites.uptime_7d = null;
  const section = numbersHtml(thin);
  assert.doesNotMatch(section, /id="agreement-title"|id="uptime-title"/);
  assert.match(section, /CI green when claimed, last 90 days<\/th><td>not enough data yet/);
});

test("the headers send the shared policy with scripts and styles from the explorer itself", () => {
  const headers = readFileSync(join(out, "_headers"), "utf8");
  assert.match(headers, /^\/\*\n/);
  assert.match(headers, /Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';/);
  assert.doesNotMatch(headers, /unsafe-inline|unsafe-eval/);
  assert.match(headers, /report-uri https:\/\/mcp\.dustinedwards\.info\/csp-report/);
  assert.match(headers, /X-Frame-Options: deny/);
});

test("the map's script is under 25 KB gzip and all the explorer's script under 105 KB", () => {
  const gz = (/** @type {string} */ f) => gzipSync(readFileSync(join(out, "assets", f)), { level: 9 }).length;
  const map = readdirSync(join(out, "assets")).filter((f) => f.startsWith("system-map")).reduce((sum, f) => sum + gz(f), 0);
  assert.ok(map < 25 * 1024, `the system map's modules are ${map} bytes gzip`);
  const all = files.filter((f) => f.endsWith(".js")).reduce((sum, f) => sum + gzipSync(readFileSync(join(out, f)), { level: 9 }).length, 0);
  assert.ok(all < 105 * 1024, `the explorer's script is ${all} bytes gzip`);
  assert.ok(existsSync(join(out, "build.json")));
});

test("build.json's hash is the same for the same input and changes with what a reader gets", async () => {
  const again = await build({ model: join(fixtures, "model.json"), stats: join(fixtures, "stats.json"), ...withCode, out: mkdtempSync(join(tmpdir(), "explorer-again-")) });
  assert.equal(again.content, built.content);
  assert.equal(JSON.parse(readFileSync(join(out, "build.json"), "utf8")).content, built.content);
  const later = structuredClone(stats);
  later.jobs.completed_7d += 1;
  const file = join(mkdtempSync(join(tmpdir(), "explorer-later-")), "stats.json");
  writeFileSync(file, JSON.stringify(later));
  const changed = await build({ model: join(fixtures, "model.json"), stats: file, ...withCode, out: mkdtempSync(join(tmpdir(), "explorer-changed-")) });
  assert.notEqual(changed.content, built.content);
});

test("a public system other than the core has its parts page with no drawing, since the map draws the core's insides", () => {
  const withParts = { ...model, containers: [...model.containers, { id: "kit-lib", system: "kit", name: "Kit library", kind: "package", technology: "npm" }] };
  const page = allPages(withParts, stats).find(([path]) => path === containersPath("kit"))?.[1] ?? "";
  assert.match(page, /Kit library/);
  assert.doesNotMatch(page, /data-enter|cap-system-map/);
  assert.match(readFileSync(join(out, "s", "hub", "containers", "index.html"), "utf8"), /data-enter/);
});

test("each week is labelled by its last whole day, the day before as_of for the newest", () => {
  const section = numbersHtml(stats);
  assert.equal(stats.as_of, "2026-01-15");
  assert.match(section, /14 Jan/);
  assert.match(section, /26 Nov/);
  assert.doesNotMatch(section, /15 Jan/);
});

test("an external container is listed outside the system, never as one of its parts", () => {
  const page = readFileSync(join(out, "s", "hub", "containers", "index.html"), "utf8");
  const table = page.slice(page.indexOf("<table"), page.indexOf("</table>"));
  assert.doesNotMatch(table, /Agents/);
  assert.match(page, /<h2 id="outside-title">Outside it<\/h2>\s*<ul><li id="part-hub-agents"><strong>Agents<\/strong> \(Sample sessions\)/);
  assert.match(page, /Its 3 parts, .*, and the 1 it works with outside it\./);
  assert.match(readFileSync(join(out, "s", "hub", "index.html"), "utf8"), /its 3 parts and how they connect/);
});

// Flows (design section 4, "Animated flows"). Read from the fixture's own steps, not through
// the renderer's resolveFlow, so a mistake there cannot agree with itself here.
const stepFile = (/** @type {string} */ flow, /** @type {number} */ n) => readFileSync(join(out, "flows", flow, String(n), "index.html"), "utf8");
const edge = (/** @type {string} */ id) => model.relationships.find((/** @type {any} */ r) => r.id === id);
/** Every link's target in one region of a page, by the attribute that marks the link. */
const hrefOf = (/** @type {string} */ page, /** @type {string} */ rel) => page.match(new RegExp(`<a rel="${rel}" href="([^"]+)"`))?.[1];

test("the fixtures carry flows enough to test with: one with a middle step", () => {
  assert.ok(model.flows.length >= 2);
  assert.ok(model.flows.some((/** @type {any} */ f) => f.steps.length >= 3));
});

test("every step of every flow has its page, saying the flow's name, where it is and what happens", () => {
  let seen = 0;
  for (const f of model.flows) {
    assert.ok(existsSync(join(out, "flows", f.id, "index.html")), `${f.id} has no page`);
    f.steps.forEach((/** @type {any} */ st, /** @type {number} */ i) => {
      const page = stepFile(f.id, i + 1);
      assert.ok(page.includes(`<h1>${f.name.replace("'", "&#39;")}</h1>`), `${f.id} step ${i + 1} does not name its flow`);
      assert.ok(page.includes(`Step ${i + 1} of ${f.steps.length}`), `${f.id} step ${i + 1} does not say where it is`);
      assert.ok(page.includes(`<p class="flow-text">${st.text.replace("'", "&#39;")}</p>`), `${f.id} step ${i + 1} does not say what happens`);
      seen++;
    });
  }
  assert.equal(seen, model.flows.reduce((/** @type {number} */ n, /** @type {any} */ f) => n + f.steps.length, 0));
});

test("each step page lays every step's text in one stack, the shown one alone read and linked", () => {
  let pages = 0;
  for (const f of model.flows) {
    for (let n = 1; n <= f.steps.length; n++) {
      const page = stepFile(f.id, n);
      const stack = page.slice(page.indexOf('<div class="flow-stack">'), page.indexOf('<nav class="flow-nav"'));
      const blocks = stack.split(/(?=<div(?: class="flow-unseen"[^>]*)?>\n<h2)/).slice(1);
      assert.equal(blocks.length, f.steps.length, `${f.id} step ${n} stacks ${blocks.length} steps`);
      blocks.forEach((b, i) => {
        const shown = i + 1 === n;
        assert.ok(b.includes(`Step ${i + 1} of ${f.steps.length}`), `${f.id} step ${n}: block ${i + 1} is out of order`);
        assert.equal(b.startsWith('<div class="flow-unseen" aria-hidden="true" inert>'), !shown, `${f.id} step ${n}: block ${i + 1} is ${shown ? "hidden" : "read"}`);
        assert.equal(/<a |id=|data-part=/.test(b), shown, `${f.id} step ${n}: block ${i + 1} ${shown ? "lacks" : "carries"} links or ids`);
      });
      pages++;
    }
  }
  assert.equal(pages, model.flows.reduce((/** @type {number} */ k, /** @type {any} */ f) => k + f.steps.length, 0));
});

test("Back and Next chain every step to the next both ways, with no Back on the first and no Next on the last", () => {
  let links = 0;
  for (const f of model.flows) {
    const total = f.steps.length;
    for (let n = 1; n <= total; n++) {
      const page = stepFile(f.id, n);
      assert.equal(hrefOf(page, "prev"), n > 1 ? stepPath(f.id, n - 1) : undefined, `${f.id} step ${n}'s Back`);
      assert.equal(hrefOf(page, "next"), n < total ? stepPath(f.id, n + 1) : undefined, `${f.id} step ${n}'s Next`);
      if (n < total) {
        assert.equal(hrefOf(stepFile(f.id, n + 1), "prev"), stepPath(f.id, n), `${f.id} step ${n + 1} does not lead back to ${n}`);
        links += 2;
      }
      // The list of all steps is on every step, the shown one marked.
      for (let k = 1; k <= total; k++) assert.ok(page.includes(`href="${stepPath(f.id, k)}" data-go="${k}"${k === n ? ' aria-current="step"' : ""}>`), `${f.id} step ${n} does not list step ${k}`);
    }
  }
  assert.equal(links, model.flows.reduce((/** @type {number} */ n, /** @type {any} */ f) => n + 2 * (f.steps.length - 1), 0));
});

test("each step page names exactly the parts its step touches, and its drawing lights exactly them", () => {
  for (const f of model.flows) {
    f.steps.forEach((/** @type {any} */ st, /** @type {number} */ i) => {
      const page = stepFile(f.id, i + 1);
      const r = edge(st.relationship);
      const want = [...new Set([r.from, r.to, ...(st.lights ?? [])])].sort();
      // The shown step's list, after its heading; the unseen steps around it carry no data-part.
      const at = page.indexOf('<ul class="flow-touches">', page.indexOf('id="step-title"'));
      const touches = page.slice(at, page.indexOf("</ul>", at));
      const named = [...touches.matchAll(/<li data-part="([^"]+)"><a href="([^"]+)">/g)];
      assert.deepEqual(named.map((m) => m[1]).sort(), want, `${f.id} step ${i + 1} names the wrong parts`);
      for (const [, id, href] of named) {
        const c = model.containers.find((/** @type {any} */ x) => x.id === id);
        assert.equal(href, `${containersPath(c.system)}#part-${id}`);
      }
      const on = [...page.matchAll(/<path class="cap-system-map-wire" data-from="([^"]+)" data-to="([^"]+)" data-on/g)].map((m) => `${m[1]} ${m[2]}`);
      assert.deepEqual(on, [`${r.from} ${r.to}`], `${f.id} step ${i + 1} draws the wrong line`);
      const lit = [...page.matchAll(/<g class="cap-system-map-box" data-id="([^"]+)" data-lit/g)].map((m) => m[1]).sort();
      assert.deepEqual(lit, [...(st.lights ?? [])].sort(), `${f.id} step ${i + 1} lights the wrong parts`);
      assert.match(page, new RegExp(`data-id="${st.toward}"(?: data-lit)? data-at`));
      assert.match(page, /<figure class="cap-system-map" data-cap="system-map" data-entered/);
    });
  }
});

test("a part's link from a step lands on its row on the parts page", () => {
  const parts = readFileSync(join(out, "s", "hub", "containers", "index.html"), "utf8");
  for (const c of model.containers.filter((/** @type {any} */ x) => x.system === "hub")) assert.ok(parts.includes(`id="part-${c.id}"`), `no anchor for ${c.id}`);
});

test("a flow step riding an edge the model does not have fails the build", async () => {
  const bad = structuredClone(model);
  bad.flows[0].steps[1].relationship = "hub-tick--reads--hub-worker";
  const file = join(mkdtempSync(join(tmpdir(), "explorer-edge-")), "model.json");
  writeFileSync(file, JSON.stringify(bad));
  await assert.rejects(build({ model: file, stats: join(fixtures, "stats.json"), out: mkdtempSync(join(tmpdir(), "explorer-out-")) }), /rides hub-tick--reads--hub-worker, which is not a relationship/);
  const away = structuredClone(model);
  away.flows[0].steps[0].toward = "hub-tick";
  assert.throws(() => allPages(away, stats), /goes toward hub-tick, which is not an end/);
});

test("a flow touching a part the public model does not hold renders nothing", () => {
  const viaEdge = structuredClone(model);
  viaEdge.flows[0].steps[0].relationship = "hub--coordinates--vault";
  viaEdge.flows[0].steps[0].toward = "vault";
  assert.throws(() => allPages(viaEdge, stats), /touches hub, which is not a part in the public model/);
  const viaLight = structuredClone(model);
  viaLight.flows[0].steps[0].lights = ["vault-db"];
  assert.throws(() => allPages(viaLight, stats), /touches vault-db, which is not a part in the public model/);
});

test("the core's page and its parts page link each flow over its parts, and a system it does not touch does not", () => {
  for (const page of [join(out, "s", "hub", "index.html"), join(out, "s", "hub", "containers", "index.html")]) {
    const text = readFileSync(page, "utf8");
    for (const f of model.flows) assert.ok(text.includes(`href="${flowPath(f.id)}"`), `${page} does not link ${f.id}`);
  }
  assert.doesNotMatch(readFileSync(join(out, "s", "kit", "index.html"), "utf8"), /href="\/flows\/[^"]/);
});
