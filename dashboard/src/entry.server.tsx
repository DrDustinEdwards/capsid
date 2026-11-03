import { prerender } from "react-dom/static";
import { ServerRouter, type EntryContext, type RouterContextProvider } from "react-router";
import { nonceFor } from "./server/prefetch";

// The Workers runtime's render. React's prerender, not renderToReadableStream: it waits for the
// whole tree, its lazy charts and panels included, and writes each in place, so the HTML a reader
// with scripts off receives holds every table, chart and number, not a fallback with the content
// in a hidden block for a script to swap in. The result hydrates like any server render. The
// Portal is behind a sign-in and never shared-cached, so the wait costs one reader one render.
// React writes no inline script of its own here; React Router's carry the nonce (root.tsx).
export default async function handleRequest(request: Request, status: number, headers: Headers, routerContext: EntryContext, loadContext: RouterContextProvider) {
  const nonce = nonceFor(loadContext);
  let failed = false;
  const { prelude } = await prerender(<ServerRouter context={routerContext} url={request.url} nonce={nonce} />, {
    signal: request.signal,
    // React writes a large finished boundary out of place, after the shell, for a script to move
    // in (its progressive chunks). One chunk, so every part is in place.
    progressiveChunkSize: Number.POSITIVE_INFINITY,
    onError(error: unknown) {
      failed = true;
      console.error("Capsid Portal: render failed", error);
    },
  });
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(prelude, { headers, status: failed && status < 400 ? 500 : status });
}
