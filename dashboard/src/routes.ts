import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

// Ids carry the tree's name, since React Router needs one id per route.
const VIEWS = ["health", "prs", "projects", "agents", "packages", "memory", "settings"] as const;

function pages(tree: "portal" | "demos") {
  return layout("routes/shell.tsx", { id: `${tree}-shell` }, [
    index("routes/board.tsx", { id: `${tree}-board` }),
    route("board/:type/:id", "routes/board.tsx", { id: `${tree}-board-drawer` }),
    route("sites", "routes/sites.tsx", { id: `${tree}-sites` }),
    route("sites/:site", "routes/site.tsx", { id: `${tree}-site` }),
    route("sites/:site/:type/:id", "routes/site.tsx", { id: `${tree}-site-drawer` }),
    ...VIEWS.flatMap((v) => [
      route(v, `routes/${v}.tsx`, { id: `${tree}-${v}` }),
      route(`${v}/:type/:id`, `routes/${v}.tsx`, { id: `${tree}-${v}-drawer` }),
    ]),
  ]);
}

export default [pages("portal"), ...prefix("demos", [pages("demos")])] satisfies RouteConfig;
