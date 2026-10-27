// The explorer's one script. Every page is complete without it: the maps are named pictures with
// their lists open, every step is a page, every tool and module has an address, and the tables
// are plain tables. This makes them move: Capsomer's system map (copied from capsomer at build),
// its tabs, Enarratio's chart tooltips, the flow players, the front page's panel and tour, the filters
// and sorting, and search.
import { controller } from "./capsomer/system-map/system-map.js";
import { enhance as enhanceTabs } from "./tabs.js";
import { enhance as enhanceCharts } from "./enhance.js";
import { enhance as enhanceHeader } from "./capsomer/site-header/site-header.js";
import { enhance as enhanceTheme, toggleTheme } from "./capsomer/theme-switch/theme-switch.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const STEP_MS = 3600;

document.documentElement.classList.add("js");
enhanceHeader();
enhanceTheme();

for (const root of document.querySelectorAll("[data-cap='system-map']")) {
  if (root.hasAttribute("data-cap-ready")) continue;
  root.setAttribute("data-cap-ready", "");
  const host = root.closest(".map-host");
  if (host?.dataset.flow) {
    // The page arrives drawn at its step (src/pages.mjs, markStep). Capsomer starts from the
    // shell and goes inside itself, so the drawn state goes first; in one task, so nothing moves.
    root.removeAttribute("data-entered");
    for (const el of root.querySelectorAll("[data-on], [data-lit], [data-at]")) {
      el.removeAttribute("data-on");
      el.removeAttribute("data-lit");
      el.removeAttribute("data-at");
    }
  }
  // A page drawn zoomed into a system (src/pages.mjs, familyMap) is zoomed again by Capsomer, with no movement.
  const map = controller(root, root.dataset.openLabel ?? "Open");
  if (host?.dataset.flow) {
    if (host.hasAttribute("data-player")) player(map, root, host);
    else flowPage(map, root, host);
  }
}

/**
 * Play steps a flow on its own, one step every few seconds, and stops at the end, on a key, or
 * when the tab is hidden. The button says what pressing it will do.
 * @param {HTMLButtonElement | null} button @param {() => number} current @param {number} total @param {(n: number) => void} go
 */
function autoplay(button, current, total, go) {
  if (!button) return { stop() {}, start() {} };
  let timer = 0;
  const label = () => (button.textContent = timer ? "Pause" : current() >= total ? "Play again" : "Play");
  const stop = () => {
    clearInterval(timer);
    timer = 0;
    label();
  };
  const start = () => {
    if (timer) return;
    if (current() >= total) go(1);
    timer = setInterval(() => {
      if (current() >= total) return stop();
      go(current() + 1);
    }, reduced.matches ? STEP_MS * 1.5 : STEP_MS);
    label();
  };
  button.hidden = false;
  button.setAttribute("aria-live", "off");
  button.addEventListener("click", () => (timer ? stop() : start()));
  document.addEventListener("visibilitychange", () => document.hidden && stop());
  label();
  return { stop, start, playing: () => !!timer };
}

/**
 * The front page's player: the map plays its flow in place, with no address of its own, so
 * stepping never adds to the browser's history. The tour's chapter nearest the middle of the
 * screen is the step shown, and its parts' names light with the drawing.
 */
function player(map, root, host) {
  const flow = host.dataset.flow;
  const total = Number(host.dataset.steps);
  let current = 1;
  map.playFlow(flow, 1);
  root.addEventListener("cap:system-map-flow", (e) => {
    if (e.detail.id === flow) current = e.detail.step;
  });
  const go = (n) => (root.dataset.flow === flow ? map.step(n) : map.playFlow(flow, n));
  const play = autoplay(host.parentElement.querySelector("[data-autoplay]"), () => current, total, go);
  root.addEventListener("keydown", () => play.stop());
  const chapters = [...document.querySelectorAll("[data-tour-step]")];
  if (!chapters.length) return;
  const show = (n) => {
    for (const c of chapters) c.classList.toggle("is-on", c.dataset.tourStep === String(n));
    if (n !== current) go(n);
  };
  show(1);
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) show(Number(e.target.dataset.tourStep));
    },
    // On a narrow screen the drawing covers the top, so the reading line sits lower.
    { rootMargin: matchMedia("(max-width: 64rem)").matches ? "-70% 0px -28% 0px" : "-45% 0px -45% 0px" }
  );
  for (const c of chapters) seen.observe(c);
}

/**
 * A step page with script: the map plays the flow at the page's step, and Back, Next, the step
 * list, number keys, Play and the map's own controls step it without a reload. Each step's text
 * and parts come from that step's own prerendered page, so the HTML stays the one source; the
 * address follows, so a step can be linked and the browser's Back works. While Play runs, the
 * address is replaced rather than pushed, so Back leaves the flow instead of stepping through it.
 */
function flowPage(map, root, host) {
  const flow = host.dataset.flow;
  const total = Number(host.dataset.steps);
  const pathOf = (n) => `/flows/${flow}/${n}/`;
  let current = Number(host.dataset.step);
  let ticket = 0;
  for (const hint of document.querySelectorAll("[data-keys]")) hint.hidden = false;

  /** @type {{ stop(): void, start(): void, playing?: () => boolean }} */
  let play = { stop() {}, start() {} };
  const show = async (n, push) => {
    if (n === current) return;
    current = n;
    const mine = ++ticket;
    const url = pathOf(n);
    let doc;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      doc = new DOMParser().parseFromString(await res.text(), "text/html");
    } catch {
      location.assign(url);
      return;
    }
    if (mine !== ticket) return;
    // Focus on a link that is about to be replaced moves to its twin, or to the other one.
    const rel = document.activeElement?.closest?.("[data-swap]") ? document.activeElement.getAttribute("rel") : null;
    const button = document.querySelector("[data-swap='step'] [data-autoplay]");
    for (const fresh of doc.querySelectorAll("[data-swap]")) {
      // The Play button lives on across steps, so its state and listener stay.
      const twin = fresh.querySelector("[data-autoplay]");
      if (button && twin) twin.replaceWith(button);
      document.querySelector(`[data-swap="${fresh.dataset.swap}"]`)?.replaceWith(document.adoptNode(fresh));
    }
    document.title = doc.title;
    // The trail names the step too, so it moves with it.
    const crumbs = doc.querySelector(".crumbs");
    if (crumbs) document.querySelector(".crumbs")?.replaceWith(document.adoptNode(crumbs));
    host.dataset.step = String(n);
    if (push && !play.playing?.()) history.pushState({ step: n }, "", url);
    else history.replaceState({ step: n }, "", url);
    if (rel) (document.querySelector(`.flow-nav a[rel="${rel}"]`) ?? document.querySelector(".flow-nav a"))?.focus();
  };
  const go = (n) => (root.dataset.flow === flow ? map.step(n) : map.playFlow(flow, n));
  play = autoplay(document.querySelector("[data-swap='step'] [data-autoplay]"), () => current, total, go);

  map.playFlow(flow, current);
  // Whatever stepped (a link, a key, the map's own Back and Next), the map says so here.
  root.addEventListener("cap:system-map-flow", (e) => {
    if (e.detail.id === flow) show(e.detail.step, true);
  });
  document.addEventListener("click", (e) => {
    const link = e.target.closest?.("a[data-go]");
    if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    play.stop();
    go(Number(link.dataset.go));
  });
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    const n = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
    if (!n || n > total) return;
    e.preventDefault();
    play.stop();
    go(n);
  });
  addEventListener("popstate", () => {
    const n = Number(location.pathname.split("/").filter(Boolean)[2]);
    if (!n) return;
    play.stop();
    show(n, false);
    go(n);
  });
}

enhanceTabs();
enhanceCharts(document, { tooltips: true, filter: true, brush: false, entrance: !reduced.matches });

// The front page's panel: each breaker switches a grant, and every circuit lights by the rule
// the build drew it with (src/home.mjs, reaches), which is src/scope.ts's needFor.
for (const panel of document.querySelectorAll("[data-board]")) {
  const breakers = panel;
  const count = panel.querySelector("[data-board-count]");
  const circuits = [...panel.querySelectorAll(".circuit")];
  const reaches = (need, h) =>
    need === "read" ? (h.read ? "full" : "")
    : need === "write" ? (h.write ? "full" : "")
    : need === "admin" ? (h.admin && h.write ? "full" : "")
    : need === "admin_read" ? (h.admin && h.read ? "full" : "")
    : need === "action" ? (h.read && h.write ? "full" : h.read || h.write ? "part" : "")
    : "";
  const who = (h) =>
    !h.read && !h.write && !h.admin ? "An agent with no access" : h.admin && h.read && h.write ? "The admin" : h.read && !h.write && !h.admin ? "A read-only agent" : `An agent with ${[h.read && "read", h.write && "write", h.admin && "admin"].filter(Boolean).join(" and ")} access`;
  const apply = () => {
    const h = Object.fromEntries([...breakers.querySelectorAll("[data-grant]")].map((b) => [b.dataset.grant, b.getAttribute("aria-pressed") === "true"]));
    let full = 0;
    let part = 0;
    for (const c of circuits) {
      const on = reaches(c.dataset.need, h);
      if (on) c.dataset.on = on;
      else delete c.dataset.on;
      if (on === "full") full++;
      if (on === "part") part++;
    }
    count.textContent = `${who(h)} can use ${full} of ${circuits.length} tools${part ? `, and ${part} more in part` : ""}.`;
  };
  for (const b of breakers.querySelectorAll("[data-grant]")) {
    b.addEventListener("click", () => {
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
      apply();
    });
  }
}

// The front page's claim: the reader changes what the agent says, or lets it lie at random, and
// the check plays out: the claim goes to GitHub, GitHub's reading comes back, and the record
// is stamped. What it keeps is the rule the build wrote it with (src/home.mjs, verdict), which
// is src/job-claims.ts's evaluationRows.
for (const desk of document.querySelectorAll("[data-desk]")) {
  const words = (kind, n) => (kind === "ci_green" ? (n ? "Yes" : "No") : String(n));
  const said = desk.querySelector("[data-desk-said]");
  const read = desk.querySelector("[data-desk-read]");
  const kept = desk.querySelector("[data-desk-kept]");
  const cell = desk.querySelector(".desk-kept");
  const stamp = desk.querySelector("[data-desk-stamp]");
  const out = desk.querySelector("[data-desk-verdict]");
  const tally = desk.querySelector("[data-desk-tally]");
  const kinds = [...desk.querySelectorAll("[data-kind]")];
  let kind = kinds[0].dataset.kind;
  let truth = Number(kinds[0].dataset.read);
  let claim = truth;
  let tries = 0;
  let caught = 0;
  let run = 0;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduced.matches ? 0 : ms));
  const check = async (counted) => {
    const mine = ++run;
    const agree = claim === truth;
    said.textContent = words(kind, claim);
    desk.dataset.phase = "sent";
    out.textContent = "Checking with GitHub\u2026";
    await wait(350);
    if (mine !== run) return;
    desk.dataset.phase = "reading";
    read.textContent = kept.textContent = "\u2026";
    await wait(700);
    if (mine !== run) return;
    read.textContent = words(kind, truth);
    await wait(250);
    if (mine !== run) return;
    kept.textContent = words(kind, truth);
    if (agree) cell.dataset.agree = "";
    else delete cell.dataset.agree;
    stamp.textContent = agree ? "Match" : "Caught";
    desk.dataset.phase = "done";
    out.textContent = agree
      ? `They match. Capsid saves ${words(kind, truth)}.`
      : `Caught. The agent said ${words(kind, claim)} and GitHub says ${words(kind, truth)}. Capsid saves GitHub's answer and flags the mismatch.`;
    if (counted) {
      tries++;
      if (!agree) caught++;
      tally.textContent = `Caught ${caught} of ${tries} ${tries === 1 ? "lie" : "lies"}`;
    }
  };
  const pick = (k) => {
    for (const o of kinds) o.setAttribute("aria-pressed", String(o === k));
    kind = k.dataset.kind;
    truth = Number(k.dataset.read);
  };
  for (const k of kinds) {
    k.addEventListener("click", () => {
      pick(k);
      claim = truth;
      check(false);
    });
  }
  for (const b of desk.querySelectorAll("[data-desk-step]")) {
    b.addEventListener("click", () => {
      const max = kind === "ci_green" ? 1 : 99;
      claim = Math.min(max, Math.max(0, claim + Number(b.dataset.deskStep)));
      check(false);
    });
  }
  // A lie at random: any of the checks, a claim that is never what GitHub reads.
  desk.querySelector("[data-desk-fool]").addEventListener("click", () => {
    pick(kinds[Math.floor(Math.random() * kinds.length)]);
    if (kind === "ci_green") claim = 1 - truth;
    else {
      const off = 1 + Math.floor(Math.random() * 3);
      claim = truth - off >= 0 && Math.random() < 0.4 ? truth - off : truth + off;
    }
    check(true);
  });
}

// The front page's search: the question and the mode are the box's own state; the stylesheet
// shows each row by how it matched (src/home.mjs, knowledge).
for (const box of document.querySelectorAll("[data-kb-search]")) {
  const asks = [...box.querySelectorAll("[data-ask]")];
  const modes = [...box.querySelectorAll("[data-mode-set]")];
  for (const a of asks) {
    a.addEventListener("click", () => {
      for (const o of asks) o.setAttribute("aria-pressed", String(o === a));
      for (const el of box.querySelectorAll(".kb-out [data-q]")) el.hidden = el.dataset.q !== a.dataset.ask;
    });
  }
  for (const m of modes) {
    m.addEventListener("click", () => {
      for (const o of modes) o.setAttribute("aria-pressed", String(o === m));
      box.dataset.mode = m.dataset.modeSet;
    });
  }
}

// The front page's session start: the brief arrives a document at a time; a note written
// in one session is there when the next one starts.
for (const box of document.querySelectorAll("[data-session]")) {
  const start = box.querySelector("[data-start]");
  const write = box.querySelector("[data-write]");
  const items = [...box.querySelectorAll("[data-brief]")];
  const mine = box.querySelector("[data-mine]");
  const budget = box.querySelector("[data-budget]");
  const budgetWords = box.querySelector("[data-budget-words]");
  const said = box.querySelector("[data-session-said]");
  const kb = (li) => Number.parseInt(li.querySelector(".kb-size").textContent, 10);
  let written = false;
  let run = 0;
  box.dataset.ready = "";
  for (const li of items) li.hidden = true;
  budget.value = 0;
  budgetWords.textContent = "Nothing sent yet.";
  start.addEventListener("click", async () => {
    const mine0 = ++run;
    write.disabled = true;
    const shown = items.filter((li) => li !== mine || written);
    for (const li of items) li.hidden = true;
    let total = 0;
    said.textContent = "Reading the project's notes\u2026";
    for (const li of shown) {
      await new Promise((r) => setTimeout(r, reduced.matches ? 0 : 220));
      if (mine0 !== run) return;
      li.hidden = false;
      total += kb(li);
      budget.value = total;
      budgetWords.textContent = `${total} KB of the 40 KB limit.`;
    }
    budgetWords.textContent = `${total} KB of the 40 KB limit. Nothing cut.`;
    said.textContent = written ? "New session. Your note from last time is there." : "The session has the project's notes. Write a note, then start again.";
    write.disabled = written;
  });
  write.addEventListener("click", () => {
    written = true;
    write.disabled = true;
    said.textContent = "Saved to sample/sessions/2026-10-25.md, and the log records who wrote it. Now start a new session.";
  });
}

// Filters: a text field and chips over the items of the page they sit on.
for (const bar of document.querySelectorAll("[data-filter]")) {
  bar.hidden = false;
  const items = [...document.querySelectorAll("[data-item]")];
  const q = bar.querySelector("[data-filter-q]");
  const count = bar.querySelector("[data-filter-count]");
  const empty = document.querySelector("[data-filter-empty]");
  let chip = "all";
  const apply = () => {
    const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const item of items) {
      const kinds = (item.dataset.kinds ?? "").split(" ");
      const ok = (chip === "all" || kinds.includes(chip)) && words.every((w) => (item.dataset.text ?? item.textContent.toLowerCase()).includes(w));
      item.hidden = !ok;
      if (ok) shown++;
    }
    count.textContent = `${shown} of ${items.length} shown`;
    if (empty) empty.hidden = shown > 0;
  };
  q.addEventListener("input", apply);
  for (const b of bar.querySelectorAll("[data-chip]")) {
    b.addEventListener("click", () => {
      chip = b.dataset.chip;
      for (const o of bar.querySelectorAll("[data-chip]")) o.setAttribute("aria-pressed", String(o === b));
      apply();
    });
  }
  apply();
}

// Sortable tables: each column heading becomes a button; numbers sort by their data-sort value.
for (const table of document.querySelectorAll("table[data-sortable]")) {
  const heads = [...table.querySelectorAll("thead th")];
  const body = table.tBodies[0];
  heads.forEach((th, col) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sort";
    button.append(...th.childNodes);
    th.append(button);
    button.addEventListener("click", () => {
      const down = th.getAttribute("aria-sort") !== "descending";
      for (const h of heads) h.removeAttribute("aria-sort");
      th.setAttribute("aria-sort", down ? "descending" : "ascending");
      const key = (row) => {
        const cell = row.children[col];
        const v = cell?.dataset.sort ?? cell?.textContent.trim() ?? "";
        return v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v.toLowerCase();
      };
      const rows = [...body.rows].sort((a, b) => {
        const [x, y] = [key(a), key(b)];
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return down ? -c : c;
      });
      body.append(...rows);
    });
  });
}

// "/" from anywhere goes to search, or focuses its field there; "t" switches the theme.
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (e.key === "t") return toggleTheme();
  if (e.key !== "/") return;
  e.preventDefault();
  const field = document.querySelector("[data-search]") ?? document.querySelector(".cap-site-header-search input");
  if (field) field.focus();
  else location.assign("/search/");
});

const KIND_RANK = { System: 0, Flow: 1, Tool: 2, Part: 3, Step: 4, Action: 5, Module: 6, Function: 7 };

// Search: the index is read once, from the explorer itself, and matched as you type.
const field = document.querySelector("[data-search]");
if (field) {
  const out = document.querySelector("[data-search-results]");
  const count = document.querySelector("[data-search-count]");
  let entries = null;
  const escape = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const run = () => {
    const words = field.value.toLowerCase().split(/\s+/).filter(Boolean);
    const url = new URL(location.href);
    if (words.length) url.searchParams.set("q", field.value);
    else url.searchParams.delete("q");
    history.replaceState(null, "", url);
    if (!words.length || !entries) {
      out.replaceChildren();
      count.textContent = entries ? `${entries.length} things to search.` : "Loading the index.";
      return;
    }
    const scored = [];
    for (const e of entries) {
      const name = e[1].toLowerCase();
      const all = `${name} ${e[2].toLowerCase()} ${e[0].toLowerCase()}`;
      if (!words.every((w) => all.includes(w))) continue;
      // An exact name first, then names holding every word, then the rest; within each, the
      // kinds a reader most likely wants (a system before a function), then shorter names.
      const tier = name === words.join(" ") ? 0 : words.every((w) => name.includes(w)) ? 1 : 2;
      const score = tier * 100 + (KIND_RANK[e[0]] ?? 9) * 10 + Math.min(name.length, 90) / 10;
      scored.push([score, e]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    const shown = scored.slice(0, 60);
    out.innerHTML = shown.map(([, e]) => `<li><a href="${escape(e[3])}"><span class="search-kind">${escape(e[0])}</span><span class="search-name">${escape(e[1])}</span><span class="search-detail">${escape(e[2])}</span></a></li>`).join("");
    count.textContent = scored.length ? `${scored.length} found${scored.length > shown.length ? `, the first ${shown.length} shown` : ""}.` : `Nothing matches “${field.value.trim()}”.`;
  };
  field.addEventListener("input", run);
  field.form?.addEventListener("submit", (e) => {
    e.preventDefault();
    out.querySelector("a")?.click();
  });
  field.value = new URL(location.href).searchParams.get("q") ?? "";
  count.textContent = "Loading the index.";
  fetch("/assets/search.json")
    .then((r) => r.json())
    .then((doc) => {
      entries = doc.entries;
      run();
    })
    .catch(() => (count.textContent = "Search didn't load. Browse the systems, tools or code instead."));
  field.focus();
}

// Each section's parts rise into place once, as it first comes into view.
if (!reduced.matches && "IntersectionObserver" in window) {
  const parts = document.querySelectorAll("main.wide > section:not(.board) > *, main.wide .poster > li");
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        seen.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" }
  );
  for (const [i, el] of [...parts].entries()) {
    const box = el.getBoundingClientRect();
    if (box.top < innerHeight) continue;
    el.classList.add("rise");
    el.dataset.delay = String(i % 4);
    seen.observe(el);
  }
}
