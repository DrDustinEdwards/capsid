// The code level's drawing (capsid/research/design-system-explorer.md, section 5, "Drawing it"):
// a repo's folders, then the modules in each folder, laid out by dagre at build and written as an
// SVG, so no layout code reaches the browser. Each module box shows its worst CRAP and, once
// mutation has run, its mutation score, as a shape, a word's colour and a number; a module in an
// import cycle wears a dashed ring marked "cycle".
//
// The drawing repeats the table under it for a pointer and the eye. The SVG is hidden from
// assistive technology and its links take no tab stop, so a keyboard or screen reader meets each
// module once, in the table.
import dagre from "@dagrejs/dagre";

import { escapeHtml } from "./pages.mjs";

// The status glyphs at box size: Capsomer's shapes (components/status), drawn in 12 px.
const GLYPH = {
  crit: '<path fill="currentColor" fill-rule="evenodd" d="M5 1h6l4 4v6l-4 4H5l-4-4V5zM7.2 4h1.6v5H7.2zM7.2 10.4h1.6V12H7.2z"/>',
  warn: '<path fill="currentColor" fill-rule="evenodd" d="M8 1.2 15.4 14H.6zM7.3 6h1.4v4H7.3zM7.3 11h1.4v1.4H7.3z"/>',
  ok: '<path fill="currentColor" fill-rule="evenodd" d="M8 1a7 7 0 1 0 0 14A7 7 0 1 0 8 1zM3.9 9l3 3 5.2-5.6-1.4-1.4-3.8 4.2-1.6-1.6z"/>',
  nodata: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 8h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};

// A box is sized from its text before any browser measures it: 13 px text runs about 7.4 px a
// character, with room for the glyph and the padding.
const CHAR = 7.4;
const PAD = 14;
const LINE = 18;

/**
 * @typedef {"crit" | "warn" | "ok" | "nodata"} Tone
 * @typedef {{ id: string, label: string, href: string, lines: Array<{ tone: Tone, text: string }>, sub?: string, cycle?: boolean, current?: boolean }} Box
 * @typedef {{ from: string, to: string, count?: number }} Wire
 */

/**
 * A wire through dagre's points as one smooth curve (Catmull-Rom as cubic Béziers), so wires
 * that share a rank read as separate strands rather than a tangle of corners.
 * @param {Array<{ x: number, y: number }>} pts
 */
function smooth(pts) {
  const f = (/** @type {number} */ n) => n.toFixed(1);
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    d += ` C${f(p1.x + (p2.x - p0.x) / 6)} ${f(p1.y + (p2.y - p0.y) / 6)} ${f(p2.x - (p3.x - p1.x) / 6)} ${f(p2.y - (p3.y - p1.y) / 6)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}

/**
 * One graph as an SVG string: boxes linked to their pages, wires from importer to imported.
 * @param {{ id: string, title: string, boxes: Box[], wires: Wire[] }} graph
 */
export function graphSvg({ id, title, boxes, wires }) {
  const g = new dagre.graphlib.Graph({ multigraph: false });
  g.setGraph({ rankdir: "TB", nodesep: 24, ranksep: 44, marginx: 12, marginy: 22 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const b of boxes) {
    const chars = Math.max(b.label.length, (b.sub ?? "").length * 0.9, ...b.lines.map((l) => l.text.length + 3));
    g.setNode(b.id, { width: Math.ceil(chars * CHAR + PAD * 2), height: PAD * 2 + LINE * (1 + b.lines.length + (b.sub ? 1 : 0)) - 4 });
  }
  const ids = new Set(boxes.map((b) => b.id));
  for (const w of wires) if (ids.has(w.from) && ids.has(w.to) && w.from !== w.to) g.setEdge(w.from, w.to);
  dagre.layout(g);
  const { width = 0, height = 0 } = g.graph();

  const edges = g.edges().map((e) => `<path class="code-graph-wire" d="${smooth(g.edge(e).points)}" marker-end="url(#${id}-arrow)"/>`);
  const nodes = boxes.map((b) => {
    const n = g.node(b.id);
    const x = n.x - n.width / 2;
    const y = n.y - n.height / 2;
    const text = b.lines
      .map((line, i) => {
        const ty = y + PAD + LINE * (i + 1) + 9;
        return `<g class="code-graph-status" data-tone="${line.tone}"><svg x="${(x + PAD).toFixed(1)}" y="${(ty - 11).toFixed(1)}" width="12" height="12" viewBox="0 0 16 16">${GLYPH[line.tone]}</svg><text x="${(x + PAD + 17).toFixed(1)}" y="${ty.toFixed(1)}">${escapeHtml(line.text)}</text></g>`;
      })
      .join("");
    const sub = b.sub ? `<text class="code-graph-sub" x="${(x + PAD).toFixed(1)}" y="${(y + PAD + LINE + 9).toFixed(1)}">${escapeHtml(b.sub)}</text>` : "";
    return `<a href="${escapeHtml(b.href)}" tabindex="-1"><g class="code-graph-box" data-tone="${b.lines[0]?.tone ?? "nodata"}"${b.cycle ? " data-cycle" : ""}${b.current ? " data-current" : ""}>${
      b.cycle ? `<rect class="code-graph-ring" x="${(x - 5).toFixed(1)}" y="${(y - 5).toFixed(1)}" width="${(n.width + 10).toFixed(1)}" height="${(n.height + 10).toFixed(1)}" rx="10"/>` : ""
    }<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${n.width}" height="${n.height}" rx="6"/><text class="code-graph-name" x="${(x + PAD).toFixed(1)}" y="${(y + PAD + 9).toFixed(1)}">${escapeHtml(b.label)}</text>${sub}${text}${
      b.cycle ? `<text class="code-graph-cycle" x="${(x + n.width - 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="end">cycle</text>` : ""
    }</g></a>`;
  });
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  // On a phone the drawing keeps its own size and scrolls in a box a keyboard can reach, rather
  // than shrinking past reading.
  return `<figure class="code-graph"><figcaption id="${id}-caption">${escapeHtml(title)}</figcaption><div class="scroller" role="region" aria-labelledby="${id}-caption" tabindex="0"><svg class="code-graph-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false"><defs><marker id="${id}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="code-graph-head"/></marker></defs>${edges.join("")}${nodes.join("")}</svg></div></figure>`;
}
