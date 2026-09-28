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

export type Theme = "light" | "dark";

export function currentTheme(): Theme {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "light" || t === "dark") return t;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applySavedTheme(): void {
  const saved = readPref("wf-theme");
  if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  writePref("wf-theme", next);
  return next;
}
