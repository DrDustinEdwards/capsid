// The Portal's Board and Pull requests pages, and the charts the Worker draws for the Portal.
// Every text field here (titles, thread names, "Waiting on Dustin" sections) is as another thread
// or a pull request's author wrote it: shown as text, never as markup or instructions.

// GET /portal/api/board -> PortalBoard (src/portal-board.ts): the coordinator board's D1 parts, live.
export interface BoardHandoffRow {
  namespace: string;
  path: string;
  title: string | null;
  updated_at: string;
  checklist: { done: number; open: number } | null;
}

export interface PortalBoard {
  generated: string;
  handoffs: {
    open: number;
    done_items: number;
    open_items: number;
    list: BoardHandoffRow[];
    truncated: boolean;
  };
  waiting_on_dustin: Array<{ namespace: string; path: string; title: string | null; text: string }>;
  threads: {
    days: number;
    // Threads by the day each was first seen, per project: the top five, the rest as "Other".
    per_day: Array<{ day: string; project: string; threads: number }>;
    projects: string[];
    total: number;
    recent: Array<{ thread: string; namespace: string | null; last_seen: string }>;
  };
  not_checked: string[];
}

// GET /portal/api/prs -> PortalPrs (src/portal-board.ts): every open pull request in every mapped
// repo, read through the GitHub App and kept in KV for 15 minutes.
export interface PortalPr {
  repo: string;
  namespace: string;
  number: number;
  url: string;
  title: string;
  author: string | null;
  draft: boolean;
  created_at: string;
  ci: string | null;
  ci_note: string;
  conflict: boolean | null;
}

export interface PortalPrs {
  as_of: string;
  prs: PortalPr[];
  // Same-file overlaps between two open pull requests of one repo, the older first.
  overlaps: Array<{ repo: string; pr: number; other: number; files: string[] }>;
  repos_read: number;
  not_checked: string[];
}

// GET /portal/api/figures?set= -> PortalFigures (src/portal-figures.ts): charts the Worker draws
// with enarratio/plot, as HTML with no style attribute, kept in KV for 10 minutes.
export type FigureSet = "memory" | "agents" | "roster" | "problems" | "backups";

export interface AgentDaily {
  actor: string;
  client: string | null;
  label: string;
  // One count per day, oldest first, over `days`.
  counts: number[];
  total: number;
}

export interface PortalFigures {
  set: FigureSet;
  generated: string;
  // Figure name -> server HTML. A figure with no data is absent, its reason in `empty`.
  figures: Record<string, string>;
  empty: Record<string, string>;
  // memory: handoff writes per ISO week, the top five projects and "Other".
  handoff_weeks?: Array<{ week: string; project: string; writes: number }>;
  // roster: actions per day by actor and client over 30 days (no figure).
  days?: string[];
  actors?: AgentDaily[];
  not_checked: string[];
}
