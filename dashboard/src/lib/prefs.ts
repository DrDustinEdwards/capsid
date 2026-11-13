import { useSyncExternalStore } from "react";
import { singleKeysOn } from "capsomer/behavior/shortcuts";
import { applyStoredTheme } from "capsomer/behavior/theme-switch";

// Per-viewer conveniences in localStorage, through Capsomer: the theme (theme-switch), the
// side menu (admin-shell) and single-key shortcuts (shortcuts). Blocked storage falls back to
// the default, and a choice then lasts for this page load only.

// The side menu's state: "collapsed" or "expanded". Anything else, including no value or
// storage that cannot be read, is expanded.
export const RAIL_PREF = "wf-rail";

// The theme: "light" or "dark" saved, or nothing saved, which follows the system.
export const THEME_PREF = "wf-theme";

// Run before first paint.
export function applySavedTheme(): void {
  applyStoredTheme(THEME_PREF);
}

function subscribeSingleKeys(l: () => void): () => void {
  document.addEventListener("cap-single-keys", l);
  return () => document.removeEventListener("cap-single-keys", l);
}

// Single-key shortcuts ("g" then a letter, "j", "t", ...): on unless turned off.
export function useSingleKeys(): boolean {
  // On unless turned off, and on in the server's render, which cannot read the browser's choice.
  return useSyncExternalStore(subscribeSingleKeys, singleKeysOn, () => true);
}
