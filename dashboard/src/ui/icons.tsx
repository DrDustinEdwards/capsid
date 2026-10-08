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
  overview: <path d="M2 2h5v6H2zM9 2h5v3H9zM9 7h5v7H9zM2 10h5v4H2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />,
  sites: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </>
  ),
  incidents: (
    <>
      <path d="M8 1.8 14.5 13H1.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 6v3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  queue: <path d="M2 4h12M2 8h12M2 12h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />,
  deploys: <path d="M8 14V3M4 7l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
  agents: (
    <>
      <circle cx="8" cy="5.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 14c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  backups: (
    <>
      <ellipse cx="8" cy="4" rx="5.5" ry="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  ci: (
    <>
      <circle cx="4" cy="4" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 6v4M6 4h2a4 4 0 0 1 4 4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  settings: (
    <>
      <path d="M2 4h1.4M6.6 4H14M2 8h7.4M12.6 8H14M2 12h3.4M8.6 12H14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="5" cy="4" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11" cy="8" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7" cy="12" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  namespaces: <path d="M2 3h5v4H2zM9 3h5v4H9zM2 9h5v4H2zM9 9h5v4H9z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />,
  activity: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  claims: (
    <>
      <path d="M2 3h5v10H2zM9 3h5v10H9z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M3.5 8.2l1 1 1.8-2.2M10.5 6.5l2 2M12.5 6.5l-2 2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
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

export function BrandMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <polygon points="12,1.8 21.4,7.2 21.4,16.8 12,22.2 2.6,16.8 2.6,7.2" fill="none" stroke="var(--accent)" strokeWidth="1.6" />
      <polyline points="12,1.8 12,8.4 21.4,7.2 M12,8.4 2.6,7.2" fill="none" stroke="var(--accent)" strokeWidth="1.1" />
      <polygon points="12,8.4 17.2,14.6 6.8,14.6" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1.1" />
      <polyline points="6.8,14.6 2.6,16.8 M17.2,14.6 21.4,16.8 M6.8,14.6 12,22.2 17.2,14.6" fill="none" stroke="var(--accent)" strokeWidth="1.1" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ThemeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5a6.5 6.5 0 1 0 0 13z" fill="currentColor" />
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
