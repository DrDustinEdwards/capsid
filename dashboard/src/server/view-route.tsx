import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import type { ComponentType } from "react";
import type { LoaderFunctionArgs, Params } from "react-router";
import { DRAWER_TYPES, type DrawerType, type ViewId } from "../app/ctx";
import { prefetchView } from "./prefetch";

/** A page's loader data: its reads from the server, or nothing after a move in the browser. */
export interface ViewLoaderData {
  dehydrated: DehydratedState | undefined;
}

/** The drawer an address opens over its view (/<view>/<type>/<id>), or null. */
function drawerOf(params: Params): { type: DrawerType; id: string } | null {
  const type = params.type as DrawerType | undefined;
  return type && DRAWER_TYPES.includes(type) && params.id ? { type, id: params.id } : null;
}

// Every view's route module is these three (routes/*.tsx). The view's reads are made on the server
// for the first page (server/prefetch.ts); a move between pages in the browser reads them there
// instead (clientLoader), as the Portal always has.

/** The view's loader: its reads, prefetched on the server. */
export function viewLoader(view: ViewId) {
  return async ({ context, request, params }: LoaderFunctionArgs): Promise<ViewLoaderData> => ({
    dehydrated: await prefetchView(context, request, view, drawerOf(params), params.site ?? null),
  });
}

/** A move in the browser reads nothing on the server. */
export function browserLoader(): ViewLoaderData {
  return { dehydrated: undefined };
}

/** The view, hydrated from its loader's reads. */
export function viewPage(View: ComponentType) {
  return function Page({ loaderData }: { loaderData: ViewLoaderData }) {
    return (
      <HydrationBoundary state={loaderData.dehydrated}>
        <View />
      </HydrationBoundary>
    );
  };
}
