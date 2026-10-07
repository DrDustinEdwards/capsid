import type { AdminApp } from "capsomer/react/admin-shell";
import { BrandMark } from "../ui/icons";
import { createElement } from "react";

// The strip's apps. Badge data is not fetched here: Capsid will supply one "what needs the owner"
// answer per app, and each entry takes `count` (or `dot`) from it. Until then no app shows a badge.
// Hosts are the family's own (<name>.dustinedwards.info, rulings rule 16); an app whose host is
// not settled yet is left out rather than guessed.
export const APPS: AdminApp[] = [
  { id: "portal", label: "Capsid Portal", href: "./", logo: createElement(BrandMark), current: true },
  { id: "carrel", label: "Carrel", href: "https://carrel.dustinedwards.info/", mono: "C" },
  { id: "info", label: "dustinedwards.info", href: "https://dustinedwards.info/admin", mono: "D" },
];
