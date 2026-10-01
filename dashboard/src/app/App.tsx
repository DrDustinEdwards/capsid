import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { APP_URL, POLL_MS, requestRefresh, runAction, signOutRequest, useOpsFeed } from "../lib/api";
import { attentionItems, counts, hasPackages, hasSites, passStale } from "../lib/derive";
import { ago, ms, portalNow, utc } from "../lib/format";
import { RAIL_PREF, readPref, setSingleKeys, toggleTheme, useDarkTheme, useSingleKeys, writePref } from "../lib/prefs";
import { BrandMark, KeysIcon, NavIcon, RailIcon, RefreshIcon, SearchIcon, ThemeIcon } from "../ui/icons";
import { FreshRing } from "../ui/charts";
import { AppCtx, VIEWS, isView, parseRoute, routePath, viewsFor, type ConfirmRequest, type Ctx, type Filters, type UndoRequest, type ViewId } from "./ctx";
import { Drawer } from "./Drawer";
import { CommandMenu, commands } from "./CommandMenu";
import { HelpSheet } from "./HelpSheet";
import { MoreIcon, MoreSheet } from "./MoreSheet";
import { Overview } from "../views/Overview";
import type { OpsFeed, PortalPerformed } from "../types";

// The overview ships in the initial chunk; every other view loads on first visit.
const VIEW_COMPONENTS: Record<ViewId, ComponentType> = {
  overview: Overview,
  sites: lazy(() => import("../views/Sites").then((m) => ({ default: m.Sites }))),
  packages: lazy(() => import("../views/Packages").then((m) => ({ default: m.Packages }))),
  incidents: lazy(() => import("../views/Incidents").then((m) => ({ default: m.Incidents }))),
  queue: lazy(() => import("../views/Queue").then((m) => ({ default: m.Queue }))),
  deploys: lazy(() => import("../views/Deploys").then((m) => ({ default: m.Deploys }))),
  agents: lazy(() => import("../views/Agents").then((m) => ({ default: m.Agents }))),
  backups: lazy(() => import("../views/Backups").then((m) => ({ default: m.Backups }))),
  ci: lazy(() => import("../views/Ci").then((m) => ({ default: m.Ci }))),
  namespaces: lazy(() => import("../views/Namespaces").then((m) => ({ default: m.Namespaces }))),
  activity: lazy(() => import("../views/Activity").then((m) => ({ default: m.Activity }))),
  claims: lazy(() => import("../views/Claims").then((m) => ({ default: m.Claims }))),
  settings: lazy(() => import("../views/Settings").then((m) => ({ default: m.Settings }))),
};

// Loaded on the first control a person opens.
const ConfirmDialog = lazy(() => import("./ConfirmDialog").then((m) => ({ default: m.ConfirmDialog })));

// The phone tab bar (DECIDE 12): four views, then More, which lists every other view.
// With no site configured there is no Sites tab. Settings is under More: on a wide
// screen it is the top bar's Settings button, not a view in the left menu.
const TABS: ViewId[] = ["overview", "queue", "incidents", "sites"];

// A performed action's result, in the message region: it stays until dismissed or
// replaced by the next action, and carries Undo for a switch change. A warning (the
// click's audit row was not written) is part of it and never clears by itself.
interface Message {
  text: string;
  warning: string | null;
  undo: UndoRequest | null;
  // An Undo that was refused or could not be sent.
  error: string | null;
  busy: boolean;
}

// What each rail count means, for its accessible name and its tooltip.
const BADGE_NOTE: Partial<Record<ViewId, string>> = {
  overview: "critical",
  sites: "down or degraded",
  incidents: "open findings",
  queue: "blocked",
  ci: "red",
  namespaces: "paused",
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
  // Until the feed answers, the Sites view is assumed on offer, so a configured install
  // does not see it flicker in.
  const sitesOn = feed ? hasSites(feed) : true;
  const packagesOn = feed ? hasPackages(feed) : true;
  const views = viewsFor(sitesOn, packagesOn);
  const parsed = parseRoute(location);
  // With no site configured, /sites is not a view, and with no package, /packages is
  // not: either shows the overview, and the address is replaced below.
  const hidden = (parsed.view === "sites" && !sitesOn) || (parsed.view === "packages" && !packagesOn);
  const route = hidden ? { view: "overview" as const, drawer: null } : parsed;
  useEffect(() => {
    if (hidden) navigate(routePath("overview"), { replace: true });
  }, [hidden, navigate]);
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
  const singleKeys = useSingleKeys();
  const dark = useDarkTheme();
  const [more, setMore] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [message, setMessage] = useState<Message | null>(null);
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

  const performed = useCallback(
    (p: PortalPerformed, undo?: UndoRequest) => {
      accept(p.feed);
      setMessage({ text: p.summary, warning: p.warning, undo: undo ?? null, error: null, busy: false });
    },
    [accept],
  );

  // Undo sends the reverse change as its own action (params.undo "true"), which the
  // Worker records as portal-undo-<action>. Focus goes back to the switch it undid.
  const csrfRef = useRef("");
  csrfRef.current = feed?.csrf ?? "";
  const undo = useCallback(
    async (m: Message) => {
      const u = m.undo;
      if (!u || m.busy) return;
      setMessage({ ...m, busy: true, error: null });
      const r = await runAction(csrfRef.current, { action: u.action, params: u.params });
      if (r.kind === "signed-out") return (setMessage(null), signOut());
      if (r.kind !== "ok") {
        const why = r.kind === "error" ? `Undo could not reach the server: ${r.message}` : `Undo was refused: ${r.message}`;
        return setMessage({ ...m, busy: false, error: why });
      }
      accept(r.value.feed);
      setMessage({ text: `Undone. ${r.value.summary}`, warning: r.value.warning, undo: null, error: null, busy: false });
      const back = u.focus;
      if (back) requestAnimationFrame(() => document.getElementById(back)?.focus());
    },
    [accept, signOut],
  );

  const closeMore = useCallback(() => {
    setMore(false);
    requestAnimationFrame(() => moreBtn.current?.focus());
  }, []);

  const go = useCallback(
    (v: ViewId) => {
      navigate(routePath(v));
      mainRef.current?.scrollTo(0, 0);
    },
    [navigate],
  );

  const open = useCallback(
    (ref: string) => {
      const i = ref.indexOf(":");
      const type = ref.slice(0, i);
      const id = ref.slice(i + 1);
      if (type === "view") return isView(id) ? go(id) : undefined;
      if (type === "site" || type === "job" || type === "agent" || type === "audit") navigate(routePath(route.view, { type, id }) + qs);
    },
    [go, navigate, route.view, qs],
  );

  const closeDrawer = useCallback(() => navigate(routePath(route.view) + qs), [navigate, route.view, qs]);

  const copy = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text).then(
        () => say("Copied"),
        (e: unknown) => say(`Copy failed (${e instanceof Error ? e.message : "no clipboard"}): select the text and copy it`),
      );
    },
    [say],
  );

  const refresh = useCallback(async () => {
    if (spinning) return;
    setSpinning(true);
    const r = await requestRefresh();
    setSpinning(false);
    if (r.kind === "ok") return (accept(r.feed), say("Refreshed: a new watcher pass ran"));
    if (r.kind === "signed-out") return signOut();
    if (r.kind === "limited") {
      const at = r.allowedAt ?? (feed?.refresh_allowed_at ? ms(feed.refresh_allowed_at) : null);
      return say(at ? `Refresh is rate limited. The next is allowed ${ago(at)} (${utc(at).slice(11)}).` : "Refresh is rate limited. Try again shortly.");
    }
    say(`Refresh failed: ${r.message}`);
  }, [accept, feed, say, signOut, spinning]);

  // Sign out: the Worker expires the Portal's cookies, then the signed-out page says
  // it was a choice, not an expiry.
  const [leaving, setLeaving] = useState(false);
  const [leftByChoice, setLeftByChoice] = useState(false);
  const leave = useCallback(async () => {
    if (!feed || leaving) return;
    setLeaving(true);
    const r = await signOutRequest(feed.csrf);
    setLeaving(false);
    if (r.kind === "error") return say(`Sign out failed: ${r.message}`);
    setLeftByChoice(true);
    signOut();
  }, [feed, leaving, say, signOut]);

  const theme = useCallback(() => say(toggleTheme() === "dark" ? "Dark" : "Light"), [say]);

  const railRef = useRef(railCollapsed);
  railRef.current = railCollapsed;
  const toggleRail = useCallback(() => {
    const next = !railRef.current;
    setRailCollapsed(next);
    writePref(RAIL_PREF, next ? "collapsed" : "expanded");
    tipRef.current?.classList.remove("on");
  }, []);

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

  // Keyboard grammar. Latest values through a ref so one listener serves.
  const confirming = confirmReq != null;
  const keys = useRef({ singleKeys, palette, help, confirming, route, views });
  keys.current = { singleKeys, palette, help, confirming, route, views };
  const act = useRef({ go, refresh, theme, toggleRail, step });
  act.current = { go, refresh, theme, toggleRail, step };
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      const a = act.current;
      if (k.confirming) return; // the confirm dialog owns every key, Ctrl K included
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setHelp(false);
        setPalette((p) => !p);
        return;
      }
      if (k.palette || k.help) return; // the open dialog owns the keys; Esc closes it natively
      // The drawer is a modal dialog: its own cancel event closes it on Esc (Drawer.tsx).
      if (e.key === "Escape") return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable='true']") || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!k.singleKeys) return;
      if (gAt && Date.now() - gAt < 1200) {
        gAt = 0;
        const v = k.views.find((x) => x.key === e.key);
        if (v) (e.preventDefault(), a.go(v.id));
        return;
      }
      switch (e.key) {
        case "g":
          gAt = Date.now();
          return;
        case "/":
          e.preventDefault();
          setPalette(true);
          return;
        case "?":
          setHelp(true);
          return;
        case "r":
          void a.refresh();
          return;
        case "t":
          a.theme();
          return;
        case "[":
          a.toggleRail();
          return;
        case "f": {
          const s = document.getElementById("qsearch");
          if (s) (e.preventDefault(), s.focus());
          return;
        }
        case "j":
        case "k":
          if (k.route.drawer) return;
          e.preventDefault();
          a.step(e.key === "j" ? 1 : -1);
          return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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

  const list = useMemo(() => commands(feed, views, { go, open, refresh: () => void refresh(), theme, help: () => setHelp(true), copy }, now), [feed, views, go, open, refresh, theme, copy, now]);

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
  // Every critical row of Needs attention, session incidents included (derive.ts).
  const critCount = feed ? attentionItems(feed, now).filter((x) => x.sev === "crit").length : 0;
  const badge: Partial<Record<ViewId, { n: number; cls: string }>> = c
    ? {
        overview: { n: critCount, cls: "hot" },
        sites: { n: c.down + c.degraded, cls: "hot" },
        incidents: { n: c.findings, cls: "warm" },
        queue: { n: c.blocked, cls: "warm" },
        ci: { n: c.ciRed, cls: "warm" },
        namespaces: { n: c.paused, cls: "warm" },
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

  const tabs: ViewId[] = sitesOn ? TABS : TABS.filter((id) => id !== "sites");
  // Settings lives in the top bar, not the left menu; it keeps its view, its g then e
  // shortcut and its command-menu entry, which read the full views list.
  const railViews = views.filter((v) => v.id !== "settings");
  const moreItems = views
    .filter((v) => !tabs.includes(v.id))
    .map((v) => {
      const b = badge[v.id];
      return { id: v.id, label: v.label, count: b?.n ? `${b.n} ${BADGE_NOTE[v.id] ?? ""}`.trim() : null, current: route.view === v.id };
    });

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
            Reading the feed...
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
                Loading...
              </div>
            </div>
          }
        >
          <View />
        </Suspense>
      </>
    );
  }

  const shell = (
    <div className={`app${railCollapsed ? " rail-collapsed" : ""}`}>
      <header className="top">
        <div className="brand">
          <BrandMark />
          <div>Capsid Portal</div>
        </div>
        {import.meta.env.DEV && (
          <span className="sample" title="npm run dev serves dev/sample-feed.json: every number here is fake">
            SAMPLE DATA
          </span>
        )}
        <div className="spacer" />
        {!signedOut && <Freshness feed={feed} nextPollAt={nextPollAt} skew={skew} />}
        <button type="button" className={`btn iconbtn${spinning ? " spin" : ""}`} title="Refresh (r)" aria-label="Refresh" onClick={() => void refresh()} disabled={signedOut}>
          <RefreshIcon />
        </button>
        {/* The name starts with the visible word (WCAG 2.5.3), and stays when the word is
            hidden at phone width. */}
        <button type="button" className="btn" aria-label="Search, open the command menu" onClick={() => setPalette(true)}>
          <SearchIcon />
          <span className="hide-sm">Search</span> <kbd className="hide-sm">Ctrl K</kbd>
        </button>
        <button type="button" className="btn iconbtn" title="Dark theme (t)" aria-label="Dark theme" aria-pressed={dark} onClick={theme}>
          <ThemeIcon />
        </button>
        {/* Settings, after the theme button and before Sign out; current on the Settings
            view. On a phone it is under More instead (.top .hide-sm). */}
        <Link
          href={routePath("settings")}
          className="btn iconbtn topset hide-sm"
          aria-label="Settings"
          aria-current={route.view === "settings" ? "page" : undefined}
          data-tip="Settings (g e)"
          data-tip-side="below"
        >
          <NavIcon id="settings" />
        </Link>
        {!signedOut && (
          <button type="button" className="btn" onClick={() => void leave()} disabled={!feed || leaving}>
            Sign out
          </button>
        )}
      </header>
      <nav className="rail" id="rail" aria-label="Sections">
        {railViews.map((v) => {
          const b = badge[v.id];
          // With a count, the name says what it counts: "Sites, 2 down or degraded".
          const named = b?.n ? `${v.label}, ${b.n} ${BADGE_NOTE[v.id] ?? ""}`.trim() : undefined;
          return (
            <Link
              key={v.id}
              href={routePath(v.id)}
              aria-current={route.view === v.id ? "page" : undefined}
              aria-label={named}
              data-tip={railCollapsed ? (named ?? v.label) : undefined}
              data-tip-side={railCollapsed ? "right" : undefined}
            >
              <NavIcon id={v.id} />
              <span className="lbl">{v.label}</span>
              <span className={`count ${b?.n ? b.cls : ""}`}>{b?.n ? b.n : ""}</span>
            </Link>
          );
        })}
        {railCollapsed ? (
          <div className="hint">
            <button type="button" className="railbtn" data-tip="Command menu (Ctrl K)" data-tip-side="right" onClick={() => setPalette(true)}>
              <SearchIcon />
              <span className="lbl">Command menu</span>
            </button>
            <button type="button" className="railbtn" data-tip="Shortcuts (?)" data-tip-side="right" onClick={() => setHelp(true)}>
              <KeysIcon />
              <span className="lbl">Shortcuts</span>
            </button>
          </div>
        ) : (
          <div className="hint">
            <button type="button" className="linkish" onClick={() => setPalette(true)}>
              <span>Command menu</span>
              <span>
                <kbd>Ctrl</kbd> <kbd>K</kbd>
              </span>
            </button>
            <button type="button" className="linkish" onClick={() => setHelp(true)}>
              <span>Shortcuts</span>
              <kbd>?</kbd>
            </button>
          </div>
        )}
        <button
          type="button"
          className="railbtn railtoggle"
          aria-expanded={!railCollapsed}
          aria-controls="rail"
          data-tip={railCollapsed ? "Expand menu ([)" : undefined}
          data-tip-side={railCollapsed ? "right" : undefined}
          onClick={toggleRail}
        >
          <RailIcon />
          <span className="lbl">{railCollapsed ? "Expand menu" : "Collapse menu"}</span>
          <kbd className="lbl" aria-hidden="true">
            [
          </kbd>
        </button>
      </nav>
      <main ref={mainRef} tabIndex={-1} onClick={onRowActivate} onKeyDown={onRowActivate}>
        {content}
      </main>
      <nav className="tabbar" aria-label="Sections">
        {tabs.map((id) => {
          const v = VIEWS.find((x) => x.id === id)!;
          const b = badge[id];
          return (
            <Link key={id} href={routePath(id)} aria-current={route.view === id ? "page" : undefined}>
              <NavIcon id={id} size={20} />
              {v.label}
              {b?.n ? <span className="badge">{b.n}</span> : null}
            </Link>
          );
        })}
        <button ref={moreBtn} type="button" className={moreItems.some((m) => m.current) ? "cur" : undefined} aria-haspopup="dialog" aria-expanded={more} onClick={() => setMore(true)}>
          <MoreIcon />
          More
        </button>
      </nav>
    </div>
  );

  return (
    <>
      {ctx ? (
        <AppCtx.Provider value={ctx}>
          {shell}
          <Drawer route={route.drawer} onClose={closeDrawer} />
        </AppCtx.Provider>
      ) : (
        shell
      )}
      <CommandMenu open={palette} onClose={() => setPalette(false)} list={list} />
      <HelpSheet open={help} onClose={() => setHelp(false)} views={views} singleKeys={singleKeys} setSingleKeys={setSingleKeys} />
      <MoreSheet open={more} onClose={closeMore} items={moreItems} />
      {confirmReq && feed && (
        <Suspense fallback={null}>
          <ConfirmDialog
            req={confirmReq}
            csrf={feed.csrf}
            onSignedOut={() => (setConfirmReq(null), signOut())}
            onClose={(p) => {
              setConfirmReq(null);
              if (!p) return;
              performed(p);
              confirmReq.onDone?.(p);
            }}
          />
        </Suspense>
      )}
      <div className={`toast${toast.on ? " on" : ""}`} role="status" aria-live="polite">
        {toast.msg}
      </div>
      <div className="msg-region" role="status" aria-live="polite" aria-label="Result of the last action">
        {message && (
          <div className={`msg${message.warning || message.error ? " warn" : ""}`}>
            <span className="grow">
              {message.text}
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
                setMessage(null);
                mainRef.current?.focus();
              }}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
      <div className="tip" ref={tipRef} aria-hidden="true" />
    </>
  );
}
