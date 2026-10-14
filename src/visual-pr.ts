// VISUAL PULL REQUESTS (job_0368576da167; Dustin, 2026-10-14: "i still want to see them
// first, but you need to notify and then provide a way for me to see them. that will be
// true for all sites/repos."). A pull request labelled `visual` waits for Dustin's yes on
// every roster repo. The auto-merge tick holds it for him (src/auto-merge-tick.ts), reads
// what he needs to look at from the pull request itself, and the phone alert
// (src/push.ts), the inbox (src/inbox.ts) and the Portal's Pull requests page carry it.
// His Approve in the Portal merges it on green CI through the approval executor, as any
// approved pull request.

const VISUAL_LABEL = "visual";
const MAX_SHOTS = 12;

/** What Dustin needs to look at a visual change: its title, a live preview when the
 *  pull request names one, and the screenshots in its description. */
export interface VisualPr {
  title: string;
  preview: string | null;
  shots: string[];
}

/** Whether a pull request carries the visual label. */
export function isVisual(pr: { labels?: ReadonlyArray<{ name?: string } | string> | null }): boolean {
  return (pr.labels ?? []).some((l) => (typeof l === "string" ? l : l.name ?? "").toLowerCase() === VISUAL_LABEL);
}

const URL_RE = /https:\/\/[^\s)<>"'\]]+/g;
// Hosts that serve a pull request's own build: Cloudflare Worker and Pages previews.
const PREVIEW_HOST = /^https:\/\/[^/]*\.(workers\.dev|pages\.dev)(\/|$)/i;

/** The live preview a pull request names: a URL on a line that says "preview", else the
 *  first Worker or Pages preview URL in its description. Images are never previews. */
export function previewUrl(body: string): string | null {
  const urls = (line: string) => [...line.matchAll(URL_RE)].map((m) => m[0]).filter((u) => !isImage(u));
  for (const line of body.split("\n")) {
    if (/preview/i.test(line) && !/!\[/.test(line)) {
      const [u] = urls(line);
      if (u) return u;
    }
  }
  return urls(body).find((u) => PREVIEW_HOST.test(u)) ?? null;
}

function isImage(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(url) || /user-attachments\/assets\//i.test(url);
}

/** The screenshots in a pull request's description: markdown images and <img> tags, in
 *  order, each once, at most MAX_SHOTS. */
export function screenshotUrls(body: string): string[] {
  const found: string[] = [];
  for (const m of body.matchAll(/!\[[^\]]*\]\((https:\/\/[^\s)]+)\)|<img\b[^>]*\bsrc=["'](https:\/\/[^"']+)["']/gi)) {
    const url = m[1] ?? m[2];
    if (url && !found.includes(url)) found.push(url);
  }
  return found.slice(0, MAX_SHOTS);
}

/** Everything the notice carries, read from the pull request. */
export function visualDetails(pr: { title?: string | null; body?: string | null }): VisualPr {
  const body = pr.body ?? "";
  return { title: (pr.title ?? "").trim() || "(no title)", preview: previewUrl(body), shots: screenshotUrls(body) };
}
