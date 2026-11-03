import { HydrationBoundary } from "@tanstack/react-query";
import type { LoaderFunctionArgs } from "react-router";
import { drawerOf, type ViewLoaderData } from "../server/view-route";
import { prefetchView } from "../server/prefetch";
import { PullRequests } from "../views/Ci";

// The view's reads are made on the server for the first page (server/prefetch.ts); a move
// between pages in the browser reads them there instead (clientLoader), as the Portal always has.
export async function loader({ context, request, params }: LoaderFunctionArgs): Promise<ViewLoaderData> {
  return { dehydrated: await prefetchView(context, request, "prs", drawerOf(params)) };
}

export function clientLoader(): ViewLoaderData {
  return { dehydrated: undefined };
}

export default function Page({ loaderData }: { loaderData: ViewLoaderData }) {
  return (
    <HydrationBoundary state={loaderData.dehydrated}>
      <PullRequests />
    </HydrationBoundary>
  );
}
