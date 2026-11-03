import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

// The Portal's pages (app/ctx.ts VIEWS), each with its drawer's address over it
// (/<view>/<type>/<id>: a site, job, agent or audit row). The whole tree is served twice by the
// capsid Worker: at the root of portal.dustinedwards.info behind the sign-in, and under /demos/
// with sample data and no sign-in (src/portal-render.ts there). Ids carry the tree's name, since
// React Router needs one id per route.
const VIEWS = ["health", "prs", "queue", "activity", "agents", "packages", "library", "settings"] as const;

function pages(tree: "portal" | "demos") {
  return layout("routes/shell.tsx", { id: `${tree}-shell` }, [
    index("routes/needs.tsx", { id: `${tree}-needs` }),
    route("needs/:type/:id", "routes/needs.tsx", { id: `${tree}-needs-drawer` }),
    ...VIEWS.flatMap((v) => [route(v, `routes/${v}.tsx`, { id: `${tree}-${v}` }), route(`${v}/:type/:id`, `routes/${v}.tsx`, { id: `${tree}-${v}-drawer` })]),
  ]);
}

export default [pages("portal"), ...prefix("demos", [pages("demos")])] satisfies RouteConfig;
