import type { ReactNode } from "react";
import {
  Icon as CapIcon,
  iconBook,
  iconClock,
  iconFolder,
  iconPeople,
  iconQueue,
  iconSettings,
} from "capsomer/react/icons";
import type { Kind } from "../lib/derive";

// No style attribute: the Portal's CSP refuses inline styles in the server's HTML (a status
// icon lost its color on /demos/health, 2026-11-03). A tone is a class (styles.css, .tone-*).
function S({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className={className}>
      {children}
    </svg>
  );
}

const SHAPES: Record<Kind, ReactNode> = {
  ok: (
    <>
      <circle cx="7" cy="7" r="6.2" fill="currentColor" opacity=".16" />
      <path
        d="M4 7.2 6.1 9.3 10 4.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  warn: (
    <>
      <path
        d="M7 1.4 13 12.2H1z"
        fill="currentColor"
        opacity=".18"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
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
      <circle
        cx="7"
        cy="7"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray="2.2 2"
      />
      <path d="M4.5 7h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  // Could not be measured: a question mark, so it never reads as a pass, a failure or "does not apply".
  unknown: (
    <>
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5.2 5.4a1.9 1.9 0 1 1 2.6 1.7c-.5.3-.8.6-.8 1.2v.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="7" cy="10.3" r=".85" fill="currentColor" />
    </>
  ),
  queued: <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  run: (
    <>
      <circle
        cx="7"
        cy="7"
        r="5.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity=".3"
      />
      <path
        d="M7 1.4A5.6 5.6 0 0 1 12.6 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </>
  ),
  blocked: (
    <>
      <rect
        x="1.2"
        y="1.2"
        width="11.6"
        height="11.6"
        rx="3"
        fill="currentColor"
        opacity=".18"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M5.3 4.4v5.2M8.7 4.4v5.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </>
  ),
  done: (
    <>
      <circle cx="7" cy="7" r="6.2" fill="currentColor" />
      <path
        d="M4 7.2 6.1 9.3 10 4.9"
        fill="none"
        stroke="var(--surface)"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
};

// The inbox's kinds each get their own mark (Dustin's review of 2026-10-11: every row had the
// same pause icon). The color still says who acts: warning for a person, critical for a
// machine fault.
const INBOX_SHAPES: Record<string, ReactNode> = {
  "blocked-job": SHAPES.blocked,
  question: (
    <>
      <circle
        cx="7"
        cy="7"
        r="6"
        fill="currentColor"
        opacity=".18"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M5.3 5.4a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="7" cy="10.4" r=".8" fill="currentColor" />
    </>
  ),
  pr: (
    <>
      <circle cx="3.8" cy="3" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3.8" cy="11" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10.2" cy="11" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M3.8 4.6v4.8M10.2 9.4V6.2A2.2 2.2 0 0 0 8 4H6.4M7.6 2.6 6.2 4l1.4 1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  report: (
    <>
      <path
        d="M3 13V1.8M3 2.2h7.6l-1.6 2.6 1.6 2.6H3"
        fill="currentColor"
        fillOpacity=".18"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </>
  ),
  proposal: (
    <>
      <path
        d="M3 1.5h5.5L11 4v8.5H3z"
        fill="currentColor"
        fillOpacity=".18"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M5 7h4M5 9.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  ),
  ci: SHAPES.crit,
  "site-down": (
    <>
      <circle cx="7" cy="7" r="6.2" fill="currentColor" />
      <path
        d="M7 3.6v5.6M4.6 6.9 7 9.3l2.4-2.4"
        fill="none"
        stroke="var(--surface)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
};

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
  return (
    <span className={`st ${tone}`}>
      <S>{INBOX_SHAPES[kind] ?? SHAPES[tone]}</S>
      {children}
    </span>
  );
}

export function Icon({ kind, tone }: { kind: Kind; tone?: boolean }) {
  return <S className={tone ? `tone-${kind}` : undefined}>{SHAPES[kind]}</S>;
}

// Status text: shape, word and color together, never color alone.
export function St({ kind, children }: { kind: Kind; children: ReactNode }) {
  const cls = kind === "done" ? "ok" : kind;
  return (
    <span className={`st ${cls}`}>
      <Icon kind={kind} />
      {children}
    </span>
  );
}

const PILL_TONE: Partial<Record<Kind, string>> = {
  queued: "nodata",
  blocked: "warn",
  done: "ok",
  run: "info",
  unknown: "muted",
};

export function Pill({ kind, children }: { kind: Kind; children: ReactNode }) {
  // Capsomer's badge tones: run is its notice tone, and a state that is neither good nor bad is muted.
  const tone = PILL_TONE[kind] ?? kind;
  return (
    <span className="cap-pill" data-tone={tone}>
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
        {reason && <span className="cap-sr-only">: {reason}</span>}
      </span>
    );
  return (
    <span className="nodata-cell">
      <St kind="nodata">No data</St>
      <span className="src">{reason}</span>
    </span>
  );
}

// The menu's icons: the shared set where it has the drawing, the Portal's own 16-unit drawings where
// it does not (Jobs, Sites, Pull requests, Packages, Health).
const NAV_ICONS: Record<string, { d: string; box?: number }> = {
  needs: { d: iconQueue },
  sites: {
    d: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2z",
    box: 16,
  },
  projects: { d: iconFolder },
  queue: { d: "M2 4h12M2 8h12M2 12h7", box: 16 },
  agents: { d: iconPeople },
  settings: { d: iconSettings },
  packages: {
    d: "M8 1.8l5.6 3v6.4L8 14.2l-5.6-3V4.8zM2.4 4.8L8 7.8l5.6-3M8 7.8v6.4M5.2 3.3l5.6 3",
    box: 16,
  },
  library: { d: iconBook },
  activity: { d: iconClock },
  health: { d: "M1.5 8.5h3l1.8-4.5 3.4 8 1.8-3.5h3", box: 16 },
  prs: {
    d: "M4 2a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM4 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM12 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM4 6v4M6 4h2a4 4 0 0 1 4 4",
    box: 16,
  },
};

export function NavIcon({ id, size = 16 }: { id: string; size?: number }) {
  const icon = NAV_ICONS[id];
  if (!icon) return null;
  return <CapIcon {...icon} className={size > 16 ? "navicon navicon-lg" : "navicon"} />;
}
