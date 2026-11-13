import {
  Icon as CapIcon,
  iconBook,
  iconClock,
  iconFolder,
  iconPeople,
  iconQueue,
  iconSettings,
} from "capsomer/react/icons";

// The menu's icons: the shared set where it has the drawing, the Portal's own 16-unit drawings where
// it does not (Jobs, Sites, Pull requests, Packages, Health).
const NAV_ICONS: Record<string, { d: string; box?: number }> = {
  needs: { d: iconQueue },
  sites: {
    d: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2z",
    box: 16,
  },
  projects: { d: iconFolder },
  queue: { d: "M2 4h12M2 8h12M2 12h7", box: 16 },
  agents: { d: iconPeople },
  settings: { d: iconSettings },
  packages: {
    d: "M8 1.8l5.6 3v6.4L8 14.2l-5.6-3V4.8zM2.4 4.8L8 7.8l5.6-3M8 7.8v6.4M5.2 3.3l5.6 3",
    box: 16,
  },
  library: { d: iconBook },
  activity: { d: iconClock },
  health: { d: "M1.5 8.5h3l1.8-4.5 3.4 8 1.8-3.5h3", box: 16 },
  prs: {
    d: "M4 2a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM4 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM12 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM4 6v4M6 4h2a4 4 0 0 1 4 4",
    box: 16,
  },
};

export function NavIcon({ id, size = 16 }: { id: string; size?: number }) {
  const icon = NAV_ICONS[id];
  if (!icon) return null;
  return <CapIcon {...icon} className={size > 16 ? "navicon navicon-lg" : "navicon"} />;
}
