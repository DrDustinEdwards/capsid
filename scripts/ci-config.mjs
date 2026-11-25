#!/usr/bin/env node
// Reconstructs wrangler.jsonc on a CI runner, where a checkout carries only the example. Never run locally: it would overwrite a developer's real, gitignored config.
// Resolve by name, verify by id, fail closed on disagreement: a rename, duplicate or second account would otherwise rebind the Worker to the wrong data with a green deploy.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { APP_KV, D1, GITHUB_APP_CLIENT_ID, OAUTH_KV, R2 } from "./bindings.mjs";

const EXPECTED = {
  d1: D1,
  appKv: APP_KV,
  oauthKv: OAUTH_KV,
  r2: R2,
  githubAppClientId: GITHUB_APP_CLIENT_ID,
};

// Refuse outside CI (GitHub Actions sets CI=true): this writes the real gitignored config on a developer machine. The escape hatch is explicit and named.
if (
  process.env.CI !== "true" &&
  process.env.CI_CONFIG_ALLOW_LOCAL !== "i-know-this-overwrites-wrangler-jsonc"
) {
  console.error(
    "ci-config: refusing to run outside CI. This overwrites wrangler.jsonc, which on this machine is your real config.\n" +
      "If you genuinely mean to, set CI_CONFIG_ALLOW_LOCAL=i-know-this-overwrites-wrangler-jsonc.",
  );
  process.exit(1);
}

function wrangler(args) {
  try {
    return execFileSync("npx", ["--no-install", "wrangler", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
  } catch (err) {
    die(`wrangler ${args.join(" ")} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

function die(message) {
  console.error(`ci-config: ${message}`);
  process.exit(1);
}

// wrangler prints a preamble before JSON on some commands, so take the first well-formed JSON array.
function parseJsonArray(text, label) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1)
    die(`could not find a JSON array in the ${label} listing. Output was:\n${text}`);
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) die(`${label} listing did not parse to an array`);
    return parsed;
  } catch (err) {
    die(`could not parse the ${label} listing: ${err.message}`);
  }
}

function resolveUnique(list, label, matches) {
  const hits = list.filter(matches);
  if (hits.length === 0) die(`no ${label} matched. Nothing was deployed.`);
  if (hits.length > 1) {
    die(`${hits.length} ${label} entries matched, which is ambiguous. Nothing was deployed.`);
  }
  return hits[0];
}

function assertId(label, actual, expected) {
  if (actual !== expected) {
    die(
      `${label} RESOLVED TO THE WRONG ID.\n` +
        `  expected: ${expected}\n` +
        `  resolved: ${actual}\n` +
        `A name now points at a different resource. This is the failure mode the pin exists to catch: ` +
        `deploying would have bound this Worker to the wrong data. Nothing was deployed.`,
    );
  }
  console.log(`ci-config: ${label} ok, name resolved to the pinned id ${expected}`);
}

const d1List = parseJsonArray(wrangler(["d1", "list", "--json"]), "D1");
const d1 = resolveUnique(
  d1List,
  `D1 database named "${EXPECTED.d1.name}"`,
  (d) => d.name === EXPECTED.d1.name,
);
assertId("D1 capsid", d1.uuid ?? d1.id, EXPECTED.d1.id);

const kvList = parseJsonArray(wrangler(["kv", "namespace", "list"]), "KV");
const appKv = resolveUnique(
  kvList,
  `KV namespace titled "${EXPECTED.appKv.name}"`,
  (n) => n.title === EXPECTED.appKv.name,
);
assertId(`KV ${EXPECTED.appKv.name} (APP_KV)`, appKv.id, EXPECTED.appKv.id);
// Either title while the namespace is renamed in place from "capsid-oauth" to "capsid-mcp-oauth".
const OAUTH_KV_TITLES = [EXPECTED.oauthKv.name, "capsid-oauth"];
const oauthKv = resolveUnique(
  kvList,
  `KV namespace titled "${OAUTH_KV_TITLES.join('" or "')}"`,
  (n) => OAUTH_KV_TITLES.includes(n.title),
);
assertId(`KV ${EXPECTED.oauthKv.name} (OAUTH_KV)`, oauthKv.id, EXPECTED.oauthKv.id);
// If these two resolve to the same id, the Worker's caches are back in the provider's keyspace and nothing else would say so.
if (appKv.id === oauthKv.id) {
  die(
    `APP_KV and OAUTH_KV resolved to the SAME namespace id (${appKv.id}). The 2026-08-15 split has been undone. Nothing was deployed.`,
  );
}

// R2 is asserted against the committed config, not the account: a binding carries only a literal bucket name, so the pin must be set and not a placeholder (a missing bucket fails `wrangler deploy`).
// The deploy token needs Workers R2 Storage Edit: wrangler checks R2 permission for new bindings and fails with Authentication error 10000 without it.
if (!EXPECTED.r2.name || EXPECTED.r2.name.startsWith("YOUR_")) {
  die("the R2 MEDIA bucket pin is unset or still a placeholder. Nothing was deployed.");
}
console.log(
  `ci-config: R2 MEDIA ${EXPECTED.r2.name} pinned by name, existence is enforced by the deploy step`,
);

let config = readFileSync("wrangler.jsonc.example", "utf8");
const substitutions = [
  ["YOUR_D1_ID", EXPECTED.d1.id],
  ["YOUR_APP_KV_ID", EXPECTED.appKv.id],
  ["YOUR_OAUTH_KV_ID", EXPECTED.oauthKv.id],
  ["YOUR_R2_BUCKET", EXPECTED.r2.name],
  ["YOUR_GITHUB_APP_CLIENT_ID", EXPECTED.githubAppClientId],
];
for (const [placeholder, value] of substitutions) {
  if (!config.includes(placeholder)) {
    die(
      `wrangler.jsonc.example no longer contains the placeholder ${placeholder}. The example and this script have drifted; fix both together.`,
    );
  }
  config = config.split(placeholder).join(value);
}

// Catch-all: a surviving placeholder is a binding this script does not know, and deploying would send a literal "YOUR_..." to Cloudflare.
const leftover = config.match(/YOUR_[A-Z0-9_]+/g);
if (leftover) {
  die(
    `unsubstituted placeholders remain: ${[...new Set(leftover)].join(", ")}. The example gained a binding this script does not handle. Nothing was deployed.`,
  );
}

writeFileSync("wrangler.jsonc", config, "utf8");
console.log(
  "ci-config: wrote wrangler.jsonc with every binding resolved by name and verified by id",
);
