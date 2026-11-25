import { forwardRef, useCallback, type AnchorHTMLAttributes, type ReactNode } from "react";
import { Link as RouterLink, useLocation as useRouterLocation, useNavigate } from "react-router";
import { DEMO_BASE } from "./demo";

// Views name pages from the Portal's root; these helpers prefix the base the page was opened under, so a demo link stays in the demo.

export function pageBase(pathname: string): string {
  return pathname === DEMO_BASE || pathname.startsWith(`${DEMO_BASE}/`) ? DEMO_BASE : "";
}

function withBase(base: string, to: string): string {
  if (!base || !to.startsWith("/")) return to;
  return to === "/" ? `${base}/` : `${base}${to}`;
}

export function useDemo(): boolean {
  return pageBase(useRouterLocation().pathname) !== "";
}

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

export function useSearch(): string {
  return useRouterLocation().search.replace(/^\?/, "");
}

export const Link = forwardRef<
  HTMLAnchorElement,
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }
>(function Link({ href, ...rest }, ref) {
  const base = pageBase(useRouterLocation().pathname);
  return <RouterLink ref={ref} to={withBase(base, href)} {...rest} />;
});

export function rowLink({
  href,
  children,
  ...rest
}: {
  href: string;
  "aria-describedby"?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}
