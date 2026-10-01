import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

// In-page anchors (capsid/research/design-portal-linear.md D20, as amended by the UI
// audit's ruling 4). One bar, "On this page", over the view's [data-section] blocks that
// have an id. It mounts only when the view has at least three such sections AND its
// content is taller than two screens of the window in use: a sticky bar costs the space
// it is meant to save, so a short view does without. Both are measured again when the
// window or the content changes size.
//
// Entries are links to #id. The current one, the last section whose top has passed the
// bar (or the last section, once the view is scrolled to its foot), carries aria-current. A click scrolls (at once under prefers-reduced-motion),
// moves focus to the section and replaces the address's hash. The scroller gets
// scroll-padding-top in styles.css, so a focused row is never under the bar (WCAG
// 2.4.11). Render <Anchors /> as the first child of the view's page element.

const MIN_SECTIONS = 3;
const MIN_SCREENS = 2;

interface Entry {
  id: string;
  label: string;
}

function scrollerOf(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
  }
  return document.scrollingElement as HTMLElement;
}

export function Anchors() {
  const host = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [current, setCurrent] = useState<string | null>(null);

  const spy = useCallback(() => {
    const el = host.current;
    const page = el?.parentElement;
    if (!el || !page || !bar.current) return;
    const edge = bar.current.getBoundingClientRect().bottom + 1;
    const sections = [...page.querySelectorAll<HTMLElement>("[data-section][id]")];
    let cur: string | null = null;
    for (const s of sections) {
      if (s.getBoundingClientRect().top <= edge) cur = s.id;
    }
    // Scrolled to the foot, a last section too short to reach the bar is the current one.
    const sc = scrollerOf(el);
    if (sc.scrollTop > 0 && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1) cur = sections[sections.length - 1]?.id ?? cur;
    setCurrent(cur ?? page.querySelector<HTMLElement>("[data-section][id]")?.id ?? null);
  }, []);

  useEffect(() => {
    const el = host.current;
    const page = el?.parentElement;
    if (!el || !page) return;
    const scroller = scrollerOf(el);
    const measure = () => {
      const sections = [...page.querySelectorAll<HTMLElement>("[data-section][id]")];
      // The bar's own height does not count, or mounting it could tip the rule.
      const content = scroller.scrollHeight - (bar.current?.offsetHeight ?? 0);
      const on = sections.length >= MIN_SECTIONS && content > MIN_SCREENS * scroller.clientHeight;
      const next = on ? sections.map((s) => ({ id: s.id, label: s.dataset.section ?? s.id })) : [];
      setEntries((prev) => (prev.length === next.length && prev.every((p, i) => p.id === next[i]?.id && p.label === next[i]?.label) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(page);
    ro.observe(scroller);
    // A section that appears or goes (a panel with data, a feed update) re-counts too.
    const mo = new MutationObserver(measure);
    mo.observe(page, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-section", "id", "hidden"] });
    return () => (ro.disconnect(), mo.disconnect());
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el || !entries.length) return;
    const scroller = scrollerOf(el);
    const target: HTMLElement | Window = scroller === document.scrollingElement ? window : scroller;
    spy();
    target.addEventListener("scroll", spy, { passive: true });
    return () => target.removeEventListener("scroll", spy);
  }, [entries, spy]);

  const jump = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const t = document.getElementById(id);
    if (!t) return;
    e.preventDefault();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    t.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    if (!t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1");
    t.focus({ preventScroll: true });
    history.replaceState(history.state, "", `#${id}`);
    setCurrent(id);
  };

  return (
    <div className="anchor-host" ref={host}>
      {entries.length > 0 && (
        <nav className="anchors" aria-labelledby="anchorsLabel" ref={bar}>
          <span className="anchors-label" id="anchorsLabel">
            On this page
          </span>
          {entries.map((x) => (
            <a key={x.id} href={`#${x.id}`} aria-current={current === x.id ? "location" : undefined} onClick={(e) => jump(e, x.id)}>
              {x.label}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}
