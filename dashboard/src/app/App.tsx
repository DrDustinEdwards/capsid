import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { APP_URL, POLL_MS, requestRefresh, useOpsFeed } from "../lib/api";
import { attentionItems, counts, passStale } from "../lib/derive";
import { ago, ms, utc } from "../lib/format";
import { readPref, toggleTheme, writePref } from "../lib/prefs";
import { BrandMark, NavIcon, RefreshIcon, SearchIcon, ThemeIcon } from "../ui/icons";
import { FreshRing } from "../ui/charts";
import { AppCtx, VIEWS, isView, parseRoute, routePath, type Ctx, type Filters, type ViewId } from "./ctx";
import { Drawer } from "./Drawer";
import { CommandMenu, commands } from "./CommandMenu";
import { HelpSheet } from "./HelpSheet";
import { Overview } from "../views/Overview";
import type { OpsFeed } from "../types";

// The overview ships in the initial chunk; every other view loads on first visit.
const VIEW_COMPONENTS: Record<ViewId, ComponentType> = {
  overview: Overview,
  sites: lazy(() => import("../views/Sites").then((m) => ({ default: m.Sites }))),
  incidents: lazy(() => import("../views/Incidents").then((m) => ({ default: m.Incidents }))),
  queue: lazy(() => import("../views/Queue").then((m) => ({ default: m.Queue }))),
  deploys: lazy(() => import("../views/Deploys").then((m) => ({ default: m.Deploys }))),
  agents: lazy(() => import("../views/Agents").then((m) => ({ default: m.Agents }))),
  backups: lazy(() => import("../views/Backups").then((m) => ({ default: m.Backups }))),
  ci: lazy(() => import("../views/Ci").then((m) => ({ default: m.Ci }))),
};

const TABS: ViewId[] = ["overview", "sites", "queue", "incidents", "ci"];

function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Freshness({ feed, nextPollAt }: { feed: OpsFeed | null; nextPollAt: number }) {
  const now = useTick(1000);
  if (!feed) return <div className="fresh" role="status" aria-live="polite">Reading the feed...</div>;
  const snap = feed.snapshot;
  const stale = passStale(snap, now);
  const frac = Math.max(0, Math.min(1, (nextPollAt - now) / POLL_MS));
  const title = snap
    ? `Live data read ${utc(ms(feed.live.generated))}. Site data from the watcher pass at ${utc(ms(snap.pass_at))} (every ${snap.cadence_min} min). Stale after ${2 * snap.cadence_min} min.`
    : `Live data read ${utc(ms(feed.live.generated))}. The watcher has not written its first pass yet.`;
  return (
    <div className={`fresh${stale ? " stale" : ""}`} title={title}>
      <FreshRing frac={frac} stale={stale} />
      <span>
        Updated <b>{ago(ms(feed.live.generated), now)}</b>
      </span>
      <span className="long">· {snap ? `sites from pass ${ago(ms(snap.pass_at), now)}` : "no watcher pass yet"}</span>
    </div>
  );
}

export function App() {
  const { feed, error, signedOut, nextPollAt, accept, signOut } = useOpsFeed();
  const [location, navigate] = useLocation();
  const route = parseRoute(location);
  const now = useTick(15_000);
  const [filters, setFiltersState] = useState<Filters>({ ns: "all", q: "", range: "7d" });
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [singleKeys, setSingleKeysState] = useState(() => readPref("wf-single-keys") !== "off");
  const [toast, setToast] = useState<{ msg: string; on: boolean }>({ msg: "", on: false });
  const [spinning, setSpinning] = useState(false);
  const [sel, setSel] = useState(-1);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mainRef = useRef<HTMLElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const say = useCallback((msg: string) => {
    setToast({ msg, on: true });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, on: false })), 2400);
  }, []);

  const go = useCallback(
    (v: ViewId) => {
      navigate(routePath(v));
      setSel(-1);
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
      if (type === "site" || type === "job" || type === "agent") navigate(routePath(route.view, { type, id }));
    },
    [go, navigate, route.view],
  );

  const closeDrawer = useCallback(() => navigate(routePath(route.view)), [navigate, route.view]);

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

  const theme = useCallback(() => say(toggleTheme() === "dark" ? "Dark" : "Light"), [say]);

  const setSingleKeys = useCallback((v: boolean) => {
    setSingleKeysState(v);
    writePref("wf-single-keys", v ? "on" : "off");
  }, []);

  const setFilters = useCallback((f: Partial<Filters>) => {
    setFiltersState((p) => ({ ...p, ...f }));
    setSel(-1);
  }, []);

  // Selection for j and k: every [data-row] in main, in document order.
  const rows = () => Array.from(mainRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
  useEffect(() => {
    rows().forEach((el, i) => el.classList.toggle("sel", i === sel));
  });
  useEffect(() => setSel(-1), [route.view]);

  // Keyboard grammar. Latest values through a ref so one listener serves.
  const keys = useRef({ singleKeys, palette, help, route, sel });
  keys.current = { singleKeys, palette, help, route, sel };
  const act = useRef({ go, open, refresh, theme, closeDrawer });
  act.current = { go, open, refresh, theme, closeDrawer };
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      const a = act.current;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setHelp(false);
        setPalette((p) => !p);
        return;
      }
      if (k.palette || k.help) return; // the open dialog owns the keys; Esc closes it natively
      if (e.key === "Escape") {
        if (k.route.drawer) a.closeDrawer();
        return;
      }
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable='true']") || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!k.singleKeys) return;
      if (gAt && Date.now() - gAt < 1200) {
        gAt = 0;
        const v = VIEWS.find((x) => x.key === e.key);
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
        case "f": {
          const s = document.getElementById("qsearch");
          if (s) (e.preventDefault(), s.focus());
          return;
        }
        case "j":
        case "k": {
          if (k.route.drawer) return;
          const r = rows();
          if (!r.length) return;
          const next = Math.max(0, Math.min(r.length - 1, k.sel + (e.key === "j" ? 1 : -1)));
          setSel(next);
          r[next]?.scrollIntoView({ block: "nearest" });
          return;
        }
        case "Enter": {
          if (k.route.drawer || k.sel < 0 || t.closest("[data-open], a, button")) return;
          const ref = rows()[k.sel]?.dataset.open;
          if (ref) a.open(ref);
          return;
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Tooltips for the uptime ticks (data-tip).
  useEffect(() => {
    const tip = tipRef.current;
    if (!tip) return;
    const over = (e: MouseEvent) => {
      const el = (e.target as Element).closest?.<HTMLElement>("[data-tip]");
      if (!el) return tip.classList.remove("on");
      tip.textContent = el.dataset.tip ?? "";
      tip.classList.add("on");
      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2))}px`;
      tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8)}px`;
    };
    document.addEventListener("mouseover", over);
    return () => document.removeEventListener("mouseover", over);
  }, []);

  const list = useMemo(() => commands(feed, { go, open, refresh: () => void refresh(), theme, help: () => setHelp(true), copy }, now), [feed, go, open, refresh, theme, copy, now]);

  const onRowActivate = (e: ReactMouseEvent | ReactKeyboardEvent) => {
    const target = e.target as Element;
    if ("key" in e && e.key !== "Enter") return;
    if (target.closest("a, button, input")) return;
    const el = target.closest<HTMLElement>("[data-open]");
    if (el?.dataset.open) {
      const rs = rows();
      setSel(rs.indexOf(el));
      open(el.dataset.open);
    }
  };

  const c = feed ? counts(feed) : null;
  const critCount = feed ? attentionItems(feed, now).filter((x) => x.sev === "crit").length : 0;
  const badge: Partial<Record<ViewId, { n: number; cls: string }>> = c
    ? { overview: { n: critCount, cls: "hot" }, sites: { n: c.down + c.degraded, cls: "hot" }, incidents: { n: c.findings, cls: "warm" }, queue: { n: c.blocked, cls: "warm" }, ci: { n: c.ciRed, cls: "warm" } }
    : {};

  const ctx: Ctx | null = feed ? { feed, now, view: route.view, open, go, filters, setFilters, copy } : null;
  const View = VIEW_COMPONENTS[route.view];

  let content: ReactNode;
  if (signedOut) {
    content = (
      <div className="page">
        <div className="signedout" role="alert">
          <h1>Signed out</h1>
          <p>Your console session ended, so the feed stopped answering.</p>
          <a className="btn" href={APP_URL}>
            Reload to sign in
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
    <div className="app">
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
        {!signedOut && <Freshness feed={feed} nextPollAt={nextPollAt} />}
        <button type="button" className={`btn iconbtn${spinning ? " spin" : ""}`} title="Refresh (r)" aria-label="Refresh" onClick={() => void refresh()} disabled={signedOut}>
          <RefreshIcon />
        </button>
        <button type="button" className="btn" aria-label="Open command menu" onClick={() => setPalette(true)}>
          <SearchIcon />
          <span className="hide-sm">Search</span> <kbd className="hide-sm">Ctrl K</kbd>
        </button>
        <button type="button" className="btn iconbtn" title="Theme (t)" aria-label="Switch theme" onClick={theme}>
          <ThemeIcon />
        </button>
      </header>
      <nav className="rail" aria-label="Sections">
        {VIEWS.map((v) => {
          const b = badge[v.id];
          return (
            <Link key={v.id} href={routePath(v.id)} aria-current={route.view === v.id ? "page" : undefined} onClick={() => setSel(-1)}>
              <NavIcon id={v.id} />
              <span>{v.label}</span>
              <span className={`count ${b?.n ? b.cls : ""}`}>{b?.n ? b.n : ""}</span>
            </Link>
          );
        })}
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
      </nav>
      <main ref={mainRef} tabIndex={-1} onClick={onRowActivate} onKeyDown={onRowActivate}>
        {content}
      </main>
      <nav className="tabbar" aria-label="Sections">
        {TABS.map((id) => {
          const v = VIEWS.find((x) => x.id === id)!;
          const b = badge[id];
          return (
            <Link key={id} href={routePath(id)} aria-current={route.view === id ? "page" : undefined}>
              <NavIcon id={id} size={20} />
              {id === "ci" ? "CI" : v.label}
              {b?.n ? <span className="badge">{b.n}</span> : null}
            </Link>
          );
        })}
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
      <HelpSheet open={help} onClose={() => setHelp(false)} singleKeys={singleKeys} setSingleKeys={setSingleKeys} />
      <div className={`toast${toast.on ? " on" : ""}`} role="status" aria-live="polite">
        {toast.msg}
      </div>
      <div className="tip" ref={tipRef} aria-hidden="true" />
    </>
  );
}
