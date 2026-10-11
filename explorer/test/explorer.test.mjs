// The explorer's build, over explorer/fixtures (invented systems, example.com): the pages it
// writes, what they may and may not say, and the assets and headers beside them.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { build } from "../build.mjs";
import { SITE, allPages, containersPath, numbersHtml, systemPath } from "../src/pages.mjs";

const fixtures = new URL("../fixtures/", import.meta.url).pathname;
const read = (/** @type {string} */ name) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));
const model = read("model.json");
const stats = read("stats.json");

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
const built = await build({ model: join(fixtures, "model.json"), stats: join(fixtures, "stats.json"), out });
const files = walk(out);
const html = files.filter((f) => f.endsWith(".html")).map((f) => ({ file: f, text: readFileSync(join(out, f), "utf8") }));

test("every system has a page, a public one with parts has its parts page, and nothing else is built", () => {
  const pages = files.filter((f) => f.endsWith(".html")).sort();
  const expected = ["404.html", "index.html", ...model.systems.map((/** @type {any} */ s) => `s/${s.id}/index.html`), "s/hub/containers/index.html"].sort();
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

test("a private page says it is private and carries nothing but its name and address", () => {
  const vault = readFileSync(join(out, "s", "vault", "index.html"), "utf8");
  assert.match(vault, /Private: its name and address only\./);
  assert.match(vault, /href="https:\/\/vault\.example\.org"/);
  assert.doesNotMatch(vault, /Source<\/dt>/);
  assert.doesNotMatch(vault, /Inside Vault/);
  const gone = readFileSync(join(out, "s", "gone", "index.html"), "utf8");
  assert.match(gone, /Private: its name only\./);
  assert.doesNotMatch(gone, /Address<\/dt>/);
});

test("a private system gets no parts page even when parts name it", () => {
  const withParts = { ...model, containers: [...model.containers, { id: "x", system: "vault", name: "X", kind: "worker", technology: "Y" }] };
  const paths = allPages(withParts, stats).map(([path]) => path);
  assert.ok(paths.includes(containersPath("hub")));
  assert.ok(!paths.includes(containersPath("vault")), "a private system has a parts page");
});

test("the build refuses a model the privacy filter could not have written", async () => {
  const leaky = structuredClone(model);
  leaky.systems.find((/** @type {any} */ s) => s.id === "vault").description = "What the vault holds.";
  const file = join(mkdtempSync(join(tmpdir(), "explorer-leak-")), "model.json");
  writeFileSync(file, JSON.stringify(leaky));
  await assert.rejects(build({ model: file, stats: join(fixtures, "stats.json"), out: mkdtempSync(join(tmpdir(), "explorer-out-")) }));
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
  assert.ok(gz("system-map.js") < 25 * 1024, `system-map.js is ${gz("system-map.js")} bytes gzip`);
  const all = files.filter((f) => f.endsWith(".js")).reduce((sum, f) => sum + gzipSync(readFileSync(join(out, f)), { level: 9 }).length, 0);
  assert.ok(all < 105 * 1024, `the explorer's script is ${all} bytes gzip`);
  assert.ok(existsSync(join(out, "build.json")));
});

test("build.json's hash is the same for the same input and changes with what a reader gets", async () => {
  const again = await build({ model: join(fixtures, "model.json"), stats: join(fixtures, "stats.json"), out: mkdtempSync(join(tmpdir(), "explorer-again-")) });
  assert.equal(again.content, built.content);
  assert.equal(JSON.parse(readFileSync(join(out, "build.json"), "utf8")).content, built.content);
  const later = structuredClone(stats);
  later.jobs.completed_7d += 1;
  const file = join(mkdtempSync(join(tmpdir(), "explorer-later-")), "stats.json");
  writeFileSync(file, JSON.stringify(later));
  const changed = await build({ model: join(fixtures, "model.json"), stats: file, out: mkdtempSync(join(tmpdir(), "explorer-changed-")) });
  assert.notEqual(changed.content, built.content);
});

test("the workflow's pull request paths name every Capsid module the build loads", () => {
  // build.mjs and src/pages.mjs import these from ../src; each runtime import they pull in
  // can break the build, so a change to any of them must run the explorer's checks.
  const root = new URL("../../", import.meta.url).pathname;
  const seen = new Set();
  const visit = (/** @type {string} */ rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = readFileSync(join(root, rel), "utf8");
    for (const [, spec] of text.matchAll(/^(?:import|export) (?!type\b)[^;]*? from "(\.\/[^"]+)"/gm)) {
      visit(join("src", `${(spec ?? "").replace(/^\.\//, "").replace(/\.ts$/, "")}.ts`));
    }
  };
  for (const rel of ["src/system-model.ts", "src/public-stats.ts", "src/html.ts"]) visit(rel);
  assert.ok(seen.size >= 6, `the walk found only ${seen.size} modules`);
  const workflow = readFileSync(join(root, ".github/workflows/explorer.yml"), "utf8");
  const pr = workflow.slice(workflow.indexOf("pull_request:"), workflow.indexOf("push:"));
  for (const rel of seen) assert.ok(pr.includes(`"${rel}"`), `explorer.yml's pull_request paths do not name ${rel}`);
});

test("a public system other than the core has its parts page with no drawing, since the map draws the core's insides", () => {
  const withParts = { ...model, containers: [...model.containers, { id: "kit-lib", system: "kit", name: "Kit library", kind: "package", technology: "npm" }] };
  const page = allPages(withParts, stats).find(([path]) => path === containersPath("kit"))?.[1] ?? "";
  assert.match(page, /Kit library/);
  assert.doesNotMatch(page, /data-enter|cap-system-map|explorer\.js/);
  assert.match(readFileSync(join(out, "s", "hub", "containers", "index.html"), "utf8"), /data-enter/);
});

test("each week is labelled by its last whole day, the day before as_of for the newest", () => {
  const section = numbersHtml(stats);
  assert.equal(stats.as_of, "2026-01-15");
  assert.match(section, /14 Jan/);
  assert.match(section, /26 Nov/);
  assert.doesNotMatch(section, /15 Jan/);
});
