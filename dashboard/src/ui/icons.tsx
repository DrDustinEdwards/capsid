import type { CSSProperties, ReactNode } from "react";
import type { Kind } from "../lib/derive";

function S({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={style}>
      {children}
    </svg>
  );
}

const SHAPES: Record<Kind, ReactNode> = {
  ok: (
    <>
      <circle cx="7" cy="7" r="6.2" fill="currentColor" opacity=".16" />
      <path d="M4 7.2 6.1 9.3 10 4.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  warn: (
    <>
      <path d="M7 1.4 13 12.2H1z" fill="currentColor" opacity=".18" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M7 5.2v3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7" cy="10.2" r=".85" fill="currentColor" />
    </>
  ),
  crit: (
    <>
      <path d="M4.4 1h5.2L13 4.4v5.2L9.6 13H4.4L1 9.6V4.4z" fill="currentColor" />
      <path d="M5 5l4 4M9 5 5 9" stroke="var(--surface)" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  nodata: (
    <>
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.2 2" />
      <path d="M4.5 7h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  queued: <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  run: (
    <>
      <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".3" />
      <path d="M7 1.4A5.6 5.6 0 0 1 12.6 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </>
  ),
  blocked: (
    <>
      <rect x="1.2" y="1.2" width="11.6" height="11.6" rx="3" fill="currentColor" opacity=".18" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.3 4.4v5.2M8.7 4.4v5.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  done: (
    <>
      <circle cx="7" cy="7" r="6.2" fill="currentColor" />
      <path d="M4 7.2 6.1 9.3 10 4.9" fill="none" stroke="var(--surface)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

// The inbox's kinds each get their own mark (Dustin's review of 2026-10-11: every row had the
// same pause icon). The colour still says who acts: warning for a person, critical for a
// machine fault.
const INBOX_SHAPES: Record<string, ReactNode> = {
  "blocked-job": SHAPES.blocked,
  question: (
    <>
      <circle cx="7" cy="7" r="6" fill="currentColor" opacity=".18" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.3 5.4a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="7" cy="10.4" r=".8" fill="currentColor" />
    </>
  ),
  pr: (
    <>
      <circle cx="3.8" cy="3" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3.8" cy="11" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10.2" cy="11" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.8 4.6v4.8M10.2 9.4V6.2A2.2 2.2 0 0 0 8 4H6.4M7.6 2.6 6.2 4l1.4 1.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  report: (
    <>
      <path d="M3 13V1.8M3 2.2h7.6l-1.6 2.6 1.6 2.6H3" fill="currentColor" fillOpacity=".18" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
    </>
  ),
  proposal: (
    <>
      <path d="M3 1.5h5.5L11 4v8.5H3z" fill="currentColor" fillOpacity=".18" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5 7h4M5 9.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  ),
  ci: SHAPES.crit,
  "site-down": (
    <>
      <circle cx="7" cy="7" r="6.2" fill="currentColor" />
      <path d="M7 3.6v5.6M4.6 6.9 7 9.3l2.4-2.4" fill="none" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

/** An inbox kind's own mark, with its word. An unknown kind takes the tone's status shape. */
export function InboxMark({ kind, tone, children }: { kind: string; tone: Kind; children: ReactNode }) {
  return (
    <span className={`st ${tone}`}>
      <S>{INBOX_SHAPES[kind] ?? SHAPES[tone]}</S>
      {children}
    </span>
  );
}

export function Icon({ kind, style }: { kind: Kind; style?: CSSProperties }) {
  return <S style={style}>{SHAPES[kind]}</S>;
}

// Status text: shape, word and colour together, never colour alone.
export function St({ kind, children }: { kind: Kind; children: ReactNode }) {
  const cls = kind === "done" ? "ok" : kind;
  return (
    <span className={`st ${cls}`}>
      <Icon kind={kind} />
      {children}
    </span>
  );
}

export function Pill({ kind, children }: { kind: Kind; children: ReactNode }) {
  const cls = kind === "queued" ? "nodata" : kind === "blocked" ? "warn" : kind === "done" ? "ok" : kind;
  return (
    <span className={`pill ${cls}`}>
      <Icon kind={kind} />
      {children}
    </span>
  );
}

// No data is a state with a reason. In a panel the reason is written out. In a table cell
// (brief) the cell says two words, and a short reason shows on hover and is read by a
// screen reader; the full sentence is in the row's panel (design D18).
export function NoData({ reason, brief }: { reason: string; brief?: boolean }) {
  if (brief)
    return (
      <span className="st nodata" data-tip={reason || undefined}>
        <Icon kind="nodata" />
        No data
        {reason && <span className="sr-only">: {reason}</span>}
      </span>
    );
  return (
    <span className="nodata-cell">
      <St kind="nodata">No data</St>
      <span className="src">{reason}</span>
    </span>
  );
}

const NAV_ICONS: Record<string, ReactNode> = {
  needs: <path d="M2 4.5h12v7.5H2zM2 4.5l2.5-2.5h7L14 4.5M2 8h3.5l1 1.5h3l1-1.5H14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />,
  shared: <path d="M5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM5 12.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM14 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM3.5 5v6M5 4l6 3.3M5 12l6-3.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />,
  queue: <path d="M2 4h12M2 8h12M2 12h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />,
  agents: (
    <>
      <circle cx="8" cy="5.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 14c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  // A gear: Settings is the menu's last entry (UX audit M4).
  settings: (
    <>
      <path d="M14.1 6.7L14.1 9.3L12.3 9.6L12.2 10L13.2 11.3L11.3 13.2L10 12.2L9.6 12.3L9.3 14.1L6.7 14.1L6.4 12.3L6 12.2L4.7 13.2L2.8 11.3L3.8 10L3.7 9.6L1.9 9.3L1.9 6.7L3.7 6.4L3.8 6L2.8 4.7L4.7 2.8L6 3.8L6.4 3.7L6.7 1.9L9.3 1.9L9.6 3.7L10 3.8L11.3 2.8L13.2 4.7L12.2 6L12.3 6.4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  // A parcel: published and shared packages (UX audit M6; the collapsed menu showed a
  // blank button without it).
  packages: <path d="M8 1.8l5.6 3v6.4L8 14.2l-5.6-3V4.8zM2.4 4.8L8 7.8l5.6-3M8 7.8v6.4M5.2 3.3l5.6 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />,
  library: <path d="M2.5 2.5h3v11h-3zM6.5 2.5h3v11h-3zM10.5 3.2l2.6-.7 2.4 10.6-2.6.7z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />,
  activity: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  health: <path d="M1.5 8.5h3l1.8-4.5 3.4 8 1.8-3.5h3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
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
