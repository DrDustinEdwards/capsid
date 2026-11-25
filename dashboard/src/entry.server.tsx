import { prerender } from "react-dom/static";
import { ServerRouter, type EntryContext, type RouterContextProvider } from "react-router";
import { nonceFor } from "./server/prefetch";

// React Router prints every route error, so each scanner 404 wrote a stack trace; a route 404 is counted, not logged.
export { handleServerError as handleError } from "@dustinedwards/site-runtime/log";

// React's prerender, not renderToReadableStream: it waits for the whole tree, so the HTML a reader with scripts off gets holds every chart and table, not a fallback for a script to swap in.
export default async function handleRequest(
  request: Request,
  status: number,
  headers: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  const nonce = nonceFor(loadContext);
  let failed = false;
  const { prelude } = await prerender(
    <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
    {
      signal: request.signal,
      // One chunk, so every part is in place: React otherwise writes a large finished boundary out of place for a script to move in.
      progressiveChunkSize: Number.POSITIVE_INFINITY,
      onError(error: unknown) {
        failed = true;
        console.error("Capsid Portal: render failed", error);
      },
    },
  );
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(prelude, { headers, status: failed && status < 400 ? 500 : status });
}
