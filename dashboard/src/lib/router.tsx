import { forwardRef, useCallback, type AnchorHTMLAttributes } from "react";
import { Link as RouterLink, useLocation as useRouterLocation, useNavigate } from "react-router";
import { DEMO_BASE } from "./demo";

// The Portal's pages are written once and served twice (src/routes.ts): at the root of
// portal.dustinedwards.info behind the sign-in, and under /demos/ with sample data and no
// sign-in. Views name their pages from the Portal's root ("/health"); these helpers put
// the base the page was opened under in front, so a link on a demo page stays in the demo.

/** "/demos" on a demo page, "" on the Portal. */
export function pageBase(pathname: string): string {
  return pathname === DEMO_BASE || pathname.startsWith(`${DEMO_BASE}/`) ? DEMO_BASE : "";
}

/** A page path ("/", "/health?tab=ci") under the base. */
function withBase(base: string, to: string): string {
  if (!base || !to.startsWith("/")) return to;
  return to === "/" ? `${base}/` : `${base}${to}`;
}

/** Whether this page is the chart demo: sample data, nothing saved. */
export function useDemo(): boolean {
  return pageBase(useRouterLocation().pathname) !== "";
}

/** The path without the base, and a navigate that adds it back. */
export function useLocation(): [string, (to: string, opts?: { replace?: boolean }) => void] {
  const { pathname } = useRouterLocation();
  const base = pageBase(pathname);
  const nav = useNavigate();
  const navigate = useCallback(
    (to: string, opts?: { replace?: boolean }) => void nav(withBase(base, to), opts),
    [nav, base],
  );
  return [pathname.slice(base.length) || "/", navigate];
}

/** The query string without its "?". */
export function useSearch(): string {
  return useRouterLocation().search.replace(/^\?/, "");
}

/** A link to a Portal page, named from the Portal's root. */
export const Link = forwardRef<
  HTMLAnchorElement,
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }
>(function Link({ href, ...rest }, ref) {
  const base = pageBase(useRouterLocation().pathname);
  return <RouterLink ref={ref} to={withBase(base, href)} {...rest} />;
});
