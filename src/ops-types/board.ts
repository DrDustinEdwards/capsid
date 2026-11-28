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
    per_day: Array<{ day: string; project: string; threads: number }>;
    projects: string[];
    total: number;
    recent: Array<{ thread: string; namespace: string | null; last_seen: string }>;
  };
  not_checked: string[];
}

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
  overlaps: Array<{ repo: string; pr: number; other: number; files: string[] }>;
  repos_read: number;
  not_checked: string[];
}

export type FigureSet = "memory" | "agents" | "roster";

export interface AgentDaily {
  actor: string;
  client: string | null;
  label: string;
  counts: number[];
  total: number;
}

export interface PortalFigures {
  set: FigureSet;
  generated: string;
  figures: Record<string, string>;
  empty: Record<string, string>;
  handoff_weeks?: Array<{ week: string; project: string; writes: number }>;
  days?: string[];
  actors?: AgentDaily[];
  not_checked: string[];
}
