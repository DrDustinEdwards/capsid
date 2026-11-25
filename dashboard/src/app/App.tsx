import { Banner } from "capsomer/react/banner";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Spinner } from "capsomer/react/skeleton";
import { useNow, useRemembered } from "capsomer/react/hooks";
import { copyText } from "capsomer/behavior/copy";
import { Freshness } from "capsomer/react/freshness";
import { shareLeft } from "capsomer/behavior/freshness";
import "capsomer/freshness.css";
import { AdminShell, type AdminEntry } from "capsomer/react/admin-shell";
import { SignedOutPage } from "capsomer/react/error-page";
import { ModeBanner } from "capsomer/react/mode-banner";
import "capsomer/mode-banner.css";
import { useScrollToHash } from "capsomer/react/route-hooks";
import { Outlet } from "react-router";
import { Link, useDemo, useLocation, useSearchString } from "../lib/router";
import {
  APP_URL,
  POLL_MS,
  requestRefresh,
  runAction,
  signOutRequest,
  useOpsFeed,
} from "../lib/api";
import { attentionItems, hasSites, passStale } from "../lib/derive";
import { ago } from "../lib/format";
import { useWaiting } from "../lib/waiting";
import { parse, serverNow, utc } from "capsomer/behavior/time";
import { toggleTheme } from "capsomer/behavior/theme-switch";
import { RAIL_PREF, THEME_PREF, useSingleKeys } from "../lib/prefs";
import { register, setSheetOpener } from "capsomer/behavior/shortcuts";
import { NavIcon } from "../ui/icons";
import {
  AppCtx,
  VIEWS,
  parseRoute,
  placePath,
  routePath,
  refPath,
  type ConfirmRequest,
  type Ctx,
  type Filters,
  type UndoRequest,
  type ViewId,
} from "./ctx";
import type { OpsFeed, PortalPerformed } from "../types";
import { MessageProvider, MessageRegion, useMessage } from "capsomer/react/message";

// Loaded on first use so the initial bundle carries neither (the size budget).
const Drawer = lazy(() => import("./Drawer").then((m) => ({ default: m.Drawer })));
const CommandPalette = lazy(() =>
  import("./CommandMenu").then((m) => ({ default: m.CommandPalette })),
);
const ConfirmDialog = lazy(() =>
  import("./ConfirmDialog").then((m) => ({ default: m.ConfirmDialog })),
);
const ShortcutSheet = lazy(() =>
  import("./ShortcutSheet").then((m) => ({ default: m.ShortcutSheet })),
);

const TABS: ViewId[] = ["needs", "health", "prs"];

const GROUPS: Array<{ label?: string; views: ViewId[] }> = [
  { label: "Now", views: ["needs", "health"] },
  { label: "Sites", views: ["sites"] },
  { label: "Work", views: ["prs", "projects"] },
  { label: "Records", views: ["activity", "queue", "agents", "packages", "library"] },
  { views: ["settings"] },
];

function FeedFreshness({
  feed,
  nextPollAt,
  skew,
}: {
  feed: OpsFeed | null;
  nextPollAt: number;
  skew: number;
}) {
  const clientNow = useNow(1000);
  if (!feed) return <Freshness pending="Reading the feed..." />;
  // Server times against the server's clock; the next poll against the browser's, which schedules it.
  const now = serverNow(clientNow, skew, parse(feed.live.generated));
  const snap = feed.snapshot;
  const title = snap
    ? `Live data read ${utc(parse(feed.live.generated))}. Site data from the watcher pass at ${utc(parse(snap.pass_at))} (every ${snap.cadence_min} min). Stale after ${2 * snap.cadence_min} min.`
    : `Live data read ${utc(parse(feed.live.generated))}. The watcher has not written its first pass yet.`;
  return (
    <Freshness
      updated={ago(parse(feed.live.generated), now)}
      more={
        snap
          ? `${hasSites(feed) ? "sites from pass" : "watcher pass"} ${ago(parse(snap.pass_at), now)}`
          : "no watcher pass yet"
      }
      share={shareLeft(nextPollAt, clientNow, POLL_MS)}
      stale={passStale(snap, now)}
      title={title}
    />
  );
}

let latestCsrf = "";

export function App() {
  const singleKeys = useSingleKeys();
  return (
    <MessageProvider region={false} undoKey={singleKeys}>
      <PortalApp />
    </MessageProvider>
  );
}

function PortalApp() {
  const { feed, error, signedOut, nextPollAt, accept, signOut } = useOpsFeed();
  const demo = useDemo();
  const [location, navigate] = useLocation();
  const search = useSearchString();
  const qs = search ? `?${search}` : "";
  const views = VIEWS;
  const route = parseRoute(location);
  useScrollToHash();
  // The skew is taken when each feed arrives, so now never falls behind the feed's own read time.
  const tick = useNow(15_000);
  const [skew, setSkew] = useState(0);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the skew is the browser's clock against the feed's stamp, taken when a feed arrives; it is read from the clock, not derived from props
    if (feed) setSkew(parse(feed.live.generated) - Date.now());
  }, [feed]);
  const now = serverNow(tick, skew, feed ? parse(feed.live.generated) : 0);
  const [filters, setFiltersState] = useState<Filters>({ q: "", range: "7d" });
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [helpUsed, setHelpUsed] = useState(false);
  if (help && !helpUsed) setHelpUsed(true);
  const singleKeys = useSingleKeys();
  const { say, fail } = useMessage();
  // Read after the first paint: the server renders the menu open, and the saved choice then closes it, so the HTML and first render agree.
  const [railPref, rememberRail] = useRemembered(RAIL_PREF);
  const railCollapsed = railPref === "collapsed";
  const [spinning, setSpinning] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);

  const confirm = useCallback((r: ConfirmRequest) => setConfirmReq(r), [setConfirmReq]);

  // Undo is the reverse change as its own action (params.undo "true", recorded as portal-undo-<action>); a refusal throws so the message keeps its Undo.
  useEffect(() => {
    latestCsrf = feed?.csrf ?? "";
  }, [feed]);
  const undoAction = useCallback(
    async (u: UndoRequest) => {
      const r = await runAction(latestCsrf, {
        action: u.action,
        params: u.params,
      });
      if (r.kind === "signed-out") {
        signOut();
        throw new Error("the session ended. Sign in again.");
      }
      if (r.kind !== "ok")
        throw new Error(
          r.kind === "error"
            ? `Undo could not reach the server: ${r.message}`
            : `Undo was refused: ${r.message}`,
        );
      accept(r.value.feed);
      if (r.value.warning) say(`Undone. ${r.value.summary}`, { warning: r.value.warning });
    },
    [accept, say, signOut],
  );
  const performed = useCallback(
    (p: PortalPerformed, u?: UndoRequest) => {
      accept(p.feed);
      say(p.summary, {
        warning: p.warning ?? undefined,
        undo: u ? () => undoAction(u) : undefined,
        returnFocus: u?.focus ? () => document.getElementById(u.focus!) : undefined,
      });
    },
    [accept, say, undoAction],
  );

  const go = useCallback(
    (v: ViewId) => {
      navigate(routePath(v));
      window.scrollTo(0, 0);
    },
    [navigate],
  );

  const href = useCallback(
    (ref: string) => {
      const type = ref.slice(0, ref.indexOf(":"));
      const to = refPath(ref, route.view, route.site);
      return type === "view" || type === "site" ? to : to + qs;
    },
    [route.view, route.site, qs],
  );

  const open = useCallback(
    (ref: string) => {
      const type = ref.slice(0, ref.indexOf(":"));
      const to = href(ref);
      if (type !== "view" && type !== "site") {
        if (to !== routePath(route.view, null, route.site) + qs) navigate(to);
        return;
      }
      navigate(to);
      const anchor = type === "view" ? to.split("#")[1] : undefined;
      // The location does not change here, so the section is scrolled to directly.
      if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView());
      else window.scrollTo(0, 0);
    },
    [href, navigate, route.view, route.site, qs],
  );

  const closeDrawer = useCallback(
    () => navigate(routePath(route.view, null, route.site) + qs),
    [navigate, route.view, route.site, qs],
  );

  const copy = useCallback(
    (text: string) => {
      void copyText(text).then((ok) =>
        ok ? say("Copied") : fail("Copy failed: select the text and copy it."),
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
      if (r.warning)
        return say("Refreshed: a new watcher pass ran.", {
          warning: r.warning,
        });
      return say("Refreshed: a new watcher pass ran");
    }
    if (r.kind === "signed-out") return signOut();
    if (r.kind === "limited") {
      const at = r.allowedAt ?? (feed?.refresh_allowed_at ? parse(feed.refresh_allowed_at) : null);
      return say(
        at
          ? `Refresh is rate limited. The next is allowed ${ago(at)} (${utc(at).slice(11)}).`
          : "Refresh is rate limited. Try again shortly.",
      );
    }
    fail(`Refresh failed: ${r.message}`);
  }, [accept, feed, say, fail, signOut, spinning]);

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

  const theme = useCallback(
    () => say(toggleTheme(THEME_PREF) === "dark" ? "Dark" : "Light"),
    [say],
  );

  const railRef = useRef(railCollapsed);
  useEffect(() => {
    railRef.current = railCollapsed;
  }, [railCollapsed]);
  const setRail = useCallback(
    (next: boolean) => {
      rememberRail(next ? "collapsed" : "expanded");
    },
    [rememberRail],
  );
  const toggleRail = useCallback(() => setRail(!railRef.current), [setRail]);

  const setFilters = useCallback((f: Partial<Filters>) => {
    setFiltersState((p) => ({ ...p, ...f }));
  }, []);

  // j and k move focus itself among the visible [data-row] elements, so no index goes stale when the feed changes;
  // a row outside the tab order is made focusable by script only (tabIndex -1).
  const ROW = "[data-row], .cap-row-title > :is(a, button)";
  const rows = () =>
    Array.from(mainRef.current?.querySelectorAll<HTMLElement>(ROW) ?? []).filter(
      (el) => el.getClientRects().length > 0,
    );
  const step = (dir: 1 | -1) => {
    const r = rows();
    if (!r.length) return;
    const cur = document.activeElement?.closest<HTMLElement>(ROW);
    const i = cur ? r.indexOf(cur) : -1;
    const el =
      r[i < 0 ? (dir === 1 ? 0 : r.length - 1) : Math.max(0, Math.min(r.length - 1, i + dir))];
    if (!el) return;
    if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  };

  // Latest values through a ref so each shortcut is registered once.
  const act = useRef({ go, refresh, theme, toggleRail, step });
  useEffect(() => {
    act.current = { go, refresh, theme, toggleRail, step };
  });
  useEffect(() => {
    setSheetOpener(() => setHelp(true));
    const a = () => act.current;
    const offs = [
      register({
        key: ["Mod+k", "/"],
        label: "Open the command menu",
        group: "General",
        run: () => setPalette(true),
      }),
      ...views.map((v) =>
        register({
          key: `g ${v.key}`,
          label: v.label,
          group: "Go to",
          run: () => a().go(v.id),
        }),
      ),
      register({
        key: ["j", "k"],
        label: "Move through the list on screen",
        about: "Enter opens the selected row.",
        group: "This page",
        run: (e) => a().step(e.key === "j" ? 1 : -1),
      }),
      register({
        key: "f",
        label: "Filter the list",
        group: "This page",
        when: () => !!document.getElementById("qsearch"),
        run: () => document.getElementById("qsearch")?.focus(),
      }),
      register({
        key: "r",
        label: "Refresh now",
        group: "General",
        run: () => void a().refresh(),
      }),
      register({
        key: "t",
        label: "Switch light and dark",
        group: "General",
        run: () => a().theme(),
      }),
      register({
        key: "[",
        label: "Collapse or expand the side menu",
        group: "General",
        run: () => a().toggleRail(),
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      setSheetOpener(null);
    };
  }, [views]);

  const flip = useCallback(
    (id: string) => {
      navigate(placePath("settings#automation"));
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
    [navigate, say],
  );
  const paletteActions = useMemo(
    () => ({
      go,
      open,
      refresh: () => void refresh(),
      theme,
      help: () => setHelp(true),
      copy,
      confirm,
      flip,
    }),
    [go, open, refresh, theme, copy, confirm, flip, setHelp],
  );
  const [paletteUsed, setPaletteUsed] = useState(false);
  if (palette && !paletteUsed) setPaletteUsed(true);
  const [drawerUsed, setDrawerUsed] = useState(false);
  if (route.drawer && !drawerUsed) setDrawerUsed(true);

  const onRowActivate = (e: ReactMouseEvent | ReactKeyboardEvent) => {
    const target = e.target as Element;
    if ("key" in e && e.key !== "Enter") return;
    if (target.closest("a, button, input")) return;
    const el = target.closest<HTMLElement>("[data-open]");
    if (el?.dataset.open) {
      // The drawer focuses its Close button as it opens, inside this keydown; without this the same Enter activates it.
      if ("key" in e) e.preventDefault();
      open(el.dataset.open);
    }
  };

  const waiting = useWaiting(feed);
  // What waits on you is counted by the header inbox only, so no menu entry counts it.
  const critCount = feed ? attentionItems(feed, now).filter((x) => x.sev === "crit").length : 0;

  const d = route.drawer;
  const subject = !d
    ? ""
    : d.type === "job"
      ? (feed?.live.jobs.find((j) => j.id === d.id)?.title ?? `Job ${d.id}`)
      : d.id;
  const siteName = route.site
    ? (feed?.live.sites.find((s) => s.namespace === route.site)?.name ?? route.site)
    : "";
  const pageTitle = [
    subject,
    siteName,
    VIEWS.find((v) => v.id === route.view)?.label,
    "Capsid Portal",
  ]
    .filter(Boolean)
    .join(" · ");
  useEffect(() => {
    document.title = signedOut ? "Signed out · Capsid Portal" : pageTitle;
  }, [pageTitle, signedOut]);

  const tabs: ViewId[] = TABS;
  const entryFor = (id: ViewId, group?: string): AdminEntry => {
    const v = VIEWS.find((x) => x.id === id)!;
    const health = id === "health";
    return {
      id,
      label: v.label,
      href: routePath(id),
      icon: <NavIcon id={id} />,
      current: route.view === id,
      count: (health && critCount) || undefined,
      countNote: health ? "critical" : undefined,
      tone: health ? ("crit" as const) : undefined,
      group,
    };
  };
  const menu: AdminEntry[] = GROUPS.flatMap((g) => g.views.map((id) => entryFor(id, g.label)));
  const tabEntries = tabs.map((id) => ({
    ...entryFor(id),
    icon: <NavIcon id={id} size={20} />,
  }));

  const ctx: Ctx | null = feed
    ? {
        feed,
        now,
        view: route.view,
        open,
        href,
        go,
        filters,
        setFilters,
        copy,
        say,
        confirm,
        performed,
        signOut,
      }
    : null;

  let content: ReactNode;
  if (!feed) {
    content = (
      <div className="cap-admin-page">
        {error ? (
          <Banner tone="crit">Could not read the feed: {error}. It retries every minute.</Banner>
        ) : (
          <Spinner layout="page" label="Reading the feed..." />
        )}
      </div>
    );
  } else {
    content = (
      <>
        {error && (
          <Banner tone="warn">
            Could not read the feed: {error}. Showing the last good read from{" "}
            {ago(parse(feed.live.generated), now)}.
          </Banner>
        )}
        <Suspense
          fallback={
            <div className="cap-admin-page">
              <Spinner layout="page" label="Loading..." />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </>
    );
  }

  const shell = signedOut ? (
    <SignedOutPage app="Capsid Portal" signIn={APP_URL} byChoice={leftByChoice} />
  ) : (
    <AdminShell
      app="portal"
      letterhead
      viewSite="https://capsid.dustinedwards.info"
      page={siteName || VIEWS.find((v) => v.id === route.view)?.label}
      nav={menu}
      tabs={tabEntries}
      navLabel="Sections"
      onSearch={() => setPalette(true)}
      inbox={
        feed
          ? {
              count: waiting.total,
              countNote: "waiting on you",
              href: routePath("needs"),
            }
          : undefined
      }
      onHelp={() => setHelp(true)}
      themePrefKey={THEME_PREF}
      account={{
        name: feed?.user.name ?? "Account",
        initials: feed?.user.initials ?? "A",
        appLabel: "Capsid Portal",
        appLinks: [
          {
            label: "Portal settings",
            href: routePath("settings"),
            current: route.view === "settings",
          },
        ],
        onSignOut: () => void leave(),
        signOutDisabled: !feed || leaving,
      }}
      status={
        <>
          {(import.meta.env.DEV || demo) && (
            <span
              className="sample"
              title="Sample data (dev/sample-feed.json): every number here is fake"
            >
              SAMPLE DATA
            </span>
          )}
          <FeedFreshness feed={feed} nextPollAt={nextPollAt} skew={skew} />
        </>
      }
      onRefresh={() => void refresh()}
      refreshing={spinning}
      refreshShortcut="R"
      jumpKeys={singleKeys}
      prefKey={RAIL_PREF}
      collapsed={railCollapsed}
      onCollapsedChange={setRail}
      // Another origin: a plain anchor, since the Portal's Link would put the demo's base in front of it.
      renderLink={(p) => (/^https?:/.test(p.href) ? <a {...p} /> : <Link {...p} />)}
      mainProps={{
        ref: mainRef,
        onClick: onRowActivate,
        onKeyDown: onRowActivate,
      }}
    >
      {demo && <ModeBanner mode="demo" />}
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
          <CommandPalette
            open={palette}
            onClose={() => setPalette(false)}
            feed={feed}
            views={views}
            actions={paletteActions}
            now={now}
          />
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
      <MessageRegion />
    </>
  );
}
