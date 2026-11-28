// Dev and tests only: the Board's, Pull requests' and the server charts' answers (src/portal-board.ts,
// src/portal-figures.ts) in sample names, on the mock's clock. The charts are drawn by the Worker's own
// code (src/figures.ts) with enarratio/plot, so the page shows what the Worker would send. The quiet
// cookie (wf-mock=quiet) answers the empty states: no handoff, no thread, the pull requests not yet read.

import * as plot from "enarratio/plot";
import { backupAges, findingsRange, whoActed, writesCalendar } from "../../src/figures.ts";
import type {
  FigureSet,
  LibraryHandoff,
  PortalBackups,
  PortalBoard,
  PortalFigures,
  PortalPrs,
} from "../src/types.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();
const sql = (t: number) => iso(t).slice(0, 19).replace("T", " ");
const dayOf = (t: number) => iso(t).slice(0, 10);
const daysBack = (now: number, n: number) =>
  Array.from({ length: n }, (_, i) => dayOf(now - (n - 1 - i) * DAY));

const HANDOFFS = [
  {
    ns: "sample",
    path: "handoff/portal-layout.md",
    title: "Portal layout pass",
    h: 2,
    done: 3,
    open: 4,
  },
  {
    ns: "sample-b",
    path: "handoff/search-index.md",
    title: "Search index rebuild",
    h: 20,
    done: 6,
    open: 1,
  },
  { ns: "sample", path: "handoff/feed-cache.md", title: "Feed cache", h: 30, done: 2, open: 2 },
  {
    ns: "sample-c",
    path: "handoff/backup-drill.md",
    title: "Quarterly backup drill",
    h: 50,
    done: 0,
    open: 3,
  },
  {
    ns: "sample-d",
    path: "handoff/notes.md",
    title: "Notes on the type scale",
    h: 75,
    done: 0,
    open: 0,
  },
  {
    ns: "sample-b",
    path: "handoff/old-theme.md",
    title: "Old theme cleanup",
    h: 24 * 20,
    done: 5,
    open: 0,
  },
] as const;

export function mockHandoffDocs(now: number): LibraryHandoff[] {
  return HANDOFFS.map((h) => ({
    namespace: h.ns,
    path: h.path,
    title: h.title,
    type: "episodic",
    status: "published",
    updated_at: sql(now - h.h * HOUR),
    open: h.h < 14 * 24,
  }));
}

const PROJECTS = ["sample", "sample-b", "sample-c", "sample-d", "sample-e", "sample-f", "sample-g"];

function mockBoard(now: number, quiet: boolean): PortalBoard {
  const open = quiet ? [] : HANDOFFS.filter((h) => h.h < 14 * 24);
  const days = daysBack(now, 21);
  const per_day = quiet
    ? []
    : days.flatMap((day, i) =>
        ["sample", "sample-b", "sample-c", "sample-d", "sample-e", "Other"].map((project, k) => ({
          day,
          project,
          threads: (i * 7 + k * 3) % (6 - Math.min(k, 4)),
        })),
      );
  return {
    generated: iso(now),
    handoffs: {
      open: open.length,
      done_items: open.reduce((n, h) => n + h.done, 0),
      open_items: open.reduce((n, h) => n + h.open, 0),
      list: open.map((h) => ({
        namespace: h.ns,
        path: h.path,
        title: h.title,
        updated_at: sql(now - h.h * HOUR),
        checklist: h.done + h.open ? { done: h.done, open: h.open } : null,
      })),
      truncated: false,
    },
    waiting_on_dustin: quiet
      ? []
      : [
          {
            namespace: "sample",
            path: "handoff/portal-layout.md",
            title: "Portal layout pass",
            text: "- Pick the card width for phones: full width or inset.\n- Approve the new tab order.",
          },
          {
            namespace: "sample-c",
            path: "handoff/backup-drill.md",
            title: "Quarterly backup drill",
            text: "Run the drill by hand against the real database (docs/backups.md).",
          },
        ],
    threads: {
      days: 21,
      per_day,
      projects: quiet ? [] : ["sample", "sample-b", "sample-c", "sample-d", "sample-e", "Other"],
      total: per_day.reduce((n, r) => n + r.threads, 0),
      recent: quiet
        ? []
        : Array.from({ length: 10 }, (_, i) => ({
            thread:
              [
                "Portal layout pass",
                "Search index rebuild",
                "Feed cache",
                "Fix the sitemap",
                "Type scale notes",
              ][i % 5]! + (i >= 5 ? " (2)" : ""),
            namespace: PROJECTS[i % PROJECTS.length]!,
            last_seen: sql(now - (i * 2 + 1) * HOUR),
          })),
    },
    not_checked: [],
  };
}

function mockPrs(now: number): PortalPrs {
  const pr = (
    repo: string,
    number: number,
    title: string,
    ageDays: number,
    over: Partial<PortalPrs["prs"][number]> = {},
  ) => ({
    repo: `example-org/${repo}`,
    namespace: repo,
    number,
    url: `https://github.com/example-org/${repo}/pull/${number}`,
    title,
    author: "sample-bot",
    draft: false,
    created_at: iso(now - ageDays * DAY),
    ci: "success",
    ci_note: "every check passed",
    conflict: false,
    ...over,
  });
  return {
    as_of: iso(now - 6 * 60_000),
    prs: [
      pr("sample", 41, "Tighten the card grid on phones", 2.1),
      pr("sample", 43, "Move the tab bar under the header", 0.4, {
        ci: "failure",
        ci_note: "test failed",
      }),
      pr("sample", 44, "Card grid: dark mode borders", 0.2),
      pr("sample-b", 12, "Rebuild the search index nightly", 6, { conflict: true }),
      pr("sample-c", 7, "Draft: backup drill notes", 9, {
        draft: true,
        ci: null,
        ci_note: "no checks",
      }),
    ],
    overlaps: [{ repo: "example-org/sample", pr: 41, other: 44, files: ["src/cards.css"] }],
    repos_read: 5,
    not_checked: [],
  };
}

function mockFigures(set: FigureSet, now: number): PortalFigures {
  const base: PortalFigures = { set, generated: iso(now), figures: {}, empty: {}, not_checked: [] };
  const today = new Date(now);
  if (set === "memory") {
    const days = daysBack(now, 365);
    const counts = new Map(
      days.map((d, i) => [d, i % 7 === 5 || i % 7 === 6 ? i % 3 : 4 + ((i * 17) % 40)]),
    );
    const weeks = Array.from({ length: 12 }, (_, i) => `2026-W${String(37 + i).padStart(2, "0")}`);
    return {
      ...base,
      figures: { writes: writesCalendar(plot, days, counts)! },
      handoff_weeks: weeks.flatMap((week, i) =>
        ["sample", "sample-b", "sample-c", "Other"].map((project, k) => ({
          week,
          project,
          writes: ((i + 3) * (k + 2) * 7) % 41,
        })),
      ),
    };
  }
  if (set === "agents" || set === "roster") {
    const days = daysBack(now, 30);
    const who: Array<[string, string | null, number]> = [
      ["system:reviewer", null, 210],
      ["access:admin@example.com", "Claude", 48],
      ["access:admin@example.com", null, 47],
      ["agent:watcher", null, 27],
      ["capsid:push", null, 17],
      ["agent:sample-driver", null, 8],
      ["agent:sample-b-driver", null, 3],
      ["agent:reviewer", null, 2],
    ];
    const actors = who.map(([actor, client, n], k) => {
      const counts = days.map((_, i) =>
        Math.max(0, Math.round(n * (0.5 + (((i + k) * 7) % 10) / 10))),
      );
      const label = actor.startsWith("access:")
        ? client
          ? "Project threads"
          : "You (Portal)"
        : actor.startsWith("agent:")
          ? actor.slice(6)
          : `${actor.split(":")[1]} (${actor.split(":")[0]})`;
      return { actor, client, label, counts, total: counts.reduce((a, b) => a + b, 0) };
    });
    if (set === "roster") return { ...base, days, actors };
    return {
      ...base,
      figures: {
        who_acted: whoActed(plot, days, actors, "day")!,
        who_acted_weeks: whoActed(plot, days, actors, "week")!,
      },
    };
  }
  if (set === "problems") {
    const findings = [
      { namespace: "sample", title: "The sitemap answered 500", d: 9, l: 0.1 },
      { namespace: "sample-b", title: "TLS certificate expires in 12 days", d: 4, l: 0.2 },
      { namespace: "sample-c", title: "Search Console reports 3 new 404s", d: 1.5, l: 0.6 },
    ];
    return {
      ...base,
      figures: {
        open: findingsRange(
          plot,
          findings.map((f) => ({
            namespace: f.namespace,
            title: f.title,
            first_seen_at: iso(now - f.d * DAY),
            last_seen_at: iso(now - f.l * DAY),
          })),
          today,
        )!,
      },
    };
  }
  const b: PortalBackups = {
    read_at: iso(now),
    capsid: {
      status: { last_ok: iso(now - 9 * HOUR), age_hours: 9 },
      amazon: { newest: iso(now - 7 * HOUR), bytes: 1 },
    },
    sites: [
      {
        namespace: "sample",
        origin: "https://sample.example.com",
        status: { last_ok: iso(now - 14 * HOUR), age_hours: 14 },
        error: null,
        amazon: { newest: iso(now - 13 * HOUR), bytes: 1 },
      },
      {
        namespace: "sample-b",
        origin: "https://b.example.com",
        status: { last_ok: iso(now - 31 * HOUR), age_hours: 31 },
        error: null,
        amazon: { newest: iso(now - 33 * HOUR), bytes: 1 },
      },
      {
        namespace: "sample-c",
        origin: "https://c.example.com",
        status: null,
        error: "unreachable",
        amazon: null,
      },
    ],
    amazon_report_at: iso(now - 2 * HOUR),
    not_configured: [],
  };
  const dump = backupAges(plot, b, "dump", today);
  const amazon = backupAges(plot, b, "amazon", today);
  return {
    ...base,
    figures: { dump: dump.chart!, amazon: amazon.chart! },
    not_checked: [
      `no backup age for ${dump.missing.join(", ")}`,
      `no Amazon copy for ${amazon.missing.join(", ")}`,
    ],
  };
}

const SETS: readonly FigureSet[] = ["memory", "agents", "roster", "problems", "backups"];

export function mockBoardRoute(
  path: string,
  url: URL,
  now: number,
  quiet: boolean,
): { status: number; body: unknown } {
  if (path === "/portal/api/board") return { status: 200, body: mockBoard(now, quiet) };
  if (path === "/portal/api/prs")
    return quiet
      ? { status: 503, body: { error: "The pull requests have not been read yet." } }
      : { status: 200, body: mockPrs(now) };
  const set = url.searchParams.get("set") as FigureSet | null;
  if (!set || !SETS.includes(set))
    return { status: 400, body: { error: `set must be one of ${SETS.join(", ")}.` } };
  return { status: 200, body: mockFigures(set, now) };
}
