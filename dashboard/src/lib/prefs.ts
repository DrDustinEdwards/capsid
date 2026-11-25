import { useSyncExternalStore } from "react";
import { singleKeysOn } from "capsomer/behavior/shortcuts";
import { applyStoredTheme } from "capsomer/behavior/theme-switch";

export const RAIL_PREF = "wf-rail";

export const THEME_PREF = "wf-theme";

export function applySavedTheme(): void {
  applyStoredTheme(THEME_PREF);
}

function subscribeSingleKeys(l: () => void): () => void {
  document.addEventListener("cap-single-keys", l);
  return () => document.removeEventListener("cap-single-keys", l);
}

export function useSingleKeys(): boolean {
  // On in the server's render, which cannot read the browser's choice.
  return useSyncExternalStore(subscribeSingleKeys, singleKeysOn, () => true);
}
