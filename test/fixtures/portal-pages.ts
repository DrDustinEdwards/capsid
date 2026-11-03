// The tests' stand-in for the Portal's pages (src/portal-pages.d.ts), which the real build
// (dashboard/build/worker/portal.js) provides in a deploy. test/resolve-ts.mjs and
// vitest.config.ts resolve "capsid-portal-pages" here, so the Worker's handlers run with no
// dashboard build. A page here makes the read a real page makes first (the feed) and shows what
// it was given: the address, the read's status, and the nonce on its one script.
export async function renderPortalPage(request: Request, read: (path: string) => Promise<Response>, nonce: string): Promise<Response> {
  const feed = await read("/ops");
  const body = `<!doctype html><title>Capsid Portal</title><p data-path="${new URL(request.url).pathname}" data-read="${feed.status}">page</p><script nonce="${nonce}" src="/assets/app-abc123.js"></script>`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function renderDemoPage(request: Request, file: (path: string) => Promise<Response>, nonce: string): Promise<Response> {
  const feed = await file("/demos/api/ops.json");
  const body = `<!doctype html><title>Capsid Portal demo</title><p data-path="${new URL(request.url).pathname}" data-read="${feed.status}">demo</p><script nonce="${nonce}" src="/assets/app-abc123.js"></script>`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
