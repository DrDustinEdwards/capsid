// Mint the agents docs/bootstrap.md describes and write each key to
// ~/.capsid/agent-<name>.key, mode 0600.
//
// The key is printed NOWHERE. It goes from the mint response straight to the
// file, and this script reports the name and a 12-hex fingerprint of the digest,
// so a key never lands in terminal scrollback or a CI log.
//
//   CAPSID_OPERATOR_KEY=... node scripts/mint-agents.mjs                    # dry run, all six
//   CAPSID_OPERATOR_KEY=... node scripts/mint-agents.mjs --apply
//   CAPSID_OPERATOR_KEY=... node scripts/mint-agents.mjs --namespace foxing --apply
//   node scripts/mint-agents.mjs --roles                                  # print the role mint commands
//   CAPSID_OPERATOR_KEY=... node scripts/mint-agents.mjs --role auditor --apply
//
// --namespace mints one project's agent. An existing key file is SKIPPED rather than
// overwritten, so the full run stays safe to repeat.
//
// A LOST KEY CANNOT BE REPLACED BY RE-RUNNING THIS. An agent name is unique forever,
// revoked names included, because it is the audit identity. Replacing a key is:
// revoke the old agent with the agents tool, then mint under a new name.
//
// --namespace takes any namespace registered in Capsid, not just one in the improve
// roster that AGENTS is built from. For an unlisted one the script asks the
// `namespaces` tool whether it is registered and synthesizes a driver (driverFor).
// Registration is the authority, so a typo still refuses.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { capsidClient } from "./capsid-rpc.mjs";

export const ORIGIN_DEFAULT = "https://capsid.dustin-edwards.workers.dev";

// The six of docs/bootstrap.md. Drivers carry NO flags: a driver opens pull
// requests and a human merges them, and can_merge is how that stops being true.
export const AGENTS = [
  { name: "capsid-driver",        kind: "driver", namespaces: ["capsid"],        grants: ["read", "write"] },
  { name: "dustinedwards-driver", kind: "driver", namespaces: ["dustinedwards"], grants: ["read", "write"] },
  { name: "foxhound-driver",      kind: "driver", namespaces: ["foxhound"],      grants: ["read", "write"] },
  { name: "foxing-driver",        kind: "driver", namespaces: ["foxing"],        grants: ["read", "write"] },
  { name: "germomics-driver",     kind: "driver", namespaces: ["germomics"],     grants: ["read", "write"] },
  { name: "seat",                 kind: "seat",   namespaces: ["*"],             grants: ["read", "write"], flags: { can_merge: true } },
];

// ---- named roles ----------------------------------------------------------------
//
// A role is asked for by name, not selected by namespace, and three of the four are
// scoped to every namespace, so folding them into AGENTS would make
// `--namespace dustinedwards` mint a credential holding can_merge.
//
// A role is ONE capability: each entry holds at most one blast-radius flag, and
// test/roles.test.ts fails the build on a second.
export const ROLES = [
  {
    name: "auditor",
    kind: "session",
    namespaces: ["*"],
    repos: ["*"],
    grants: ["read"],
    what: "reads every namespace and every repo, writes nothing anywhere. Intended for an outside model doing a cold audit.",
  },
  {
    name: "reviewer",
    kind: "session",
    namespaces: ["*"],
    repos: ["*"],
    grants: ["read", "write"],
    // A comment goes through manage_pr, a write tool. The tools axis narrows it to the
    // comment action and the only flag is can_comment_pr, so merge and close are refused.
    tools: ["manage_pr", "manage_pr.comment"],
    flags: { can_comment_pr: true },
    what: "reads everything and may post a comment on a pull request. It cannot merge, close, or write a file.",
  },
  {
    name: "watcher",
    kind: "cron",
    namespaces: ["*"],
    grants: ["read", "write"],
    // Same shape, same reason: posting a job is a write, and `jobs.post` is what
    // stops that write from also being claim, complete, fail, block and resume.
    tools: ["jobs", "jobs.post"],
    // NO REPOS, matching watcherAgent() in src/watcher.ts, so the minted credential
    // and the identity the Worker uses are the same authority. The tools axis already
    // refuses every repo tool.
    repos: [],
    what: "reads health, status and CI, and posts a job when it finds something wrong. It cannot claim or finish one, and it cannot fix anything.",
  },
  {
    name: "site-seat",
    kind: "seat",
    namespaces: ["dustinedwards"],
    repos: ["*"],
    grants: ["read", "write"],
    // Repos stays "*": the namespace-to-repo mapping is already the authorization
    // boundary (README, Repo access), and a second list here would drift from it.
    flags: { can_merge: true },
    what: "merges pull requests in dustinedwards and nothing else. No direct write, no workflows, no protected paths.",
  },
];

// What an admin pastes. It names the role rather than restating its scopes, so it
// cannot drift from ROLES.
export function roleMintCommand(role) {
  return `CAPSID_OPERATOR_KEY=$CAPSID_OPERATOR_KEY node scripts/mint-agents.mjs --role ${role.name} --apply`;
}

export const keyDir = () => join(homedir(), ".capsid");
export const keyPath = (name) => join(keyDir(), `agent-${name}.key`);
export const fingerprint = (key) => createHash("sha256").update(key).digest("hex").slice(0, 12);

// A driver for a namespace that has no entry in AGENTS, the same shape as the five
// above: read and write on its own namespace, and NO FLAGS.
export function driverFor(namespace) {
  return { name: `${namespace}-driver`, kind: "driver", namespaces: [namespace], grants: ["read", "write"] };
}

// Selection is its own function so the test can drive it without a network or a
// home directory. An unknown namespace is REFUSED rather than silently matching
// nothing.
//
// The improve roster (AGENTS) is not the list of namespaces. A namespace not in
// AGENTS is minted a driver on the strength of being REGISTERED; `registered` is
// passed in rather than fetched so this stays pure. With no `registered`, only
// AGENTS matches, so a failed lookup refuses instead of inventing a namespace.
export function selectAgents(namespace, registered, role) {
  // The role selector is checked first and never falls through: an unknown role
  // refuses rather than returning the whole bootstrap list.
  if (role !== undefined) {
    const picked = ROLES.find((r) => r.name === role);
    if (!picked) throw new Error(`no role named '${role}'. Known roles: ${ROLES.map((r) => r.name).join(", ")}.`);
    return [picked];
  }
  if (namespace === undefined) return AGENTS;
  const picked = AGENTS.filter((a) => a.namespaces.includes(namespace));
  if (picked.length > 0) return picked;
  if (registered?.includes(namespace)) return [driverFor(namespace)];
  const known = [...new Set(AGENTS.flatMap((a) => a.namespaces))].join(", ");
  const also = registered?.length ? ` Registered in Capsid: ${[...registered].sort().join(", ")}.` : "";
  throw new Error(`no agent is scoped to '${namespace}'. Known: ${known}.${also}`);
}

export function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const i = argv.indexOf("--namespace");
  if (i !== -1 && !argv[i + 1]) throw new Error("--namespace needs a value, for example --namespace foxing.");
  const r = argv.indexOf("--role");
  if (r !== -1 && !argv[r + 1]) throw new Error(`--role needs a value, one of: ${ROLES.map((x) => x.name).join(", ")}.`);
  if (i !== -1 && r !== -1) throw new Error("--namespace and --role select different things; pass one or the other.");
  return {
    apply,
    namespace: i === -1 ? undefined : argv[i + 1],
    role: r === -1 ? undefined : argv[r + 1],
    roles: argv.includes("--roles"),
  };
}

// The `namespaces` tool answers with a bare array of rows keyed on `namespace`.
// Parsed in its own function so the test drives the real response shape rather
// than a shape this script hopes for.
function namespaceRows(text) {
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error(`the namespaces tool did not answer with JSON. Raw: ${text.slice(0, 300)}`);
  }
  if (!Array.isArray(rows)) throw new Error(`the namespaces tool answered with ${typeof rows}, not an array.`);
  return rows;
}

export function parseNamespaces(text) {
  const rows = namespaceRows(text);
  const names = rows.map((r) => r?.namespace).filter((n) => typeof n === "string" && n.length > 0);
  // Vacuity guard. An empty list here would make every --namespace refuse, which
  // reads as "not registered" when it actually means "the shape changed".
  if (names.length === 0) throw new Error("the namespaces tool returned no namespaces; its response shape changed.");
  return names;
}

// THE REPOS AXIS IS DERIVED FROM THE MAPPING, NEVER RETYPED HERE. An omitted axis
// mints as the "*" wildcard, which can never refuse; a driver scoped to its own repos
// is refused on any other even if the mapping is later edited. Read from the
// `namespaces` response rather than a table in this file, so the two cannot disagree.
export function parseNamespaceRepos(text) {
  const rows = namespaceRows(text);
  const map = new Map();
  for (const row of rows) {
    if (typeof row?.namespace !== "string" || !row.namespace) continue;
    let repos = row.repos;
    if (typeof repos === "string") {
      try {
        repos = JSON.parse(repos);
      } catch {
        repos = [];
      }
    }
    const names = Array.isArray(repos)
      ? repos.map((r) => r?.repo).filter((r) => typeof r === "string" && r.length > 0)
      : [];
    map.set(row.namespace, names);
  }
  if (map.size === 0) throw new Error("the namespaces tool returned no namespaces; its response shape changed.");
  return map;
}

// The repos a driver for this namespace may reach. REFUSES rather than falling back
// to the wildcard, so a driver is never minted wide by accident.
export function reposForNamespace(map, namespace) {
  const repos = map.get(namespace);
  if (!repos || repos.length === 0) {
    throw new Error(
      `namespace '${namespace}' maps to no repos, so its driver's repos axis cannot be derived. ` +
        `Map it first with update_namespace (admin only), then mint. Refusing rather than minting with the "*" wildcard.`
    );
  }
  return repos;
}

/**
 * Mint one agent into one key file.
 *
 * THE FILE IS CREATED BEFORE THE MINT, so a mint never succeeds into a file that
 * cannot be written (a live credential nothing can present, under a name that can
 * never be minted again). Opening with "wx" proves the directory is writable and the
 * file is absent, atomically; a mint that fails removes the empty file. The key is
 * never printed.
 * @param {(name: string, args: object) => Promise<string>} tool
 * @param {{ name: string, what?: string }} agent
 * @param {string} path
 * @returns {Promise<string>} the report line
 */
export async function mintInto(tool, agent, path) {
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST") return `${agent.name}: SKIPPED, ${path} already exists`;
    throw new Error(`${agent.name}: cannot create ${path} (${/** @type {Error} */ (err).message}). Nothing was minted.`);
  }
  let minted;
  try {
    // `what` is documentation, not a scope axis, so it does not go over the wire.
    const { what: _what, ...scopes } = agent;
    const text = await tool("agents", { action: "mint", ...scopes });
    try {
      minted = JSON.parse(text).key;
    } catch {
      throw new Error(`${agent.name}: could not parse the mint response. Raw: ${text.slice(0, 300)}`);
    }
    if (!minted) throw new Error(`${agent.name}: the mint response carried no key. Raw: ${text.slice(0, 300)}`);
  } catch (err) {
    closeSync(fd);
    unlinkSync(path);
    throw err;
  }
  try {
    writeSync(fd, minted + "\n");
  } finally {
    closeSync(fd);
  }
  return `${agent.name}: written to ${path}  fingerprint ${fingerprint(minted)}`;
}

async function main() {
  const { apply, namespace, role, roles } = parseArgs(process.argv.slice(2));
  const origin = process.env.CAPSID_ORIGIN ?? ORIGIN_DEFAULT;

  // --roles prints and stops before the key check: printing a command needs no
  // credential.
  if (roles) {
    console.log("Named roles. Each is minted by the admin, one command each:");
    console.log("");
    for (const r of ROLES) {
      console.log(`  ${r.name}: ${r.what}`);
      console.log(`    ${roleMintCommand(r)}`);
      console.log("");
    }
    return;
  }

  const key = process.env.CAPSID_OPERATOR_KEY;
  if (!key) {
    console.error("CAPSID_OPERATOR_KEY is not set. It is your write-grant operator key; this script never reads a file for it.");
    process.exit(2);
  }
  // Refuses a non-https origin before any request carries the key.
  const client = capsidClient(origin, key, "mint-agents");

  // Resolve before branching on --apply, so a dry run against a non-roster
  // namespace says whether it would mint. The network is touched only when AGENTS
  // cannot answer.
  let wanted;
  if (role !== undefined) {
    wanted = selectAgents(undefined, undefined, role);
  } else if (namespace !== undefined && !AGENTS.some((a) => a.namespaces.includes(namespace))) {
    wanted = selectAgents(namespace, parseNamespaces(await client.tool("namespaces", {})));
  } else {
    wanted = selectAgents(namespace);
  }

  // The repos axis, attached from the live mapping before anything is minted or
  // printed (see parseNamespaceRepos). A dry run therefore needs the network: it
  // reports the repos axis too.
  const needsRepos = wanted.filter((a) => a.kind === "driver" && a.repos === undefined);
  if (needsRepos.length > 0) {
    const mapping = parseNamespaceRepos(await client.tool("namespaces", {}));
    for (const a of needsRepos) {
      // One namespace per driver, which selectAgents and driverFor both guarantee.
      a.repos = reposForNamespace(mapping, a.namespaces[0]);
    }
  }

  if (!apply) {
    console.log(`dry run. Would mint ${wanted.length} agent(s) and write keys into ${keyDir()}:`);
    for (const a of wanted) {
      const path = keyPath(a.name);
      const state = existsSync(path) ? "SKIP, file exists" : `-> ${path}`;
      const repos = a.repos === undefined ? "*" : a.repos.join(",");
      console.log(`  ${a.name.padEnd(22)} ${a.kind.padEnd(7)} ns=${a.namespaces.join(",").padEnd(14)} repos=${repos.padEnd(34)} ${state}`);
    }
    console.log("\nRe-run with --apply to mint.");
    return;
  }

  mkdirSync(keyDir(), { recursive: true, mode: 0o700 });

  // Never overwrite: mintInto skips an existing file.
  for (const a of wanted) {
    console.log(await mintInto(client.tool, a, keyPath(a.name)));
  }
}

if (process.argv[1] && process.argv[1].endsWith("mint-agents.mjs")) {
  main().catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(1);
  });
}
