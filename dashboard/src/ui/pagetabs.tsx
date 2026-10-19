import { TabLink, TabsNav, type RenderTabLink } from "capsomer/react/tabs";
import { Link, useSearch } from "wouter";

// A page's tabs as links (Capsomer's tabs, links form): each tab is the page's address with
// ?tab=, so Back, a bookmark and an alert reach it, and a server-free reload keeps it. The
// first tab is the bare address. Other query parameters (a namespace filter, say) are kept
// when the tab changes. Health, Packages and Agents use it.

export interface PageTab {
  id: string;
  label: string;
}

const tabLink: RenderTabLink = ({ href, ...props }) => <Link href={href} {...props} />;

/** The ?tab= the address names, or null. */
export function useTabParam(): string | null {
  return new URLSearchParams(useSearch()).get("tab");
}

export function PageTabs({ label, path, tabs, current }: { label: string; path: string; tabs: ReadonlyArray<PageTab>; current: string }) {
  const search = useSearch();
  const hrefFor = (id: string) => {
    const qs = new URLSearchParams(search);
    if (id === tabs[0]?.id) qs.delete("tab");
    else qs.set("tab", id);
    const q = qs.toString();
    return `${path}${q ? `?${q}` : ""}`;
  };
  return (
    <TabsNav aria-label={label} variant="line" renderLink={tabLink}>
      {tabs.map((t) => (
        <TabLink key={t.id} href={hrefFor(t.id)} current={t.id === current} data-tab={t.id}>
          {t.label}
        </TabLink>
      ))}
    </TabsNav>
  );
}
