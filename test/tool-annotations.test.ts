import assert from "node:assert/strict";
import { test } from "node:test";
import { hintsFor, TOOL_HINTS } from "../src/tool-annotations.ts";
import { operationBlocks, sourceFile, sourceFiles, type ToolBlock } from "./source-files.ts";
import { servedOperations } from "./served.ts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildAdminServer, buildServer } from "../src/server.ts";
import { adminAgentForEmail, grantAgent, type Agent } from "../src/agents.ts";
import { toolListProblems } from "@dustinedwards/site-runtime/mcp-server";
import { fakeEnv, fakeKv } from "./fakes.ts";

// A wrong annotation is worse than a missing one: `readOnlyHint: true` on a tool that writes tells a client it need not
// ask. Every scan fails in both directions and carries a count guard, so "0 disagreed" cannot mean "0 read".

// A tool is write-gated iff some action needs more than the read grant (TOOL_GRANTS and TOOL_ACTION_GRANTS;
// test/invariants.test.ts proves those tables against the operations).
const SERVED = servedOperations();
const READ_ONLY = ["read", "admin_read"];
const isWriteGated = (tool: string) =>
  SERVED.some((s) => s.tool === tool && !READ_ONLY.includes(s.requirement));

const BLOCKS = new Map(operationBlocks().map((b) => [b.name, b]));
function toolOps(tool: string, opts: { except?: Record<string, string> } = {}): ToolBlock[] {
  return SERVED.filter(
    (s) => s.tool === tool && !Object.hasOwn(opts.except ?? {}, `${s.tool}.${s.action}`),
  )
    .map((s) => BLOCKS.get(s.op))
    .filter((b): b is ToolBlock => b !== undefined);
}
const TOOLS = [...new Set(SERVED.map((s) => s.tool))];

// Destructive iff the handler can overwrite or remove existing state, matched by what it does, not its name, so the next deleting tool is caught.
const DESTRUCTIVE = [
  /INSERT INTO documents/i, // an overwrite goes through the same insert as a create
  /\bdocumentUpsert\(/,
  /\bpathMutation\(/,
  /UPDATE namespaces/i,
  /\bdeleteRepoFile\(/,
  /\bdeleteBranch\(/,
  /\bmanagePr\(/,
  /\bwriteRepoFile\(/,
  // The credential control plane's two overwriting entry points (revoke,
  // update_scopes); the statements live in src/agents-admin.ts.
  /\brevokeAgent\(/,
  /\bupdateAgentScopes\(/,
  // delete_namespace's perform; its batch deletes each document through pathMutation
  // in src/namespace-delete.ts.
  /\bperformNamespaceDelete\(/,
  // The controls' perform: it can revoke an agent or remove a site, through
  // the mutators src/controls-perform.ts calls.
  /\bperformControl\(/,
];

const matches = (body: string, res: RegExp[]) => res.some((re) => re.test(body));

// Tool actions that run an operation the scan reads as destructive, and are not, with
// the reason. None today.
const NOT_DESTRUCTIVE: Record<string, string> = {};

const destructiveTool = (tool: string) =>
  isWriteGated(tool) &&
  toolOps(tool, { except: NOT_DESTRUCTIVE }).some((b) => matches(b.body, DESTRUCTIVE));

type ServedTool = { name: string; annotations?: Record<string, unknown>; [field: string]: unknown };
async function servedTools(
  caller: Agent = adminAgentForEmail("admin@example.com"),
  builds = [buildServer, buildAdminServer],
): Promise<ServedTool[]> {
  const out: ServedTool[] = [];
  for (const build of builds) {
    const server = build(fakeEnv({ APP_KV: fakeKv({}).kv }), caller);
    const client = new Client({ name: "tool-annotations", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    out.push(...tools);
  }
  return out;
}

async function servedAnnotations(): Promise<Map<string, Record<string, unknown> | undefined>> {
  return new Map(
    (await servedTools()).map((t) => [
      t.name,
      t.annotations as Record<string, unknown> | undefined,
    ]),
  );
}

// The live check wants every input object closed and every tool a read grant lists to be read-only.
test("PLANT: the served tool lists pass the family's tools/list check, and a read grant lists only read-only tools", async () => {
  const errors = toolListProblems(await servedTools()).filter((p) => p.severity === "error");
  assert.deepEqual(
    errors.map((p) => `${p.item} ${p.tool}: ${p.detail}`),
    [],
  );
  const read = await servedTools(grantAgent("read", "opkey:readonly0000"), [buildServer]);
  assert.ok(
    read.some((t) => t.name === "capsid_lint_namespace"),
    "a read grant is no longer served capsid_lint_namespace, so this checks less than it says",
  );
  assert.deepEqual(
    toolListProblems(read)
      .filter((p) => p.severity === "error")
      .map((p) => `${p.item} ${p.tool}: ${p.detail}`),
    [],
  );
  assert.deepEqual(
    read.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name),
    [],
    "a read grant lists a tool that is not read-only (T7)",
  );
});

test("PLANT: every served tool carries exactly its hint table entry, and the table names only served tools", async () => {
  const served = await servedAnnotations();
  assert.ok(served.size > 0, "the server served no tools");
  assert.deepEqual(
    [...served.keys()].sort(),
    Object.keys(TOOL_HINTS).sort(),
    "a tool without an entry, or an entry without a tool, fails here",
  );
  const differs = [...served]
    .filter(([name, hints]) => JSON.stringify(hints) !== JSON.stringify(TOOL_HINTS[name]))
    .map(([name]) => name);
  assert.deepEqual(
    differs,
    [],
    `these tools serve annotations that are not their table entry: ${differs.join(", ")}`,
  );
});

test("PLANT: the served readOnlyHint is exactly the negation of the write gate", async () => {
  const served = await servedAnnotations();
  const gated = [...served.keys()].filter(isWriteGated);
  // Vacuity: both sides of the rule are populated, or it is comparing nothing.
  assert.ok(
    gated.length > 0 && gated.length < served.size,
    `the write gate splits ${served.size} tools into ${gated.length} gated`,
  );
  const wrong = [...served]
    .filter(([name, hints]) => hints?.readOnlyHint !== !isWriteGated(name))
    .map(
      ([name, hints]) =>
        `${name}: write-gated=${isWriteGated(name)} but readOnlyHint=${hints?.readOnlyHint}`,
    );
  assert.deepEqual(wrong, [], wrong.join("; "));
});

// Destructive comes from the handler source, because repo, queue, admin and agent tools overwrite through modules this file cannot observe; the five document mutators are also checked by name below.
test("PLANT: every mutating tool is served with destructiveHint true", async () => {
  const served = await servedAnnotations();
  const mutating = TOOLS.filter(destructiveTool);
  assert.ok(
    mutating.length >= 7,
    `the destructive scan found only ${mutating.length} mutating tools; it is broken`,
  );
  const understated = mutating.filter((name) => served.get(name)?.destructiveHint !== true);
  assert.deepEqual(
    understated,
    [],
    `these tools can overwrite or remove and do not say so: ${understated.join(", ")}`,
  );
  for (const tool of ["capsid_write_doc", "capsid_delete_doc", "capsid_lint_namespace"]) {
    assert.equal(
      served.get(tool)?.destructiveHint,
      true,
      `${tool} overwrites or removes a document and is not served as destructive`,
    );
  }
});

test("PLANT: no read-only tool is served as destructive, and no additive tool overstates", async () => {
  const served = await servedAnnotations();
  const overstated = TOOLS.filter((name) => !destructiveTool(name)).filter(
    (name) => served.get(name)?.destructiveHint === true,
  );
  assert.deepEqual(
    overstated,
    [],
    `these tools claim to be destructive and mutate nothing: ${overstated.join(", ")}`,
  );
  for (const [name, hints] of served) {
    if (hints?.readOnlyHint)
      assert.equal(hints.destructiveHint, false, `${name} is read-only and cannot be destructive`);
  }
});

test("an unknown tool fails CLOSED rather than claiming to be safe", () => {
  const unknown = hintsFor("a_tool_that_does_not_exist");
  assert.equal(
    unknown.readOnlyHint,
    false,
    "a tool with no entry must not be advertised as read-only",
  );
  assert.equal(unknown.destructiveHint, true);
  assert.equal(
    unknown.idempotentHint,
    false,
    "a tool with no entry must not be advertised as safe to repeat",
  );
  assert.equal(
    unknown.openWorldHint,
    true,
    "a tool with no entry must not be advertised as closed world",
  );
  // A name on the prototype chain must not resolve to an entry.
  const constructorLookup = hintsFor("constructor");
  assert.equal(typeof constructorLookup, "object");
  assert.equal(constructorLookup.readOnlyHint, false);
  assert.equal(constructorLookup.destructiveHint, true);
  assert.equal(constructorLookup.idempotentHint, false);
  assert.equal(constructorLookup.openWorldHint, true);
});

// The protocol reads an omitted idempotentHint as false and openWorldHint as true; a default is not a decision, so every entry states both.

test("PLANT: every hint table entry states idempotent and openWorld explicitly", () => {
  const text = sourceFile("tool-annotations.ts");
  const start = text.indexOf("export const TOOL_HINTS");
  assert.ok(start !== -1, "TOOL_HINTS was not found in src/tool-annotations.ts");
  const table = text.slice(start, text.indexOf("\n};", start));
  const entries = [...table.matchAll(/^\s+([a-z_]+): (read|additive|destructive)\(([^)]*)\),$/gm)];
  // Vacuity: the parse found every entry, or an unparsed entry would pass unread.
  assert.equal(
    entries.length,
    Object.keys(TOOL_HINTS).length,
    `parsed ${entries.length} entries from the source, the table has ${Object.keys(TOOL_HINTS).length}`,
  );
  const unstated = entries
    .filter(
      ([, , , args]) =>
        !/\bidempotent: (true|false)\b/.test(args) || !/\bopenWorld: (true|false)\b/.test(args),
    )
    .map(([, name]) => name);
  assert.deepEqual(
    unstated,
    [],
    `these entries leave idempotent or openWorld to a default: ${unstated.join(", ")}`,
  );
});

test("PLANT: every read-only tool is served as idempotent", async () => {
  const served = await servedAnnotations();
  const readOnly = [...served].filter(([, hints]) => hints?.readOnlyHint === true);
  // Eight of the 22: find, read, start a session, read and inspect a repo, and the three
  // admin reads.
  assert.ok(
    readOnly.length >= 6,
    `only ${readOnly.length} read-only tools served; the split is broken`,
  );
  const wrong = readOnly
    .filter(([, hints]) => hints?.idempotentHint !== true)
    .map(([name]) => name);
  assert.deepEqual(
    wrong,
    [],
    `these read-only tools are not served as idempotent: ${wrong.join(", ")}`,
  );
});

// openWorldHint: true iff the handler reaches GitHub or Cloudflare, scanned DIRECT: a block is open world when it calls a name its
// own file imports from src/github* or src/ops-cloudflare*. A transitive scan disagreed with the table twice.

const OUTSIDE_MODULE = /^(?:\.\.?\/)+(?:github(?:\/[\w-]+)?|ops-cloudflare(?:-config)?)$/;

// Exports of those modules that never leave the Worker. Each is checked below to
// be defined there and to contain no fetch, so an entry cannot outlive its reason.
const NOT_NETWORK: Record<string, string> = {
  parseReposList: "parses the repos argument register_namespace and update_namespace take",
  requireSinglePrimary: "checks a parsed repos list for exactly one primary",
  resolveRepo: "reads the namespaces table in D1",
};

// Operations that reach GitHub, Cloudflare or a site through another module: `via` is the call and `evidence` where that module makes the request, so a stale entry fails.
const OPEN_WORLD_THROUGH: Record<
  string,
  { reason: string; via: RegExp; evidence: Array<{ file: string; pattern: RegExp }> }
> = {
  whats_next: {
    reason: "reads every mapped repo's open pull requests, their check runs and their mergeability",
    via: /\bwhatsNext\(/,
    evidence: [{ file: "whats-next.ts", pattern: /\bghFetch\(/ }],
  },
  workers_builds: {
    reason: "reads the account's Worker scripts and a Worker's builds from the Cloudflare API",
    via: /\blistBuilds\(/,
    evidence: [{ file: "workers-builds.ts", pattern: /\bcfGet\(/ }],
  },
  site_backups: {
    reason: "reads each site's backup state live through its operator API",
    via: /\breadSiteBackups\(/,
    evidence: [
      { file: "site-backup.ts", pattern: /\bcallOperator\(/ },
      { file: "site-operator.ts", pattern: /\boperatorCall\(/ },
    ],
  },
  workers_build_logs: {
    reason: "reads a build's log from the Cloudflare API",
    via: /\bbuildLogs\(/,
    evidence: [{ file: "workers-builds.ts", pattern: /\bcfGet\(/ }],
  },
  controls: {
    reason:
      "perform closes a pull request on GitHub and runs a site repair or a backup through the site's operator API",
    via: /\bperformControl\(/,
    evidence: [
      { file: "controls-perform.ts", pattern: /\bmanagePr\(/ },
      { file: "controls-perform-sites.ts", pattern: /\brunSiteRepair\(/ },
      { file: "controls-perform-sites.ts", pattern: /\brunSiteBackups\(/ },
      { file: "site-repair.ts", pattern: /\bcallOperator\(/ },
      { file: "site-operator.ts", pattern: /\boperatorCall\(/ },
    ],
  },
  site_check: {
    reason: "fetches the site's health route, a page and the 401 probe path",
    via: /\bsiteCheck\(/,
    evidence: [{ file: "site-check.ts", pattern: /\bfetchImpl\(/ }],
  },
  search_console: {
    reason: "reads the site's Search Console data from Google's API",
    via: /\bsearchConsole\(/,
    evidence: [{ file: "search-console.ts", pattern: /\bfetchImpl\(/ }],
  },
  bing_webmaster: {
    reason: "reads the site's Bing Webmaster Tools data from Bing's API",
    via: /\bbingWebmaster\(/,
    evidence: [{ file: "bing-webmaster.ts", pattern: /\bfetchImpl\(/ }],
  },
  site_traffic: {
    reason: "reads the site's request record from Cloudflare's SQL API",
    via: /\bsiteTraffic\(/,
    evidence: [{ file: "site-traffic.ts", pattern: /\bfetchImpl\(/ }],
  },
  site_audit: {
    reason: "crawls the site's sitemap pages and their links",
    via: /\bsiteAudit\(/,
    evidence: [{ file: "site-audit.ts", pattern: /\bfetchImpl\(/ }],
  },
};

function outsideImports(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    if (m[1] || !OUTSIDE_MODULE.test(m[3])) continue;
    for (const spec of m[2].split(",")) {
      const s = spec.trim();
      if (!s || s.startsWith("type ")) continue;
      const local = s.split(/\s+as\s+/).pop() ?? s;
      if (!Object.hasOwn(NOT_NETWORK, local)) names.add(local);
    }
  }
  return names;
}

function callsOutsideDirectly(block: { body: string; file: string }): boolean {
  const names = outsideImports(sourceFile(block.file));
  return [...names].some((n) => new RegExp(`\\b${n}\\(`).test(block.body));
}

test("PLANT: openWorldHint is served true exactly for the tools that reach GitHub or Cloudflare", async () => {
  const served = await servedAnnotations();
  const blocks = [...BLOCKS.values()];
  const direct = blocks.filter(callsOutsideDirectly).map((b) => b.name);
  // Vacuity: the repo operations and lint call GitHub directly.
  assert.ok(
    direct.length >= 10,
    `the direct scan found only ${direct.length} open-world operations; it is broken`,
  );
  const openOps = new Set([...direct, ...Object.keys(OPEN_WORLD_THROUGH)]);
  const expected = new Set(SERVED.filter((s) => openOps.has(s.op)).map((s) => s.tool));
  const understated = [...served]
    .filter(([name, h]) => expected.has(name) && h?.openWorldHint !== true)
    .map(([n]) => n);
  const overstated = [...served]
    .filter(([name, h]) => !expected.has(name) && h?.openWorldHint !== false)
    .map(([n]) => n);
  assert.deepEqual(
    understated,
    [],
    `these tools reach GitHub or Cloudflare and are not served as open world: ${understated.join(", ")}`,
  );
  assert.deepEqual(
    overstated,
    [],
    `these tools reach neither and are not served as closed world: ${overstated.join(", ")}`,
  );
  assert.ok(
    expected.size < served.size,
    "every tool is open world, so the closed side of the rule is untested",
  );
});

test("PLANT: each open-world override is still needed and still true", () => {
  const blocks = BLOCKS;
  for (const [tool, { reason, via, evidence }] of Object.entries(OPEN_WORLD_THROUGH)) {
    const block = blocks.get(tool);
    assert.ok(block, `${tool} is an override with no operation`);
    assert.equal(
      callsOutsideDirectly(block),
      false,
      `${tool} now calls GitHub directly; drop its override (${reason})`,
    );
    assert.match(
      block.body,
      via,
      `${tool} no longer makes the call its override names (${reason})`,
    );
    for (const { file, pattern } of evidence) {
      assert.match(
        sourceFile(file),
        pattern,
        `src/${file} no longer shows ${pattern}, so the ${tool} override's reason is stale (${reason})`,
      );
    }
  }
});

test("PLANT: every name exempted as not network is defined in an outside module and makes no fetch", () => {
  const files = sourceFiles().filter((f) =>
    /^(?:github(?:\/[\w-]+)?|ops-cloudflare)\.ts$/.test(f.name),
  );
  assert.ok(
    files.length >= 2,
    `found ${files.length} github or ops-cloudflare modules; the walk is broken`,
  );
  for (const [name, reason] of Object.entries(NOT_NETWORK)) {
    const home = files.find((f) =>
      new RegExp(`^export (?:async )?function ${name}\\(`, "m").test(f.text),
    );
    assert.ok(
      home,
      `${name} is exempted (${reason}) but no github or ops-cloudflare module defines it`,
    );
    const start = home.text.search(new RegExp(`^export (?:async )?function ${name}\\(`, "m"));
    const end = home.text.indexOf("\n}\n", start);
    const body = home.text.slice(start, end === -1 ? undefined : end);
    assert.doesNotMatch(
      body,
      /\b(?:fetch|ghFetch|cfGet)\(/,
      `${name} is exempted as not network (${reason}) and now makes a request`,
    );
  }
});

// idempotentHint for writes: one reason per tool; every tool behind the write gate is here and the served hint must match.
const WRITE_IDEMPOTENCE: Record<string, { idempotent: boolean; reason: string }> = {
  capsid_write_doc: {
    idempotent: false,
    reason:
      "append adds again, every overwrite snapshots a new version, and each restore snapshots the live body first",
  },
  capsid_delete_doc: {
    idempotent: true,
    reason: "a repeat finds nothing to delete and is refused",
  },
  capsid_lint_namespace: {
    idempotent: false,
    reason: "a second report the same day snapshots the first",
  },
  capsid_close_pr: {
    idempotent: false,
    reason: "a merge or close of a reopened pull request is not a no-op",
  },
  capsid_admin_manage_namespaces: {
    idempotent: false,
    reason: "register creates one on every call it is not refused",
  },
  capsid_admin_manage_agents: {
    idempotent: false,
    reason: "mint issues a new credential on every call",
  },
  capsid_admin_run_controls: {
    idempotent: false,
    reason:
      "a perform spends its single-use token, so a repeat of the same call is refused rather than repeated",
  },
};

// What creates something new on every call. An audit_log row records a call, not state the tool acts on, so it is left out.
const NEW_EACH_CALL = [
  /\bciDispatch\(/,
  /\bopenPr\(/,
  /\bwriteRepoFile\(/,
  /\bmanagePr\(/,
  /\bmintAgent\(/,
  // A namespaces row, written in src/namespace-admin.ts since the Portal's namespace_add shares it.
  /\bregisterNamespace\(/,
];

const insertsFresh = (body: string) =>
  [...body.matchAll(/INSERT INTO\s+(\w+)[^`"]*/g)].some(
    (m) => m[1] !== "audit_log" && !/ON CONFLICT/i.test(m[0]),
  );

test("PLANT: every write-gated tool has an idempotence entry with a reason, and is served with it", async () => {
  const served = await servedAnnotations();
  const gated = [...served.keys()].filter(isWriteGated).sort();
  assert.deepEqual(
    Object.keys(WRITE_IDEMPOTENCE).sort(),
    gated,
    "a write-gated tool without an entry, or an entry for a tool that is not write-gated, fails here",
  );
  const wrong = gated
    .filter((name) => served.get(name)?.idempotentHint !== WRITE_IDEMPOTENCE[name].idempotent)
    .map(
      (name) =>
        `${name}: served ${served.get(name)?.idempotentHint}, table ${WRITE_IDEMPOTENCE[name].idempotent} (${WRITE_IDEMPOTENCE[name].reason})`,
    );
  assert.deepEqual(wrong, [], wrong.join("; "));
  for (const [name, { reason }] of Object.entries(WRITE_IDEMPOTENCE))
    assert.ok(reason.trim().length > 0, `${name} has no reason`);
});

test("PLANT: no tool that creates something new on every call is served as idempotent", async () => {
  const served = await servedAnnotations();
  const creators = TOOLS.filter((tool) =>
    toolOps(tool).some((b) => matches(b.body, NEW_EACH_CALL) || insertsFresh(b.body)),
  );
  assert.ok(
    creators.length >= 3,
    `the scan found only ${creators.length} tools that create on every call; it is broken`,
  );
  const overstated = creators.filter((name) => served.get(name)?.idempotentHint !== false);
  assert.deepEqual(
    overstated,
    [],
    `these tools create something on every call and claim to be idempotent: ${overstated.join(", ")}`,
  );
});
