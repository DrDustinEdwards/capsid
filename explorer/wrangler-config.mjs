// Prints the explorer's Wrangler config, which the deploy writes to a temporary file and passes
// with --config. Generated, not committed (CLAUDE.md, public repo rule), though it holds no id or
// secret: static assets with a Worker (worker.mjs) only for paths with no file, and no binding but
// the assets, so nothing to keep out of the repo.
//
//   node explorer/wrangler-config.mjs <assets directory> [--local]
//
// --local leaves the custom domain out, for `wrangler dev`.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [directory, flag] = process.argv.slice(2);
if (!directory) throw new Error("usage: node explorer/wrangler-config.mjs <assets directory> [--local]");
const config = {
  name: "capsid",
  // The Worker is a few lines a compatibility date barely touches. This is a date the workerd
  // in capsid's pinned wrangler runs (it stops at 2026-07-08), so `wrangler dev` (the browser
  // spec) serves the same config that deploys.
  compatibility_date: "2026-07-01",
  main: join(dirname(fileURLToPath(import.meta.url)), "worker.mjs"),
  assets: {
    directory: resolve(directory),
    binding: "ASSETS",
    // Any address with no file reaches worker.mjs, which sends dist/404.html with its charset;
    // /s/x is /s/x/ (src/pages.mjs writes index.html).
    not_found_handling: "none",
    html_handling: "auto-trailing-slash",
  },
  workers_dev: false,
  ...(flag === "--local" ? {} : { routes: [{ pattern: "capsid.dustinedwards.info", custom_domain: true }] }),
};
process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
