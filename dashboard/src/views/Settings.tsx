import { Suspense, lazy } from "react";
import { Switch } from "capsomer/react/switch";
import { ThemeSwitch } from "capsomer/react/theme-switch";
import { THEME_PREF, setSingleKeys, useSingleKeys } from "../lib/prefs";
import { Panel } from "capsomer/react/panel";
// The lazy Automation section's segmented control: loaded with the route, so that section
// brings no stylesheet of its own to wait for before it hydrates.
import "capsomer/segmented.css";
import { PageHead } from "./shared";

// SETTINGS: your preferences only (the Portal audit's new map, 2026-11-06). The overnight run
// first (the switch that matters at 2 a.m.), then phone alerts and the daily digest, then this
// browser's display. The sites are on Sites, each site's row on its Setup tab; the packages on
// Packages; the projects on Projects.

// The overnight switch and phone alerts load on their own, after the page's first paint.
const Automation = lazy(() => import("./Automation").then((m) => ({ default: m.Automation })));
const PhoneAlerts = lazy(() => import("./PhoneAlerts").then((m) => ({ default: m.PhoneAlerts })));

export function Settings() {
  return (
    <div className="page">
      <PageHead title="Settings" />
      <Suspense fallback={null}>
        <Automation />
      </Suspense>
      <Suspense fallback={null}>
        <PhoneAlerts />
      </Suspense>
      <Display />
    </div>
  );
}

// Display: this browser's own preferences (DECIDE 8). Each applies at once and is
// remembered in localStorage; nothing is sent to the Worker. The theme is Capsomer's switch,
// Light or Dark like the header's button; until one is chosen the page follows the device.
function Display() {
  const singleKeys = useSingleKeys();
  return (
    <Panel flush title="Display" src="this browser only">
      <div className="body stack-gap">
        <div className="prefrow">
          <span className="section-title">Theme</span>
          <ThemeSwitch prefKey={THEME_PREF} />
        </div>
        <div className="prefrow">
          <Switch
            id="display-single-keys"
            label="Single-key shortcuts"
            checked={singleKeys}
            onCheckedChange={setSingleKeys}
          />
          <span className="faint">
            g then a letter, j, k, r, t and the rest. Turn them off if they clash with a screen
            reader.
          </span>
        </div>
      </div>
    </Panel>
  );
}
