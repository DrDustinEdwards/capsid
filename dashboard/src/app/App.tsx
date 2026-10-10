import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Spinner } from "capsomer/react/empty";
import { AdminShell, type AdminEntry } from "capsomer/react/admin-shell";
import { Link, useLocation, useSearch } from "wouter";
import { APP_URL, POLL_MS, requestRefresh, runAction, signOutRequest, useOpsFeed } from "../lib/api";
import { attentionItems, counts, hasPackages, hasSites, passStale } from "../lib/derive";
import { ago, ms, portalNow, utc } from "../lib/format";
import { RAIL_PREF, readPref, setSingleKeys, toggleTheme, useDarkTheme, useSingleKeys, writePref } from "../lib/prefs";
import { APPS } from "../lib/apps";
import { BrandMark, NavIcon, RefreshIcon, ThemeIcon } from "../ui/icons";
import { FreshRing } from "../ui/charts";
import { AppCtx, VIEWS, isView, parseRoute, routePath, viewsFor, type ConfirmRequest, type Ctx, type Filters, type UndoRequest, type ViewId } from "./ctx";
import { Drawer } from "./Drawer";
import { CommandMenu, commands } from "./CommandMenu";
import { NeedsYou } from "../views/NeedsYou";
import type { OpsFeed, PortalPerformed } from "../types";
import { lasting, withMessage, type Message } from "../lib/messages";

// Needs you, the home, ships in the initial chunk; every other view loads on first visit.
const VIEW_COMPONENTS: Record<ViewId, ComponentType> = {
  needs: NeedsYou,
  overview: lazy(() => import("../views/Overview").then((m) => ({ default: m.Overview }))),
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
// Loaded the first time it is opened, then kept: the initial bundle does not carry it.
const HelpSheet = lazy(() => import("./HelpSheet").then((m) => ({ default: m.HelpSheet })));

// The phone tab bar (DECIDE 12): four views, then More, which lists every other view.
// With no site configured there is no Sites tab. Settings is under More: on a wide
// screen it is the top bar's Settings button, not a view in the left menu.
const TABS: ViewId[] = ["needs", "queue", "incidents", "sites"];

// The menu's groups, in order (design: Watch, Work, Records). Settings is not a menu entry: it is
// under the avatar's account panel, with its g then e shortcut and its command-menu entry.
const GROUPS: Array<{ label: string; views: ViewId[] }> = [
  { label: "Watch", views: ["needs", "overview", "sites", "incidents", "deploys", "backups"] },
  { label: "Work", views: ["queue", "agents", "ci", "claims"] },
  { label: "Records", views: ["namespaces", "packages", "activity"] },
];

// What a count means (rulings: a plain number counts, a violet pill needs you, red and amber are
// status). Down, critical or a red CI run is red (a failure is never violet); paused is amber; what
// waits on the owner is violet.
const COUNT_TONE: Partial<Record<ViewId, "need" | "crit" | "warn">> = {
  needs: "need",
  overview: "crit",
  sites: "crit",
  incidents: "need",
  queue: "need",
  ci: "crit",
  namespaces: "warn",
};


// What each rail count means, for its accessible name and its tooltip.
const BADGE_NOTE: Partial<Record<ViewId, string>> = {
  needs: "waiting on you",
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
  const route = hidden ? { view: "needs" as const, drawer: null } : parsed;
  useEffect(() => {
    if (hidden) navigate(routePath("needs"), { replace: true });
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
  // Set on the first open and never cleared, so the sheet mounts once and keeps its state.
  const [helpUsed, setHelpUsed] = useState(false);
  useEffect(() => {
    if (help) setHelpUsed(true);
  }, [help]);
  const singleKeys = useSingleKeys();
  const dark = useDarkTheme();
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

  // A stop from the command menu presses its switch on Namespaces, so the switch's own
  // reason field opens and the change goes the way a click would send it. The rows
  // arrive with the namespaces read, so it waits for the switch, and says so if it never
  // appears rather than doing nothing.
  const flip = useCallback(
    (id: string) => {
      go("namespaces");
      const until = Date.now() + 3000;
      const press = () => {
        const el = document.getElementById(id);
        if (el instanceof HTMLButtonElement && !el.disabled) {
          el.focus();
          el.click();
        } else if (Date.now() < until) setTimeout(press, 50);
        else say(`That switch is not on Namespaces right now (${id}). Flip it there.`);
      };
      setTimeout(press, 0);
    },
    [go, say],
  );
  const list = useMemo(
    () => commands(feed, views, { go, open, refresh: () => void refresh(), theme, help: () => setHelp(true), copy, confirm, flip }, now),
    [feed, views, go, open, refresh, theme, copy, confirm, flip, now],
  );

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
  // Needs you counts what the inbox counts, the same number the admin strip's badge shows
  // (design-portal-evaluation.md section 2, "Badges"). The Overview keeps its count of
  // critical problems, session incidents included (derive.ts), until Health takes it.
  const critCount = feed ? attentionItems(feed, now).filter((x) => x.sev === "crit").length : 0;
  const badge: Partial<Record<ViewId, { n: number; cls: string }>> = c && feed
    ? {
        needs: { n: feed.live.inbox.count, cls: "warm" },
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
  // One menu entry per view on offer, grouped; Settings is under the avatar's account panel.
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
  const menu: AdminEntry[] = GROUPS.flatMap((g) => g.views.filter((id) => views.some((v) => v.id === id)).map((id) => entryFor(id, g.label)));
  const tabEntries = tabs.map((id) => ({ ...entryFor(id), icon: <NavIcon id={id} size={20} /> }));
  const moreEntries = menu.filter((e) => !tabs.includes(e.id as ViewId)).map((e) => ({ ...e, group: undefined }));

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

  // Right of the tab bar: the page's own bar says how fresh the data is and holds its page-wide
  // controls (Refresh and the theme). Everything of the owner's sits in the strip.
  const shell = (
    <AdminShell
      title="Capsid Portal"
      mark={<BrandMark />}
      apps={APPS}
      nav={menu}
      tabs={tabEntries}
      more={moreEntries}
      navLabel="Sections"
      onSearch={() => setPalette(true)}
      onHelp={() => setHelp(true)}
      account={{
        // From the signed-in session; neutral only until the first feed arrives.
        name: feed?.user.name ?? "Account",
        initials: feed?.user.initials ?? "A",
        appLinks: [
          { label: "Portal settings", href: routePath("settings"), current: route.view === "settings" },
          { label: "Keyboard shortcuts", onClick: () => setHelp(true) },
        ],
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
      actions={
        <>
          <button type="button" className={`btn iconbtn${spinning ? " spin" : ""}`} data-tip="Refresh (r)" data-tip-side="below" aria-label="Refresh" onClick={() => void refresh()} disabled={signedOut}>
            <RefreshIcon />
          </button>
          <button type="button" className="btn iconbtn" data-tip="Dark theme (t)" data-tip-side="below" aria-label="Dark theme" aria-pressed={dark} onClick={theme}>
            <ThemeIcon />
          </button>
        </>
      }
      jumpKeys={singleKeys}
      prefKey={RAIL_PREF}
      collapsed={railCollapsed}
      onCollapsedChange={setRail}
      renderLink={(p) => <Link {...p} />}
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
          <Drawer route={route.drawer} onClose={closeDrawer} />
        </AppCtx.Provider>
      ) : (
        shell
      )}
      <CommandMenu open={palette} onClose={() => setPalette(false)} list={list} />
      {helpUsed && (
        <Suspense fallback={null}>
          <HelpSheet open={help} onClose={() => setHelp(false)} views={views} singleKeys={singleKeys} setSingleKeys={setSingleKeys} />
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
              performed(p);
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
