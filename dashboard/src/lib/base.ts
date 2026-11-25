import { pageBase } from "./router";

export const BASE = typeof window === "undefined" ? "" : pageBase(window.location.pathname);
