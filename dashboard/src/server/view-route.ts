import type { DehydratedState } from "@tanstack/react-query";
import type { Params } from "react-router";
import type { DrawerType } from "../app/ctx";

/** A page's loader data: its reads from the server, or nothing after a move in the browser. */
export interface ViewLoaderData {
  dehydrated: DehydratedState | undefined;
}

const DRAWERS: readonly DrawerType[] = ["site", "job", "agent", "audit"];

/** The drawer an address opens over its view (/<view>/<type>/<id>), or null. */
export function drawerOf(params: Params): { type: DrawerType; id: string } | null {
  const type = params.type as DrawerType | undefined;
  return type && DRAWERS.includes(type) && params.id ? { type, id: params.id } : null;
}
