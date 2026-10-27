// Prints the explorer's Wrangler config, which the deploy writes to a temporary file and passes
// with --config. Generated, not committed (CLAUDE.md, public repo rule), though it holds no id or
// secret: an assets-only Worker, so no script, no bindings, nothing to keep out of the repo.
//
//   node explorer/wrangler-config.mjs <assets directory> [--local]
//
// --local leaves the custom domain out, for `wrangler dev`.
import { resolve } from "node:path";

const [directory, flag] = process.argv.slice(2);
if (!directory) throw new Error("usage: node explorer/wrangler-config.mjs <assets directory> [--local]");
const config = {
  name: "capsid",
  // An assets-only Worker runs no code a compatibility date changes. This is a date the workerd
  // in capsid's pinned wrangler runs (it stops at 2026-07-08), so `wrangler dev` (the browser
  // spec) serves the same config that deploys.
  compatibility_date: "2026-07-01",
  assets: {
    directory: resolve(directory),
    // dist/404.html for any address with no page; /s/x is /s/x/ (src/pages.mjs writes index.html).
    not_found_handling: "404-page",
    html_handling: "auto-trailing-slash",
  },
  workers_dev: false,
  ...(flag === "--local" ? {} : { routes: [{ pattern: "capsid.dustinedwards.info", custom_domain: true }] }),
};
process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
