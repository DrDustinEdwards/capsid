// The explorer's one script: Capsomer's system map made interactive (/assets/system-map.js,
// copied from capsomer at build). The pages are complete without it: the map is one named
// picture and its list is open. A page names its system in data-chosen, and data-enter asks
// to start inside it.
import { controller } from "./system-map.js";

for (const root of document.querySelectorAll("[data-cap='system-map']")) {
  if (root.hasAttribute("data-cap-ready")) continue;
  root.setAttribute("data-cap-ready", "");
  const map = controller(root, root.dataset.openLabel ?? "Open");
  const host = root.closest(".map-host");
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
