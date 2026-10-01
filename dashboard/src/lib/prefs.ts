import { useSyncExternalStore } from "react";

// Per-viewer conveniences in localStorage. Storage can be blocked (private windows,
// cleared site data); a failed read falls back to the default and a failed write
// leaves the choice for this page load only. Both are reported to the console.

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    console.warn(`Watch Floor: could not read ${key} from localStorage`, e);
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn(`Watch Floor: could not save ${key} to localStorage`, e);
  }
}

export function removePref(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    console.warn(`Watch Floor: could not remove ${key} from localStorage`, e);
  }
}

// The side menu's state: "collapsed" or "expanded". Anything else, including no value or
// storage that cannot be read, is expanded.
export const RAIL_PREF = "wf-rail";

// The theme: "light" or "dark" saved, or nothing saved, which follows the system
// (prefers-color-scheme). The choice is the data-theme attribute on <html>; with none,
// tokens.css follows the system.
export const THEME_PREF = "wf-theme";
export type Theme = "light" | "dark";
export type ThemeChoice = "system" | Theme;

// Listeners for the display preferences, so the top bar, the shortcut sheet and
// Settings show the same state whichever of them changed it.
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

export function themeChoice(): ThemeChoice {
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" || t === "dark" ? t : "system";
}

export function currentTheme(): Theme {
  const t = themeChoice();
  if (t !== "system") return t;
  return systemDark() ? "dark" : "light";
}

export function applySavedTheme(): void {
  const saved = readPref(THEME_PREF);
  if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
}

/** System removes the saved choice and the attribute, so prefers-color-scheme applies. */
export function setThemeChoice(choice: ThemeChoice): void {
  if (choice === "system") {
    document.documentElement.removeAttribute("data-theme");
    removePref(THEME_PREF);
  } else {
    document.documentElement.setAttribute("data-theme", choice);
    writePref(THEME_PREF, choice);
  }
  emit();
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  setThemeChoice(next);
  return next;
}

function subscribeTheme(l: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", l);
  const off = subscribe(l);
  return () => (mq.removeEventListener("change", l), off());
}

/** The saved choice (system, light or dark), kept current. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribeTheme, themeChoice);
}

/** Whether dark is in effect, from a saved choice or from the system. */
export function useDarkTheme(): boolean {
  return useSyncExternalStore(subscribeTheme, () => currentTheme() === "dark");
}

// Single-key shortcuts ("g" then a letter, "j", "t", ...): on unless turned off. Held
// in memory too, so a failed write still holds for this page load.
export const SINGLE_KEYS_PREF = "wf-single-keys";
let singleKeys: boolean | null = null;

export function singleKeysOn(): boolean {
  if (singleKeys === null) singleKeys = readPref(SINGLE_KEYS_PREF) !== "off";
  return singleKeys;
}

export function setSingleKeys(on: boolean): void {
  singleKeys = on;
  writePref(SINGLE_KEYS_PREF, on ? "on" : "off");
  emit();
}

export function useSingleKeys(): boolean {
  return useSyncExternalStore(subscribe, singleKeysOn);
}
