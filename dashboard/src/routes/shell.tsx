import { HydrationBoundary } from "@tanstack/react-query";
import type { LoaderFunctionArgs } from "react-router";
import { App } from "../app/App";
import { ErrorBoundary as Failed } from "../app/ErrorBoundary";
import { prefetchFeed } from "../server/prefetch";
import type { ViewLoaderData } from "../server/view-route";

export async function loader({ context, request }: LoaderFunctionArgs): Promise<ViewLoaderData> {
  return { dehydrated: await prefetchFeed(context, request) };
}

export function clientLoader(): ViewLoaderData {
  return { dehydrated: undefined };
}

export function shouldRevalidate() {
  return false;
}

export default function Shell({ loaderData }: { loaderData: ViewLoaderData }) {
  return (
    <HydrationBoundary state={loaderData.dehydrated}>
      <Failed>
        <App />
      </Failed>
    </HydrationBoundary>
  );
}
