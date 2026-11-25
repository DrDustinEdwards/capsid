// A wrangler.jsonc for `wrangler deploy --dry-run`, built offline: `npm run types` generates worker-configuration.d.ts from it, because the real file is gitignored and CI holds no credential for ci-config.mjs.
// Not ci-config.mjs: nothing is resolved or verified; pinned ids just replace the example's placeholders. Never use it to deploy: it writes wrangler.dryrun.jsonc (named with --config) so a developer's real wrangler.jsonc is not overwritten.

import { readFileSync, writeFileSync } from "node:fs";
import { APP_KV, D1, GITHUB_APP_CLIENT_ID, OAUTH_KV, R2 } from "./bindings.mjs";

const OUT = "wrangler.dryrun.jsonc";

const example = readFileSync("wrangler.jsonc.example", "utf8");

// Each placeholder and the pinned value it stands for; every substitution is asserted so a renamed placeholder fails loudly.
const SUBSTITUTIONS = [
  ["YOUR_D1_ID", D1.id],
  ["YOUR_APP_KV_ID", APP_KV.id],
  ["YOUR_OAUTH_KV_ID", OAUTH_KV.id],
  ["YOUR_R2_BUCKET", R2.name],
  ["YOUR_GITHUB_APP_CLIENT_ID", GITHUB_APP_CLIENT_ID],
];

let config = example;
for (const [placeholder, value] of SUBSTITUTIONS) {
  if (!config.includes(placeholder)) {
    console.error(
      `dry-run-config: wrangler.jsonc.example no longer contains the placeholder ${placeholder}. ` +
        `Either it was renamed or the binding was removed; fix this script rather than shipping a config with a hole in it.`,
    );
    process.exit(1);
  }
  config = config.split(placeholder).join(value);
}

// Remove the dashboard assets block: the dry run measures the Worker bundle and the build job builds no dashboard. A missing marker fails loudly.
const ASSETS = /\n[ \t]*\/\/ ASSETS-BEGIN\n[\s\S]*?\n[ \t]*\/\/ ASSETS-END\n/;
if (!ASSETS.test(config)) {
  console.error(
    "dry-run-config: wrangler.jsonc.example has no ASSETS-BEGIN / ASSETS-END block to remove; fix this script and the example together.",
  );
  process.exit(1);
}
config = config.replace(ASSETS, "\n");

// No placeholder may survive: a dry run tolerates a wrong id, so a leftover would be invisible.
const leftover = config.match(/YOUR_[A-Z0-9_]+/g);
if (leftover) {
  console.error(
    `dry-run-config: unsubstituted placeholders remain: ${[...new Set(leftover)].join(", ")}`,
  );
  process.exit(1);
}

writeFileSync(OUT, config);
console.log(
  `dry-run-config: wrote ${OUT} from wrangler.jsonc.example with ${SUBSTITUTIONS.length} pinned values, no network, no secrets`,
);
