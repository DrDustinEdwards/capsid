// The named roles: credentials asked for by name rather than one per namespace. The admin
// mints one with capsid_admin_manage_agents action mint, passing the role's fields as
// written here (docs/auth.md, "Roles"). Tests hold the Worker's own identities to them
// (test/watcher.test.ts, test/live-gate-mcp.test.ts) and each role to one capability
// (test/roles.test.ts).

export interface Role {
  name: string;
  kind: string;
  namespaces: string[];
  // Left out, the mint derives it from the live namespace mapping.
  repos?: string[];
  grants: string[];
  flags?: Record<string, boolean>;
  tools?: string[];
  what: string;
}

// A role is ONE capability: each entry holds at most one blast-radius flag, and
// test/roles.test.ts fails the build on a second.
export const ROLES: Role[] = [
  {
    name: "auditor",
    kind: "session",
    namespaces: ["*"],
    repos: ["*"],
    grants: ["read"],
    what: "reads every namespace and every repo, writes nothing anywhere. Intended for an outside model doing a cold audit.",
  },
  {
    name: "watcher",
    kind: "cron",
    namespaces: ["*"],
    grants: ["read", "write"],
    // Same shape, same reason: posting a job is a write, and `capsid_work_jobs.post` is
    // what stops that write from also being claim, complete, fail, block and resume.
    tools: ["capsid_work_jobs", "capsid_work_jobs.post"],
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
  {
    name: "live-probe",
    kind: "cron",
    namespaces: ["capsid"],
    // The live gate's MCP call (scripts/mcp-probe-lib.mjs, gate 8): one read of
    // capsid/conventions.md after every deploy. Read grant, capsid_read_doc, no repos and no
    // flags, so a leaked key reads capsid documents and does nothing else. Its key is the
    // CAPSID_LIVE_PROBE_KEY repo secret (docs/rollback.md).
    repos: [],
    grants: ["read"],
    tools: ["capsid_read_doc"],
    what: "the live gate's probe: reads capsid documents with capsid_read_doc after each deploy, and nothing else.",
  },
  {
    name: "live-check",
    kind: "cron",
    namespaces: ["capsid"],
    // devkit's daily AI and MCP check (site-runtime-ai-audit, area 11): tools/list, the
    // conformance server scenarios and a rate-limit burst through /ops/mcp. The same
    // shape as live-probe, so a leaked key reads capsid documents and nothing else, and a
    // key of its own, so the burst's minute of 429s never lands on a deploy's live gate.
    // Its key is devkit's MCP_TEST_GRANT_MCP_DUSTINEDWARDS_INFO repo secret.
    repos: [],
    grants: ["read"],
    tools: ["capsid_read_doc"],
    what: "the daily AI and MCP check: lists the tools and reads capsid documents through /ops/mcp, and nothing else.",
  },
  {
    name: "dustinedwards-grok",
    kind: "driver",
    namespaces: ["dustinedwards"],
    grants: ["read", "write"],
    // No flags and no repos: the mint derives the repos axis from the live namespace
    // mapping, as for any driver (src/agents-admin.ts).
    what: "Grok Build's driver for dustinedwards: claims and works jobs there, the same scopes as dustinedwards-driver, and never merges.",
  },
];
