import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Spinner } from "capsomer/react/empty";
import { AdminShell, type AdminEntry } from "capsomer/react/admin-shell";
import { Link, useLocation, useSearch } from "wouter";
import { APP_URL, POLL_MS, requestRefresh, runAction, signOutRequest, useOpsFeed } from "../lib/api";
import { WAITING_KINDS, attentionItems, counts, hasSites, passStale } from "../lib/derive";
import { ago, ms, portalNow, utc } from "../lib/format";
import { RAIL_PREF, THEME_PREF, readPref, toggleTheme, useSingleKeys, writePref } from "../lib/prefs";
import { register, setSheetOpener } from "capsomer/behavior/shortcuts";
import { NavIcon } from "../ui/icons";
import { FreshRing } from "../ui/charts";
import { AppCtx, MOVED, VIEWS, parseRoute, placePath, routePath, type ConfirmRequest, type Ctx, type Filters, type UndoRequest, type ViewId } from "./ctx";
import type { OpsFeed, PortalPerformed } from "../types";
import { lasting, withMessage, type Message } from "../lib/messages";

// Every view loads on first visit. Needs you, the home, is asked for as this module loads,
// so its chunk arrives beside the first feed read rather than after it (the feed is what
// the page waits for), and the entry stays inside its size budget.
const needsChunk = import("../views/NeedsYou");
const VIEW_COMPONENTS: Record<ViewId, ComponentType> = {
  needs: lazy(() => needsChunk.then((m) => ({ default: m.NeedsYou }))),
  queue: lazy(() => import("../views/Queue").then((m) => ({ default: m.Queue }))),
  prs: lazy(() => import("../views/Ci").then((m) => ({ default: m.PullRequests }))),
  health: lazy(() => import("../views/Health").then((m) => ({ default: m.Health }))),
  activity: lazy(() => import("../views/Activity").then((m) => ({ default: m.Activity }))),
  agents: lazy(() => import("../views/Agents").then((m) => ({ default: m.Agents }))),
  packages: lazy(() => import("../views/Packages").then((m) => ({ default: m.Packages }))),
  library: lazy(() => import("../views/Library").then((m) => ({ default: m.Library }))),
  settings: lazy(() => import("../views/Settings").then((m) => ({ default: m.Settings }))),
};

// Loaded the first time a panel opens or Ctrl K is pressed, then kept, so the initial bundle
// carries neither (the size budget, after Capsomer 0.9.0's header joined the entry).
const Drawer = lazy(() => import("./Drawer").then((m) => ({ default: m.Drawer })));
const CommandPalette = lazy(() => import("./CommandMenu").then((m) => ({ default: m.CommandPalette })));
// Loaded on the first control a person opens.
const ConfirmDialog = lazy(() => import("./ConfirmDialog").then((m) => ({ default: m.ConfirmDialog })));
// Capsomer's "?" sheet, which lists every shortcut registered below. Loaded the first time it
// is opened, then kept: the initial bundle does not carry it.
const ShortcutSheet = lazy(() => import("./ShortcutSheet").then((m) => ({ default: m.ShortcutSheet })));

// What each view is for, in a line, under its "g" shortcut in the sheet (design D13 moved
// the views' intro sentences there). Jobs, Pull requests and the rest that need none have none.
const ABOUT: Partial<Record<ViewId, string>> = {
  needs: "The home: every decision waiting for you, with its buttons, then every problem worst first.",
  queue: "Every job by state. A blocked job shows what it waits on; open it to answer or resume it.",
  prs: "The pull requests waiting for you, with Approve and Close, then those recorded against jobs.",
  health: "One line on whether anything is broken, the tiles, then a tab each for sites, problems, deploys, backups and CI. Deploys are from Cloudflare's own record, so a hand-run wrangler deploy shows up too.",
  activity: "The audit log, newest first: who did what, where.",
  agents: "Every credential and when it was last seen; Checks sets what each agent said beside what the Worker verified.",
  packages: "Published: each npm package configured in Settings. Shared: the tag each app pins, who is behind, and the local copies left.",
  library: "The knowledge store, read-only: decisions, rulings and research, a search, and each document with its links and jobs.",
  settings: "The automation switches first, then phone alerts and email, sites, packages, projects and display. Every change is previewed first.",
};

// The phone tab bar (the Portal UX audit's sitemap, 2026-10): Needs you, Health and Pull
// requests, the three pages a person opens most. The header's menu button opens every page
// (Capsomer has no Menu tab yet), Settings among them.
const TABS: ViewId[] = ["needs", "health", "prs"];

// The menu's groups (design section 2 and the UX audit's sitemap): Now, Work, Records, then
// Settings at the foot, with no heading of its own (the UX audit's M4: it was only under
// the avatar). It is still in the avatar's menu, with its g then e shortcut and its
// command-menu entry.
const GROUPS: Array<{ label?: string; views: ViewId[] }> = [
  { label: "Now", views: ["needs", "health"] },
  { label: "Work", views: ["prs", "queue"] },
  { label: "Records", views: ["activity", "agents", "packages", "library"] },
  { views: ["settings"] },
];

// What a count means (rulings: a plain number counts, a violet pill needs you, red and amber are
// status). Down, critical or a red CI run is red (a failure is never violet); paused is amber; what
// waits on the owner is violet.
const COUNT_TONE: Partial<Record<ViewId, "need" | "crit" | "warn">> = {
  health: "crit",
};


// What each rail count means, for its accessible name and its tooltip.
const BADGE_NOTE: Partial<Record<ViewId, string>> = {
  health: "critical",
};

function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Freshness({ feed, nextPollAt, skew }: { feed: OpsFeed | null; nextPollAt: number; skew: number }) {
  const clientNow = useTick(1000);
  if (!feed) return <div className="fresh" role="status" aria-live="polite">Reading the feed...</div>;
  // Server times against the server's clock; the next poll against the browser's,
  // since the browser schedules it.
  const now = portalNow(clientNow, skew, ms(feed.live.generated));
  const snap = feed.snapshot;
  const stale = passStale(snap, now);
  const frac = Math.max(0, Math.min(1, (nextPollAt - clientNow) / POLL_MS));
  const title = snap
    ? `Live data read ${utc(ms(feed.live.generated))}. Site data from the watcher pass at ${utc(ms(snap.pass_at))} (every ${snap.cadence_min} min). Stale after ${2 * snap.cadence_min} min.`
    : `Live data read ${utc(ms(feed.live.generated))}. The watcher has not written its first pass yet.`;
  return (
    <div className={`fresh${stale ? " stale" : ""}`} title={title}>
      <FreshRing frac={frac} stale={stale} />
      <span>
        Updated <b>{ago(ms(feed.live.generated), now)}</b>
      </span>
      <span className="long">· {snap ? `${hasSites(feed) ? "sites from pass" : "watcher pass"} ${ago(ms(snap.pass_at), now)}` : "no watcher pass yet"}</span>
    </div>
  );
}

export function App() {
  const { feed, error, signedOut, nextPollAt, accept, signOut } = useOpsFeed();
  const [location, navigate] = useLocation();
  // A view's own filters live in its query string (?ns=, say); opening and closing a
  // drawer over the view keeps them.
  const search = useSearch();
  const qs = search ? `?${search}` : "";
  const views = VIEWS;
  const route = parseRoute(location);
  const parsed = route;
  // A retired view's address (a bookmark, say) is replaced by the page, tab and section
  // that hold its content now (MOVED in ctx.ts).
  const old = location.split("/").filter(Boolean)[0];
  const moved = old !== undefined && Object.hasOwn(MOVED, old) ? old : null;
  useEffect(() => {
    if (!moved) return;
    if (parsed.drawer) return navigate(routePath(parsed.view, parsed.drawer) + qs, { replace: true });
    const [page, anchor] = placePath(moved).split("#");
    navigate(`${page}${search ? `${page!.includes("?") ? "&" : "?"}${search}` : ""}${anchor ? `#${anchor}` : ""}`, { replace: true });
  }, [moved, parsed.view, parsed.drawer, qs, search, navigate]);
  // A page opened with a section's anchor scrolls to it once the section is drawn: the
  // sections load after the page does.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    let frames = 0;
    let raf = 0;
    const seek = () => {
      const el = document.getElementById(decodeURIComponent(id));
      if (el) el.scrollIntoView();
      else if (frames++ < 120) raf = requestAnimationFrame(seek);
    };
    raf = requestAnimationFrame(seek);
    return () => cancelAnimationFrame(raf);
  }, [location]);
  // Relative times are measured on the server's clock (portalNow): the skew is taken
  // when each feed arrives, and now never falls behind the feed's own read time.
  const tick = useTick(15_000);
  const [skew, setSkew] = useState(0);
  useEffect(() => {
    if (feed) setSkew(ms(feed.live.generated) - Date.now());
  }, [feed]);
  const now = portalNow(tick, skew, feed ? ms(feed.live.generated) : 0);
  const [filters, setFiltersState] = useState<Filters>({ q: "", range: "7d" });
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  // Set on the first open and never cleared, so the sheet mounts once and keeps its state.
  const [helpUsed, setHelpUsed] = useState(false);
  useEffect(() => {
    if (help) setHelpUsed(true);
  }, [help]);
  const singleKeys = useSingleKeys();
  const [messages, setMessages] = useState<Message[]>([]);
  const nextMessage = useRef(1);
  const [railCollapsed, setRailCollapsed] = useState(() => readPref(RAIL_PREF) === "collapsed");
  const [toast, setToast] = useState<{ msg: string; on: boolean }>({ msg: "", on: false });
  const [spinning, setSpinning] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mainRef = useRef<HTMLElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);

  // A longer message stays up longer, so an action's warning can be read.
  const say = useCallback((msg: string) => {
    setToast({ msg, on: true });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, on: false })), Math.max(2400, msg.length * 70));
  }, []);

  const confirm = useCallback((r: ConfirmRequest) => setConfirmReq(r), []);

  // The newest first. Plain results before it go; anything lasting stays.
  const post = useCallback((m: Omit<Message, "id">) => {
    const id = nextMessage.current++;
    setMessages((all) => withMessage(all, { ...m, id }));
  }, []);
  const update = useCallback((id: number, m: Omit<Message, "id">) => setMessages((all) => all.map((x) => (x.id === id ? { ...m, id } : x))), []);
  const fail = useCallback((text: string) => post({ text, warning: null, undo: null, error: null, busy: false, failure: true }), [post]);

  const performed = useCallback(
    (p: PortalPerformed, undo?: UndoRequest) => {
      accept(p.feed);
      post({ text: p.summary, warning: p.warning, undo: undo ?? null, error: null, busy: false, failure: false });
    },
    [accept, post],
  );

  // Undo sends the reverse change as its own action (params.undo "true"), which the
  // Worker records as portal-undo-<action>. Focus goes back to the switch it undid.
  const csrfRef = useRef("");
  csrfRef.current = feed?.csrf ?? "";
  const undo = useCallback(
    async (m: Message) => {
      const u = m.undo;
      if (!u || m.busy) return;
      update(m.id, { ...m, busy: true, error: null });
      const r = await runAction(csrfRef.current, { action: u.action, params: u.params });
      if (r.kind === "signed-out") return (setMessages([]), signOut());
      if (r.kind !== "ok") {
        const why = r.kind === "error" ? `Undo could not reach the server: ${r.message}` : `Undo was refused: ${r.message}`;
        return update(m.id, { ...m, busy: false, error: why });
      }
      accept(r.value.feed);
      const done = { text: `Undone. ${r.value.summary}`, warning: r.value.warning, undo: null, error: null, busy: false, failure: false };
      // A result that carried a warning keeps it, without its Undo, and the undo's own
      // result arrives beside it; a plain one becomes the undo's result.
      if (m.warning !== null) {
        update(m.id, { ...m, undo: null, busy: false });
        post(done);
      } else update(m.id, done);
      const back = u.focus;
      if (back) requestAnimationFrame(() => document.getElementById(back)?.focus());
    },
    [accept, post, signOut, update],
  );

  const go = useCallback(
    (v: ViewId) => {
      navigate(routePath(v));
      window.scrollTo(0, 0);
    },
    [navigate],
  );

  const open = useCallback(
    (ref: string) => {
      const i = ref.indexOf(":");
      const type = ref.slice(0, i);
      const id = ref.slice(i + 1);
      // A page, or a retired view id that placePath maps to its page and section.
      if (type === "view") {
        const to = placePath(id);
        const anchor = to.split("#")[1];
        navigate(to);
        // The location effect above scrolls to a section on another page; on this one,
        // the location does not change, so it is scrolled to here.
        if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView());
        else window.scrollTo(0, 0);
        return;
      }
      if (type === "site" || type === "job" || type === "agent" || type === "audit") navigate(routePath(route.view, { type, id }) + qs);
    },
    [go, navigate, route.view, qs],
  );

  const closeDrawer = useCallback(() => navigate(routePath(route.view) + qs), [navigate, route.view, qs]);

  const copy = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text).then(
        () => say("Copied"),
        (e: unknown) => fail(`Copy failed (${e instanceof Error ? e.message : "no clipboard"}): select the text and copy it.`),
      );
    },
    [say, fail],
  );

  const refresh = useCallback(async () => {
    if (spinning) return;
    setSpinning(true);
    const r = await requestRefresh();
    setSpinning(false);
    if (r.kind === "ok") {
      accept(r.feed);
      if (r.warning) return post({ text: "Refreshed: a new watcher pass ran.", warning: r.warning, undo: null, error: null, busy: false, failure: false });
      return say("Refreshed: a new watcher pass ran");
    }
    if (r.kind === "signed-out") return signOut();
    if (r.kind === "limited") {
      const at = r.allowedAt ?? (feed?.refresh_allowed_at ? ms(feed.refresh_allowed_at) : null);
      return say(at ? `Refresh is rate limited. The next is allowed ${ago(at)} (${utc(at).slice(11)}).` : "Refresh is rate limited. Try again shortly.");
    }
    fail(`Refresh failed: ${r.message}`);
  }, [accept, feed, say, fail, post, signOut, spinning]);

  // Sign out: the Worker expires the Portal's cookies, then the signed-out page says
  // it was a choice, not an expiry.
  const [leaving, setLeaving] = useState(false);
  const [leftByChoice, setLeftByChoice] = useState(false);
  const leave = useCallback(async () => {
    if (!feed || leaving) return;
    setLeaving(true);
    const r = await signOutRequest(feed.csrf);
    setLeaving(false);
    if (r.kind === "error") return fail(`Sign out failed: ${r.message}`);
    setLeftByChoice(true);
    signOut();
  }, [feed, leaving, fail, signOut]);

  const theme = useCallback(() => say(toggleTheme() === "dark" ? "Dark" : "Light"), [say]);

  const railRef = useRef(railCollapsed);
  railRef.current = railCollapsed;
  const setRail = useCallback((next: boolean) => {
    setRailCollapsed(next);
    writePref(RAIL_PREF, next ? "collapsed" : "expanded");
    tipRef.current?.classList.remove("on");
  }, []);
  const toggleRail = useCallback(() => setRail(!railRef.current), [setRail]);

  const setFilters = useCallback((f: Partial<Filters>) => {
    setFiltersState((p) => ({ ...p, ...f }));
  }, []);

  // j and k move keyboard focus itself among the visible [data-row] elements in main, in
  // document order, so the selection is the focused row: no index to go stale when the
  // feed changes, and Enter opens it (onRowActivate). A row that is not in the tab order
  // is made focusable by script only (tabIndex -1).
  const rows = () => Array.from(mainRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []).filter((el) => el.getClientRects().length > 0);
  const step = (dir: 1 | -1) => {
    const r = rows();
    if (!r.length) return;
    const cur = document.activeElement?.closest<HTMLElement>("[data-row]");
    const i = cur ? r.indexOf(cur) : -1;
    const el = r[i < 0 ? (dir === 1 ? 0 : r.length - 1) : Math.max(0, Math.min(r.length - 1, i + dir))];
    if (!el) return;
    if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  };

  // Keyboard grammar, in Capsomer's shortcut registry: one listener, single keys that can be
  // switched off (Settings, Display, and the sheet), and a modal dialog (the drawer, the
  // confirm dialog, the menu, the sheet) owns every key while it is open. Latest values
  // through a ref so each shortcut is registered once.
  const act = useRef({ go, refresh, theme, toggleRail, step });
  act.current = { go, refresh, theme, toggleRail, step };
  useEffect(() => {
    setSheetOpener(() => setHelp(true));
    const a = () => act.current;
    const offs = [
      register({ key: ["Mod+k", "/"], label: "Open the command menu", group: "General", run: () => setPalette(true) }),
      ...views.map((v) => register({ key: `g ${v.key}`, label: v.label, about: ABOUT[v.id], group: "Go to", run: () => a().go(v.id) })),
      register({ key: ["j", "k"], label: "Move through the list on screen", about: "Enter opens the selected row.", group: "This page", run: (e) => a().step(e.key === "j" ? 1 : -1) }),
      register({ key: "f", label: "Filter the list", group: "This page", when: () => !!document.getElementById("qsearch"), run: () => document.getElementById("qsearch")?.focus() }),
      register({ key: "r", label: "Refresh now", group: "General", run: () => void a().refresh() }),
      register({ key: "t", label: "Switch light and dark", group: "General", run: () => a().theme() }),
      register({ key: "[", label: "Collapse or expand the side menu", group: "General", run: () => a().toggleRail() }),
    ];
    return () => {
      offs.forEach((off) => off());
      setSheetOpener(null);
    };
  }, [views]);

  // Tooltips (data-tip): the uptime ticks, and the collapsed side menu. Shown on pointer
  // hover and on keyboard focus. data-tip-side="right" puts the tip beside the element
  // instead of above it.
  useEffect(() => {
    const tip = tipRef.current;
    if (!tip) return;
    const show = (el: HTMLElement | null | undefined) => {
      if (!el) return tip.classList.remove("on");
      tip.textContent = el.dataset.tip ?? "";
      tip.classList.add("on");
      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      if (el.dataset.tipSide === "below") {
        // The top bar's buttons: a tip above them would leave the window or cover them.
        tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2))}px`;
        tip.style.top = `${r.bottom + 6}px`;
        return;
      }
      if (el.dataset.tipSide === "right") {
        // Clear of the menu's edge, not over it.
        const edge = el.closest("nav")?.getBoundingClientRect().right ?? r.right;
        tip.style.left = `${Math.min(window.innerWidth - tw - 8, Math.max(r.right, edge) + 6)}px`;
        tip.style.top = `${Math.max(8, r.top + r.height / 2 - th / 2)}px`;
        return;
      }
      tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2))}px`;
      tip.style.top = `${Math.max(8, r.top - th - 8)}px`;
    };
    const over = (e: MouseEvent) => show((e.target as Element).closest?.<HTMLElement>("[data-tip]"));
    const focus = (e: FocusEvent) => show(e.target instanceof Element ? e.target.closest<HTMLElement>("[data-tip]") : null);
    const blur = () => tip.classList.remove("on");
    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blur);
    };
  }, []);

  // A stop from the command menu presses its switch on Namespaces, so the switch's own
  // reason field opens and the change goes the way a click would send it. It waits for
  // the switch to render, and says so if it never appears rather than doing nothing.
  const flip = useCallback(
    (id: string) => {
      navigate(placePath("namespaces"));
      const until = Date.now() + 3000;
      const press = () => {
        const el = document.getElementById(id);
        if (el instanceof HTMLInputElement && !el.disabled) {
          el.focus();
          el.click();
        } else if (Date.now() < until) setTimeout(press, 50);
        else say("That switch did not load in Settings, under Automation. Try it there.");
      };
      setTimeout(press, 0);
    },
    [go, say],
  );
  const paletteActions = useMemo(() => ({ go, open, refresh: () => void refresh(), theme, help: () => setHelp(true), copy, confirm, flip }), [go, open, refresh, theme, copy, confirm, flip]);
  const [paletteUsed, setPaletteUsed] = useState(false);
  useEffect(() => {
    if (palette) setPaletteUsed(true);
  }, [palette]);
  const [drawerUsed, setDrawerUsed] = useState(false);
  useEffect(() => {
    if (route.drawer) setDrawerUsed(true);
  }, [route.drawer]);

  const onRowActivate = (e: ReactMouseEvent | ReactKeyboardEvent) => {
    const target = e.target as Element;
    if ("key" in e && e.key !== "Enter") return;
    if (target.closest("a, button, input")) return;
    const el = target.closest<HTMLElement>("[data-open]");
    if (el?.dataset.open) {
      // Enter on a focused row: the drawer focuses its Close button as it opens, inside
      // this keydown; without this the browser activates that button with the same Enter.
      if ("key" in e) e.preventDefault();
      open(el.dataset.open);
    }
  };

  const c = feed ? counts(feed) : null;
  // One number, one place (design-portal-evaluation.md section 2, "Badges"; the UX audit's
  // m2): what waits on you is the header inbox's number and Needs you's list, and nowhere
  // else, so no menu entry counts it (Pull requests' waiting pull requests among them).
  // Health counts the critical problems, session incidents included (derive.ts), leaving
  // out what waits on you.
  const critCount = feed ? attentionItems(feed, now).filter((x) => x.sev === "crit" && !WAITING_KINDS.has(x.kind)).length : 0;
  const badge: Partial<Record<ViewId, { n: number; cls: string }>> = c && feed
    ? {
        health: { n: critCount, cls: "hot" },
      }
    : {};

  // The page title names the view, and the open panel's subject before it (WCAG 2.4.2):
  // "Fix the probe · Queue · Capsid Portal".
  const d = route.drawer;
  const subject = !d ? "" : d.type === "job" ? (feed?.live.jobs.find((j) => j.id === d.id)?.title ?? `Job ${d.id}`) : d.id;
  const pageTitle = [subject, VIEWS.find((v) => v.id === route.view)?.label, "Capsid Portal"].filter(Boolean).join(" · ");
  useEffect(() => {
    document.title = signedOut ? "Signed out · Capsid Portal" : pageTitle;
  }, [pageTitle, signedOut]);

  const tabs: ViewId[] = TABS;
  // One menu entry per view, grouped, Settings last.
  const entryFor = (id: ViewId, group?: string): AdminEntry => {
    const v = VIEWS.find((x) => x.id === id)!;
    const b = badge[id];
    return {
      id,
      label: v.label,
      href: routePath(id),
      icon: <NavIcon id={id} />,
      current: route.view === id,
      count: b?.n || undefined,
      countNote: BADGE_NOTE[id],
      tone: COUNT_TONE[id],
      group,
    };
  };
  const menu: AdminEntry[] = GROUPS.flatMap((g) => g.views.map((id) => entryFor(id, g.label)));
  const tabEntries = tabs.map((id) => ({ ...entryFor(id), icon: <NavIcon id={id} size={20} /> }));

  const ctx: Ctx | null = feed ? { feed, now, view: route.view, open, go, filters, setFilters, copy, say, confirm, performed, signOut } : null;
  const View = VIEW_COMPONENTS[route.view];

  let content: ReactNode;
  if (signedOut) {
    content = (
      <div className="page">
        <div className="signedout" role="alert">
          <h1>Signed out</h1>
          <p>
            {leftByChoice
              ? "You signed out of Capsid Portal in this browser. Signing in again may not ask for your email if your Access session is still open."
              : "Your Portal session ended, so the feed stopped answering."}
          </p>
          <a className="btn" href={APP_URL}>
            {leftByChoice ? "Sign in again" : "Reload to sign in"}
          </a>
        </div>
      </div>
    );
  } else if (!feed) {
    content = (
      <div className="page">
        {error ? (
          <div className="callout crit" role="alert">
            Could not read the feed: {error}. It retries every minute.
          </div>
        ) : (
          <div className="loading" role="status">
            <Spinner label="Reading the feed..." />
          </div>
        )}
      </div>
    );
  } else {
    content = (
      <>
        {error && (
          <div className="banner" role="alert">
            Could not read the feed: {error}. Showing the last good read from {ago(ms(feed.live.generated), now)}.
          </div>
        )}
        <Suspense
          fallback={
            <div className="page">
              <div className="loading" role="status">
                <Spinner label="Loading..." />
              </div>
            </div>
          }
        >
          <View />
        </Suspense>
      </>
    );
  }

  // Capsomer's owner shell in the family letterhead: the header's top row holds Search, the inbox,
  // the theme button and the avatar, whose menu holds Help; its second row says where you are and
  // links to the public site. The strip holds the family's apps.
  // The top bar says how fresh the page is and holds Refresh.
  const shell = (
    <AdminShell
      app="portal"
      letterhead
      viewSite="https://capsid.dustinedwards.info"
      page={signedOut ? "Signed out" : VIEWS.find((v) => v.id === route.view)?.label}
      nav={menu}
      tabs={tabEntries}
      navLabel="Sections"
      onSearch={() => setPalette(true)}
      inbox={feed ? { count: feed.live.inbox.count, countNote: "waiting on you", href: routePath("needs") } : undefined}
      onHelp={() => setHelp(true)}
      themePrefKey={THEME_PREF}
      account={{
        // From the signed-in session; neutral only until the first feed arrives.
        name: feed?.user.name ?? "Account",
        initials: feed?.user.initials ?? "A",
        appLabel: "Capsid Portal",
        appLinks: [{ label: "Portal settings", href: routePath("settings"), current: route.view === "settings" }],
        onSignOut: signedOut ? undefined : () => void leave(),
        signOutDisabled: !feed || leaving,
      }}
      status={
        <>
          {import.meta.env.DEV && (
            <span className="sample" title="npm run dev serves dev/sample-feed.json: every number here is fake">
              SAMPLE DATA
            </span>
          )}
          {!signedOut && <Freshness feed={feed} nextPollAt={nextPollAt} skew={skew} />}
        </>
      }
      onRefresh={signedOut ? undefined : () => void refresh()}
      refreshing={spinning}
      refreshShortcut="R"
      jumpKeys={singleKeys}
      prefKey={RAIL_PREF}
      collapsed={railCollapsed}
      onCollapsedChange={setRail}
      // Another app's address (the strip, the logo) is another origin: a plain anchor, since
      // wouter would put the Portal's base in front of it.
      renderLink={(p) => (/^https?:/.test(p.href) ? <a {...p} /> : <Link {...p} />)}
      mainProps={{ ref: mainRef, onClick: onRowActivate, onKeyDown: onRowActivate }}
    >
      {content}
    </AdminShell>
  );

  return (
    <>
      {ctx ? (
        <AppCtx.Provider value={ctx}>
          {shell}
          {drawerUsed && (
            <Suspense fallback={null}>
              <Drawer route={route.drawer} onClose={closeDrawer} />
            </Suspense>
          )}
        </AppCtx.Provider>
      ) : (
        shell
      )}
      {paletteUsed && (
        <Suspense fallback={null}>
          <CommandPalette open={palette} onClose={() => setPalette(false)} feed={feed} views={views} actions={paletteActions} now={now} />
        </Suspense>
      )}
      {helpUsed && (
        <Suspense fallback={null}>
          <ShortcutSheet open={help} onOpenChange={setHelp} />
        </Suspense>
      )}
      {confirmReq && feed && (
        <Suspense fallback={null}>
          <ConfirmDialog
            req={confirmReq}
            csrf={feed.csrf}
            onSignedOut={() => (setConfirmReq(null), signOut())}
            onClose={(p) => {
              setConfirmReq(null);
              if (!p) return;
              performed(p, confirmReq.undo);
              confirmReq.onDone?.(p);
            }}
          />
        </Suspense>
      )}
      <div className={`toast${toast.on ? " on" : ""}`} role="status" aria-live="polite">
        {toast.msg}
      </div>
      <div className="msg-region" role="status" aria-live="polite" aria-label="Results and failures, until dismissed">
        {messages.map((message) => (
          <div key={message.id} className={`msg${lasting(message) ? " warn" : ""}`} data-lasting={lasting(message) ? "" : undefined}>
            <span className="grow">
              {message.failure ? <span role="alert">{message.text}</span> : message.text}
              {message.warning && (
                <>
                  {" "}
                  <b>Warning:</b> {message.warning}
                </>
              )}
              {message.error && (
                <span className="err" role="alert">
                  {message.error}
                </span>
              )}
            </span>
            {message.undo && (
              <button type="button" className="btn" disabled={message.busy} onClick={() => void undo(message)}>
                {message.busy ? "Undoing..." : "Undo"}
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={message.busy}
              onClick={() => {
                setMessages((all) => all.filter((x) => x.id !== message.id));
                mainRef.current?.focus();
              }}
            >
              Dismiss
            </button>
          </div>
        ))}
      </div>
      <div className="tip" ref={tipRef} aria-hidden="true" />
    </>
  );
}
