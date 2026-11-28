import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { AUTHORITATIVE, scanCountClaims } from "../src/counts.ts";
import { consentDialogHeaders, securityHeadersFor } from "../src/security-headers.ts";
import { MCP_HOST } from "../src/mcp-host.ts";
import { buildTruthReport, integrityOf, renderTruthReport } from "../src/truth-report.ts";

const CAPSID = AUTHORITATIVE.capsid;
// Derived from the live count, so a surface change never makes a stale fixture correct.
const TOOLS = String(CAPSID.tools);
const STALE_TOOLS = String(CAPSID.tools - 5);
const AFTER_TOOLS = String(CAPSID.tools + 3);
const GATES = CAPSID.liveGates;

// src/counts.ts caches the gate and header counts, so these two fail when the cache drifts from the artifact.

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");

test("live gate count matches the distinct gates in verify-live.mjs", () => {
  const src = read("../scripts/verify-live.mjs");
  // Gates 3 and 5 each call record() twice, once on the skipped path, so count
  // DISTINCT labels rather than call sites.
  const labels = new Set([...src.matchAll(/record\(\s*"([^"]+)"/g)].map((m) => m[1]));
  assert.equal(
    labels.size,
    CAPSID.liveGates,
    `verify-live.mjs has ${labels.size} distinct gates (${[...labels].join(", ")}) but counts.ts says ${CAPSID.liveGates}`,
  );
});

// The consent page's enforced headers: its own (src/routes.ts spreads consentDialogHeaders() into its Response) and
// what the header layer adds on the MCP host. An enforced header added to either moves the number.
const NOT_SECURITY_HEADERS = new Set(["Content-Type", "Reporting-Endpoints"]);

test("the header count matches what the header layer and the consent dialog emit", async () => {
  const names = [
    ...Object.keys(securityHeadersFor(MCP_HOST)),
    ...Object.keys(await consentDialogHeaders()),
  ];
  const enforced = new Set(
    names.filter((name) => !NOT_SECURITY_HEADERS.has(name) && !/-Report-Only$/i.test(name)),
  );
  assert.equal(
    enforced.size,
    CAPSID.htmlEnforcedHeaders,
    `the consent page enforces ${enforced.size} headers (${[...enforced].sort().join(", ")}), but counts.ts says ${CAPSID.htmlEnforcedHeaders}`,
  );
});

type Doc = { path: string; type: string; body: string };
const core = (body: string): Doc => ({ path: "core.md", type: "core", body });
const concept = (body: string): Doc => ({ path: "x.md", type: "concept", body });

test("scanCountClaims leaves history, other namespaces, subsets, years, correct totals and unrelated prose alone", () => {
  const cases: Array<[string, Doc, string?]> = [
    [
      "an episodic",
      {
        path: "session-2026-08-09.md",
        type: "episodic",
        body: "6 of 6 gates passed. The surface had 19 tools.",
      },
    ],
    ["an archived document", { path: "archive/old-core.md", type: "core", body: "16 tools." }],
    [
      "a decisions log",
      {
        path: "decisions.md",
        type: "decision",
        body: "2026-07-17: the surface went from 16 tools to 19 tools.\n\nThe server exposes 11 tools.",
      },
    ],
    ["another namespace", core("TWENTY-FOUR gates. The wrapper exposes 5 tools."), "dustinedwards"],
    ["N of M with the right total", core(`6 of ${GATES} gates passed`)],
    [
      "N of M tools with the right total",
      concept(`Gated tools (12 of ${TOOLS}), all failing with DENIED.`),
    ],
    [
      "a transition to the current count",
      core(`the surface went ${AFTER_TOOLS} to ${TOOLS} tools`),
    ],
    [
      "a year beside tool surface",
      core("The tool surface is reviewed against the 2026-07-28 spec migration."),
    ],
    ["a year beside gates", core("Reviewed in 2026, 1997 gates ran.")],
    ...[
      "The other 12 tools are read-open: list, read, brief.",
      "The remaining 12 tools are read-open.",
      "Only 12 tools are gated.",
      "Of those 12 tools, none are gated.",
    ].map((b): [string, Doc] => [`a subset: ${b}`, concept(b)]),
    ...[
      "PARITY-ROWS split seven ways. All seven written BEFORE the index cited them.",
      "buildNotificationSettingsUpdate exists with all seven fields and a passing unit test.",
      "All seven migrations were applied and the schema is reproduced.",
      "Zero pixel change on all seven, the classes moved unaltered.",
    ].map((b): [string, Doc] => [`'all seven' about something else: ${b}`, concept(b)]),
  ];
  for (const [label, doc, namespace = "capsid"] of cases)
    assert.deepEqual(scanCountClaims([doc], namespace), [], label);
});

test("scanCountClaims flags a stale count in a standing document, by the number it states", () => {
  const cases: Array<[string, Doc, string[]]> = [
    ["a stale tool count", core(`The server exposes ${STALE_TOOLS} tools today.`), [STALE_TOOLS]],
    ["N of M gates is judged on the total", core("6 of 6 gates passed"), ["6"]],
    ["a wrong N of M gates, once", core(`3 of ${GATES + 5} gates are live.`), [String(GATES + 5)]],
    [
      "N of M tools with a stale total",
      concept(`Gated tools (11 of ${AFTER_TOOLS}).`),
      [AFTER_TOOLS],
    ],
    [
      "a transition states the resulting count",
      core(`Expansion layer, tool surface 19 to ${AFTER_TOOLS}.`),
      [AFTER_TOOLS],
    ],
    ["each claim in a standing doc", core("It had 16 tools then, and 16 tools now."), ["16", "16"]],
    ["capsid's own numbers", core("The wrapper exposes 5 tools."), ["5"]],
    ["a real gate count", core("The suite has 7 gates."), ["7"]],
    [
      "'all seven' about headers",
      concept("Propose HTML gets all seven, JSON gets nosniff."),
      ["all seven"],
    ],
  ];
  for (const [label, doc, states] of cases)
    assert.deepEqual(
      scanCountClaims([doc], "capsid").map((c) => c.states),
      states,
      label,
    );

  const [stale] = scanCountClaims([core(`The server exposes ${STALE_TOOLS} tools.`)], "capsid");
  assert.equal(stale.authoritative, TOOLS);
  const [headers] = scanCountClaims(
    [concept("Propose HTML gets all seven, JSON gets nosniff.")],
    "capsid",
  );
  assert.equal(headers.authoritative, `${CAPSID.htmlEnforcedHeaders} enforced`);
  const [contradiction] = scanCountClaims(
    [concept(`Gated tools (${CAPSID.tools + 6} of ${TOOLS}).`)],
    "capsid",
  );
  assert.match(contradiction.authoritative, /cannot exceed/);
});

test("PLANT: an unmeasured integrity renders as unmeasured, never as 0%", () => {
  const report = buildTruthReport({
    namespace: "empty",
    now: new Date("2026-09-16T12:00:00Z"),
    docs: [],
    edges: [],
    danglingEdges: [],
    countClaims: [],
    repoPaths: undefined,
  });
  assert.equal(report.integrity, null);
  const body = renderTruthReport(report);
  assert.match(body, /^integrity: not measured$/m);
  assert.equal(integrityOf(body), null);
});
