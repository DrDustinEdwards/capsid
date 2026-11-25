import { Suspense, lazy } from "react";
import { Switch } from "capsomer/react/switch";
import { ThemeSwitch } from "capsomer/react/theme-switch";
import { setSingleKeys } from "capsomer/behavior/shortcuts";
import { THEME_PREF, useSingleKeys } from "../lib/prefs";
import { Panel } from "capsomer/react/panel";
import "capsomer/segmented.css";
import "capsomer/switch.css";
import "./Settings.css";
import { PageHead } from "./shared";

const Automation = lazy(() => import("./Automation").then((m) => ({ default: m.Automation })));
const PhoneAlerts = lazy(() => import("./PhoneAlerts").then((m) => ({ default: m.PhoneAlerts })));

export function Settings() {
  return (
    <div className="cap-admin-page">
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

function Display() {
  const singleKeys = useSingleKeys();
  return (
    <Panel flush title="Display" src="this browser only">
      <div className="body cap-stack" data-gap="4">
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
          <span className="cap-text" data-tone="dim">
            Turn off if they clash with a screen reader.
          </span>
        </div>
      </div>
    </Panel>
  );
}
