// The explorer's one script: Capsomer's system map made interactive (/assets/system-map.js,
// copied from capsomer at build). The pages are complete without it: the map is one named
// picture and its list is open. A page names its system in data-chosen, and data-enter asks
// to start inside it. A flow's step page names its flow and step in data-flow and data-step.
import { controller } from "./system-map.js";

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
  const map = controller(root, root.dataset.openLabel ?? "Open");
  if (host?.dataset.flow) {
    flowPage(map, root, host);
    continue;
  }
  const chosen = host?.dataset.chosen;
  if (!chosen) continue;
  map.select(chosen);
  if (host.hasAttribute("data-enter")) {
    // Capsomer's enter() moves focus to Step out, right after a reader's Enter and wrong on
    // load: the page would open scrolled to the drawing with focus mid-page. So the page keeps
    // its place and its focus.
    const [x, y] = [scrollX, scrollY];
    map.enter();
    if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement)) document.activeElement.blur();
    scrollTo(x, y);
  }
  // The one tab stop moves to the chosen system, so Tab enters the map where the page is.
  for (const tile of root.querySelectorAll(".cap-system-map-tile[data-id]")) tile.setAttribute("tabindex", tile.dataset.id === chosen ? "0" : "-1");
}

/**
 * A step page with script: the map plays the flow at the page's step, and Back, Next, the step
 * list, number keys and the map's own controls step it without a reload. Each step's text and
 * parts come from that step's own prerendered page, so the HTML stays the one source; the
 * address follows, so a step can be linked and the browser's Back works.
 */
function flowPage(map, root, host) {
  const flow = host.dataset.flow;
  const total = Number(host.dataset.steps);
  const pathOf = (n) => `/flows/${flow}/${n}/`;
  let current = Number(host.dataset.step);
  let ticket = 0;
  for (const hint of document.querySelectorAll("[data-keys]")) hint.hidden = false;

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
    for (const fresh of doc.querySelectorAll("[data-swap]")) document.querySelector(`[data-swap="${fresh.dataset.swap}"]`)?.replaceWith(document.adoptNode(fresh));
    document.title = doc.title;
    host.dataset.step = String(n);
    if (push) history.pushState({ step: n }, "", url);
    if (rel) (document.querySelector(`.flow-nav a[rel="${rel}"]`) ?? document.querySelector(".flow-nav a"))?.focus();
  };
  const go = (n) => (root.dataset.flow === flow ? map.step(n) : map.playFlow(flow, n));

  map.playFlow(flow, current);  // Whatever stepped (a link, a key, the map's own Back and Next), the map says so here.
  root.addEventListener("cap:system-map-flow", (e) => {
    if (e.detail.id === flow) show(e.detail.step, true);
  });
  document.addEventListener("click", (e) => {
    const link = e.target.closest?.("a[data-go]");
    if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(Number(link.dataset.go));
  });
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    const n = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
    if (!n || n > total) return;
    e.preventDefault();
    go(n);
  });
  addEventListener("popstate", () => {
    const n = Number(location.pathname.split("/").filter(Boolean)[2]);
    if (!n) return;
    show(n, false);
    go(n);
  });
}
