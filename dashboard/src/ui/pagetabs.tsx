import { TabLink, TabsNav, type RenderTabLink } from "capsomer/react/tabs";
import { Link, useSearch } from "../lib/router";

export interface PageTab {
  id: string;
  label: string;
}

const tabLink: RenderTabLink = ({ href, ...props }) => <Link href={href} {...props} />;

export function useTabParam(): string | null {
  return new URLSearchParams(useSearch()).get("tab");
}

export function PageTabs({
  label,
  path,
  tabs,
  current,
}: {
  label: string;
  path: string;
  tabs: ReadonlyArray<PageTab>;
  current: string;
}) {
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
