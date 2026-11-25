import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import type { ComponentType } from "react";
import type { LoaderFunctionArgs, Params } from "react-router";
import { DRAWER_TYPES, type DrawerType, type ViewId } from "../app/ctx";
import { prefetchView } from "./prefetch";

export interface ViewLoaderData {
  dehydrated: DehydratedState | undefined;
}

function drawerOf(params: Params): { type: DrawerType; id: string } | null {
  const type = params.type as DrawerType | undefined;
  return type && DRAWER_TYPES.includes(type) && params.id ? { type, id: params.id } : null;
}

export function viewLoader(view: ViewId) {
  return async ({ context, request, params }: LoaderFunctionArgs): Promise<ViewLoaderData> => ({
    dehydrated: await prefetchView(context, request, view, drawerOf(params), params.site ?? null),
  });
}

export function browserLoader(): ViewLoaderData {
  return { dehydrated: undefined };
}

export function viewPage(View: ComponentType) {
  return function Page({ loaderData }: { loaderData: ViewLoaderData }) {
    return (
      <HydrationBoundary state={loaderData.dehydrated}>
        <View />
      </HydrationBoundary>
    );
  };
}
