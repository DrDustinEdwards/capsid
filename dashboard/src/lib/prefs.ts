import { useSyncExternalStore } from "react";
import { readPref, writePref } from "capsomer/behavior/shell";
import { SINGLE_KEYS_PREF, setSingleKeys, singleKeysOn } from "capsomer/behavior/shortcuts";
import { applyStoredTheme, toggleTheme as toggleCapTheme, type ThemeChoice } from "capsomer/behavior/theme-switch";

// Per-viewer conveniences in localStorage, through Capsomer: the theme (theme-switch), the
// side menu (admin-shell) and single-key shortcuts (shortcuts). Blocked storage falls back to
// the default, and a choice then lasts for this page load only.
export { readPref, writePref, setSingleKeys };

// The side menu's state: "collapsed" or "expanded". Anything else, including no value or
// storage that cannot be read, is expanded.
export const RAIL_PREF = "wf-rail";

// The theme: "light" or "dark" saved, or nothing saved, which follows the system.
export const THEME_PREF = "wf-theme";

// Before Capsomer's shortcut registry the Portal kept single keys under its own key. An "off"
// saved there is carried over once, so nobody who turned them off finds them on again.
const OLD_SINGLE_KEYS_PREF = "wf-single-keys";

// Run before first paint.
export function applySavedTheme(): void {
  applyStoredTheme(THEME_PREF);
  if (readPref(OLD_SINGLE_KEYS_PREF) === "off" && readPref(SINGLE_KEYS_PREF) === null) setSingleKeys(false);
}

export function toggleTheme(): ThemeChoice {
  return toggleCapTheme(THEME_PREF);
}

function subscribeSingleKeys(l: () => void): () => void {
  document.addEventListener("cap-single-keys", l);
  return () => document.removeEventListener("cap-single-keys", l);
}

// Single-key shortcuts ("g" then a letter, "j", "t", ...): on unless turned off.
export function useSingleKeys(): boolean {
  return useSyncExternalStore(subscribeSingleKeys, singleKeysOn);
}
