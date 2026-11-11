import type { ReactNode } from "react";
import { Glyph, Status, Pill as CapPill, type GlyphName, type Tone } from "capsomer/react/status";
import type { Kind } from "../lib/derive";

// Capsomer's status shapes (shape, word and color together). Each Portal kind is a tone, and the
// kinds with a mark of their own (queued, unknown, blocked, running) name it (status.md: done is ok,
// run is info running, queued is muted queued, blocked is warn blocked).
const STATE: Record<Kind, { tone: Tone; glyph?: GlyphName; running?: boolean }> = {
  ok: { tone: "ok" },
  done: { tone: "ok" },
  warn: { tone: "warn" },
  blocked: { tone: "warn", glyph: "blocked" },
  crit: { tone: "crit" },
  nodata: { tone: "nodata" },
  unknown: { tone: "muted", glyph: "unknown" },
  queued: { tone: "muted", glyph: "queued" },
  run: { tone: "info", running: true },
};

// The inbox's kinds each have their own mark (Dustin's review of 2026-10-11: every row had the
// same pause icon), Capsomer's glyphs since 0.92.0. The color still says who acts: warning for a
// person, critical for a machine fault.
const INBOX_GLYPHS = new Set<string>(["question", "pr", "report", "proposal", "site-down"]);

/** An inbox kind's own mark, with its word. An unknown kind takes the tone's status shape. */
export function InboxMark({
  kind,
  tone,
  children,
}: {
  kind: string;
  tone: Kind;
  children: ReactNode;
}) {
  if (!INBOX_GLYPHS.has(kind)) return <St kind={tone}>{children}</St>;
  return (
    <Status tone={STATE[tone].tone} glyph={kind as GlyphName}>
      {children}
    </Status>
  );
}

/** A tone's bare glyph, colored by the tone. */
export function Icon({ kind }: { kind: Kind }) {
  const s = STATE[kind];
  return <Glyph name={s.running ? "running" : (s.glyph ?? s.tone)} tone={s.tone} />;
}

// Status text: shape, word and color together, never color alone. `wrap` lets a phrase (a hold
// reason) wrap in its own column, the glyph at its first line.
export function St({ kind, wrap, children }: { kind: Kind; wrap?: boolean; children: ReactNode }) {
  return (
    <Status {...STATE[kind]} wrap={wrap}>
      {children}
    </Status>
  );
}

export function Pill({ kind, children }: { kind: Kind; children: ReactNode }) {
  return <CapPill {...STATE[kind]}>{children}</CapPill>;
}

// No data is a state with a reason. In a panel the reason is written out. In a table cell
// (brief) the cell says two words, and a short reason shows on hover and is read by a
// screen reader; the full sentence is in the row's panel (design D18).
export function NoData({ reason, brief }: { reason: string; brief?: boolean }) {
  return (
    <Status tone="nodata" brief={brief} reason={reason || undefined}>
      No data
    </Status>
  );
}

const NAV_ICONS: Record<string, ReactNode> = {
  needs: (
    <path
      d="M2 4.5h12v7.5H2zM2 4.5l2.5-2.5h7L14 4.5M2 8h3.5l1 1.5h3l1-1.5H14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  ),
  // A globe: every site, and each site's own page.
  sites: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </>
  ),
  // A folder: the projects (namespaces) the work is filed under.
  projects: (
    <path
      d="M1.8 4V12.5h12.4V5.5H7.6L6.2 3.5H1.8z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  ),
  queue: (
    <path d="M2 4h12M2 8h12M2 12h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  ),
  agents: (
    <>
      <circle cx="8" cy="5.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M2.5 14c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </>
  ),
  // A gear: Settings is the menu's last entry (UX audit M4).
  settings: (
    <>
      <path
        d="M14.1 6.7L14.1 9.3L12.3 9.6L12.2 10L13.2 11.3L11.3 13.2L10 12.2L9.6 12.3L9.3 14.1L6.7 14.1L6.4 12.3L6 12.2L4.7 13.2L2.8 11.3L3.8 10L3.7 9.6L1.9 9.3L1.9 6.7L3.7 6.4L3.8 6L2.8 4.7L4.7 2.8L6 3.8L6.4 3.7L6.7 1.9L9.3 1.9L9.6 3.7L10 3.8L11.3 2.8L13.2 4.7L12.2 6L12.3 6.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  // A parcel: published and shared packages (UX audit M6; the collapsed menu showed a
  // blank button without it).
  packages: (
    <path
      d="M8 1.8l5.6 3v6.4L8 14.2l-5.6-3V4.8zM2.4 4.8L8 7.8l5.6-3M8 7.8v6.4M5.2 3.3l5.6 3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  ),
  library: (
    <path
      d="M2.5 2.5h3v11h-3zM6.5 2.5h3v11h-3zM10.5 3.2l2.6-.7 2.4 10.6-2.6.7z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  ),
  activity: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 4.5V8l2.5 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  health: (
    <path
      d="M1.5 8.5h3l1.8-4.5 3.4 8 1.8-3.5h3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  prs: (
    <>
      <circle cx="4" cy="4" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 6v4M6 4h2a4 4 0 0 1 4 4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
};

export function NavIcon({ id, size = 16 }: { id: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {NAV_ICONS[id]}
    </svg>
  );
}
