import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { AUTHORITATIVE, scanCountClaims } from "../src/counts.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { adminAgent } from "../src/agents.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

const CAPSID = AUTHORITATIVE.capsid;
import { CONSENT_DIALOG_HEADERS, securityHeadersFor } from "../src/headers.ts";
// Fixtures derive the tool count rather than spelling it, so a surface change does
// not break tests that check something else.
const TOOLS = String(CAPSID.tools);
// Deliberately not the current count, for the stale-claim fixtures. Derived, so it
// can never accidentally become correct.
const STALE_TOOLS = String(CAPSID.tools - 5);


// src/counts.ts caches numbers that live elsewhere, so these tests derive each one
// from the artifact itself and fail when the two drift.

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");

// The tool count is a property of the served surface, not of one file: counting
// registrations in server.ts alone would miss a tool registered from another module.

test("tools count matches the tools the server serves", async () => {
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgent("DrDustinEdwards"));
  const client = new Client({ name: "counts", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  assert.ok(tools.length > 0, "the server serves no tools; the listing is broken");
  assert.equal(tools.length, CAPSID.tools, `the server serves ${tools.length} tools and counts.ts says ${CAPSID.tools}`);
});

test("live gate count matches the distinct gates in verify-live.mjs", () => {
  const src = read("../scripts/verify-live.mjs");
  // Gates 3 and 5 each call record() twice, once on the skipped path, so count
  // DISTINCT labels rather than call sites.
  const labels = new Set([...src.matchAll(/record\(\s*"([^"]+)"/g)].map((m) => m[1]));
  assert.equal(
    labels.size,
    CAPSID.liveGates,
    `verify-live.mjs has ${labels.size} distinct gates (${[...labels].join(", ")}) but counts.ts says ${CAPSID.liveGates}`
  );
});

// The HTML surface's enforced headers come from two places, and the count is the
// union of both: src/headers.ts emits most of them, and the consent dialog in
// src/routes.ts sets its own enforced CSP, which withSecurityHeaders preserves. An
// enforced header added to either file moves the number.
const NOT_SECURITY_HEADERS = new Set(["Content-Type", "Set-Cookie", "Location", "Reporting-Endpoints"]);
const isEnforcedSecurityHeader = (name: string) =>
  !NOT_SECURITY_HEADERS.has(name) && !/-Report-Only$/i.test(name);

// The header names the consent dialog sets on its own Response. CONSENT_DIALOG_HEADERS
// is the object routes.ts spreads into that Response, so it is read directly rather
// than parsed out of routes.ts; the per-request Set-Cookie is not a security header.
const consentDialogHeaders = (): string[] => Object.keys(CONSENT_DIALOG_HEADERS);

test("header counts match what the header layer and the consent dialog actually emit", () => {
  const html = securityHeadersFor("html");
  const fromLayer = Object.keys(html).filter(isEnforcedSecurityHeader);
  const fromConsent = consentDialogHeaders().filter(isEnforcedSecurityHeader);
  const enforced = new Set([...fromLayer, ...fromConsent]);
  assert.equal(
    enforced.size,
    CAPSID.htmlEnforcedHeaders,
    `the HTML surface enforces ${enforced.size} headers (${[...enforced].sort().join(", ")}): ` +
      `${fromLayer.length} from src/headers.ts and ${fromConsent.length} from the consent dialog, ` +
      `but counts.ts says ${CAPSID.htmlEnforcedHeaders}`
  );
  // The consent CSP is the one the layer does not emit, and why this count needs two sources.
  assert.ok(fromConsent.includes("Content-Security-Policy"), "the consent dialog no longer sets its own enforced CSP");
  assert.equal(fromLayer.includes("Content-Security-Policy"), false, "the header layer now enforces a CSP on HTML too; this derivation still holds but the ruling that kept them separate does not");

  const reportOnly = Object.keys(html).filter((k) => /-Report-Only$/i.test(k));
  assert.equal(reportOnly.length, CAPSID.htmlReportOnlyHeaders);
});

test("scan flags a stale tool count in a standing doc", () => {
  const claims = scanCountClaims([
    { path: "core.md", type: "core", body: `The server exposes ${STALE_TOOLS} tools today.` },
  ], "capsid");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].noun, "tools");
  assert.equal(claims[0].states, STALE_TOOLS);
  assert.equal(claims[0].authoritative, TOOLS);
});

test("scan does NOT flag a correct count", () => {
  assert.deepEqual(
    scanCountClaims([{ path: "core.md", type: "core", body: `${TOOLS} tools, split 13 read and 11 write.` }], "capsid"),
    []
  );
});

test("episodics are exempt because their numbers are history, not claims", () => {
  // A session doc saying "6 of 6 gates passed" is an accurate record of a run.
  // Flagging it would bury the real findings in noise.
  const claims = scanCountClaims([
    { path: "session-2026-08-09.md", type: "episodic", body: "6 of 6 gates passed. The surface had 19 tools." },
  ], "capsid");
  assert.deepEqual(claims, []);
});

test("archived documents are exempt", () => {
  const claims = scanCountClaims([{ path: "archive/old-core.md", type: "core", body: "16 tools." }], "capsid");
  assert.deepEqual(claims, []);
});

// A closed decision volume quotes counts as they stood on the day, so they are stale
// by construction. This asserts the path exemption, which survives a volume written
// with the wrong type; the fixture uses a linted type so that without the path guard
// it flags.
test("the numbered decision volumes are exempt, by path and not only by type", () => {
  const stale = String(CAPSID.tools - 5);
  for (const type of ["reference", "core", "concept"]) {
    assert.deepEqual(
      scanCountClaims([{ path: "decisions-vol-1.md", type, body: `The surface was ${stale} tools then.` }], "capsid"),
      [],
      `decisions-vol-1.md typed ${type} was linted`,
    );
  }
  assert.deepEqual(
    scanCountClaims([{ path: "decisions-vol-12.md", type: "reference", body: `${stale} tools.` }], "capsid"),
    [],
  );
  // The guard is anchored: a document that merely starts the same way is still linted.
  const near = scanCountClaims([{ path: "decisions-vol-notes.md", type: "core", body: `${stale} tools.` }], "capsid");
  assert.equal(near.length, 1, "decisions-vol-notes.md is not a volume and must still be linted");
});

test("the 'N of M gates' form is judged on the TOTAL, not the numerator", () => {
  // "6 of 8 gates" states the artifact has 8 gates, which is correct, and that 6
  // passed, which is a run result and none of this lint's business.
  // The total is derived from counts.ts, so adding a gate does not break this test.
  const total = CAPSID.liveGates;
  assert.deepEqual(scanCountClaims([{ path: "core.md", type: "core", body: `6 of ${total} gates passed` }], "capsid"), []);
  const stale = scanCountClaims([{ path: "core.md", type: "core", body: "6 of 6 gates passed" }], "capsid");
  assert.equal(stale.length, 1);
  assert.equal(stale[0].states, "6");
  assert.equal(stale[0].authoritative, String(total));
});

test("'all seven' is flagged when it is about headers", () => {
  const claims = scanCountClaims([
    { path: "security-headers.md", type: "concept", body: "Propose HTML gets all seven, JSON gets nosniff." },
  ], "capsid");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].noun, "security headers");
  assert.match(claims[0].authoritative, /6 enforced plus 1 Report-Only/);
});

test("'all seven' about anything else is NOT flagged", () => {
  // "all seven" is common prose about other things; an unscoped match flags them all.
  const decoys = [
    "PARITY-ROWS split seven ways. All seven written BEFORE the index cited them.",
    "buildNotificationSettingsUpdate exists with all seven fields and a passing unit test.",
    "All seven migrations were applied and the schema is reproduced.",
    "Zero pixel change on all seven, the classes moved unaltered.",
  ];
  for (const body of decoys) {
    assert.deepEqual(scanCountClaims([{ path: "parity/notes.md", type: "reference", body }], "capsid"), [], `false positive on: ${body}`);
  }
});

test("the scan never returns a rewritten body, only a flag", () => {
  // Flag, never auto-correct: a "corrected" or "replacement" field would be a program
  // editing canon on its own judgement.
  const claims = scanCountClaims([{ path: "core.md", type: "core", body: "19 tools" }], "capsid");
  // Exactly one claim, or the loop below passes without checking anything.
  assert.equal(claims.length, 1, `expected one claim for a stale tool count: ${JSON.stringify(claims)}`);
  for (const c of claims) {
    assert.deepEqual(
      Object.keys(c).sort().filter((k) => !["path", "type", "noun", "quote", "states", "authoritative", "note"].includes(k)),
      []
    );
  }
});

// False-positive classes. Each is a regression test: a lint with a high
// false-positive rate gets turned off.

test("a namespace with no authoritative numbers gets NO claims", () => {
  // Other namespaces have their own gate suites and tool counts; comparing them
  // against capsid's numbers is meaningless.
  const docs = [
    { path: "core.md", type: "core", body: "TWENTY-FOUR gates, MINIMUM_GATES 24. check:head covers 20 gates in extraction." },
    { path: "operator-mcp-wrapper.md", type: "concept", body: "The wrapper exposes 5 tools." },
  ];
  assert.deepEqual(scanCountClaims(docs, "dustinedwards"), []);
  assert.deepEqual(scanCountClaims(docs, "recova"), []);
  // The same prose IS capsid's business when it is capsid's document.
  assert.ok(scanCountClaims(docs, "capsid").length > 0, "capsid's own numbers must still be checked");
});

test("a decisions log is EXEMPT outright: it is history by construction", () => {
  // A ruling log states what was true on a date, never what is true now.
  const log = {
    path: "decisions.md",
    type: "decision",
    body: [
      "2026-07-17: the surface went from 16 tools to 19 tools.",
      "2026-07-18: Expansion layer, tool surface 19 to 22.",
      "core.md said 19 tools when server.ts registers 22.",
      "The server exposes 11 tools.",
    ].join("\n\n"),
  };
  assert.deepEqual(scanCountClaims([log], "capsid"), [], "a decision doc produced claims");
});

test("every claim is checked in a document that is not an append-only log", () => {
  // The exemption is keyed on type `decision` and must not leak to core or concept
  // docs, which state current fact throughout.
  const doc = { path: "core.md", type: "core", body: "It had 19 tools then, and 19 tools now." };
  assert.equal(scanCountClaims([doc], "capsid").length, 2);
});

test("a four-digit year is never a tool count", () => {
  // `tool surface[^.\n]*?\b(\d+)\b` would otherwise match the year in a date.
  const doc = { path: "core.md", type: "core", body: "The tool surface is reviewed against the 2026-07-28 spec migration." };
  assert.deepEqual(scanCountClaims([doc], "capsid"), []);
  // The same exclusion applies to the gate patterns.
  const gates = { path: "core.md", type: "core", body: "Reviewed in 2026, 1997 gates ran." };
  assert.deepEqual(scanCountClaims([gates], "capsid"), []);
  // A real count in the same shape still fires.
  const real = { path: "core.md", type: "core", body: "The suite has 7 gates." };
  assert.deepEqual(scanCountClaims([real], "capsid").map((c) => c.states), ["7"]);
});

test("the one genuine hit still fires after all three fixes", () => {
  // A true positive must survive the false-positive fixes.
  const doc = { path: "concept-build-operations.md", type: "concept", body: "The server exposes 11 tools over MCP." };
  const claims = scanCountClaims([doc], "capsid");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].states, "11");
  assert.equal(claims[0].authoritative, TOOLS);
});

test("a transition states the RESULTING count, not the pre-state", () => {
  // "19 to 22" says the surface stopped being 19.
  const doc = { path: "core.md", type: "core", body: "Expansion layer, tool surface 19 to 22 (links, brief, ci_status)." };
  const claims = scanCountClaims([doc], "capsid");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].states, "22", "the pre-state was reported instead of the resulting state");

  // And when the resulting state is current, nothing fires.
  assert.deepEqual(scanCountClaims([{ ...doc, body: `the surface went 22 to ${TOOLS} tools` }], "capsid"), []);
});

test("a transition in a LIVE-STATE doc reports the resulting count", () => {
  const doc = { path: "core.md", type: "core", body: "Expansion layer, tool surface 19 to 22." };
  const claims = scanCountClaims([doc], "capsid");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].states, "22");
});

test("a subset count is not a total", () => {
  const doc = { path: "concept-build-operations.md", type: "concept", body: "The other 12 tools are read-open: list, read, brief." };
  assert.deepEqual(scanCountClaims([doc], "capsid"), []);
  for (const phrase of ["The remaining 12 tools are read-open.", "Only 12 tools are gated.", "Of those 12 tools, none are gated."]) {
    assert.deepEqual(scanCountClaims([{ path: "x.md", type: "concept", body: phrase }], "capsid"), [], `subset not exempted: ${phrase}`);
  }
  // An unqualified total in the same document still fires.
  assert.equal(scanCountClaims([{ path: "x.md", type: "concept", body: "The server exposes 19 tools." }], "capsid").length, 1);
});

test("N of M: M is checked as the total, N is exempt", () => {
  // Correct pair: M matches the authoritative total, so nothing fires.
  assert.deepEqual(
    scanCountClaims([{ path: "x.md", type: "concept", body: `Gated tools (12 of ${TOOLS}), all failing with DENIED.` }], "capsid"),
    []
  );
  // Stale M fires, and reports M rather than N.
  const claims = scanCountClaims([{ path: "x.md", type: "concept", body: "Gated tools (11 of 22)." }], "capsid");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].states, "22");
});

test("N of M is checked for internal consistency even when M is right", () => {
  // A subset larger than its total is wrong without reference to any artifact.
  // The total is the authoritative one (derived, not spelled), so the only finding
  // is the contradiction.
  const claims = scanCountClaims(
    [{ path: "x.md", type: "concept", body: `Gated tools (${CAPSID.tools + 6} of ${TOOLS}).` }],
    "capsid"
  );
  assert.equal(claims.length, 1);
  assert.match(claims[0].authoritative, /cannot exceed/);
  assert.match(claims[0].note ?? "", /internal contradiction/);
});

// "3 of 12 gates" must not be flagged by both the of-form pass and the plain-form
// pass reading "12 gates".
test("a wrong 'N of M gates' claim is flagged once, not by both gate passes", () => {
  const wrong = CAPSID.liveGates + 5;
  const claims = scanCountClaims([{ path: "core.md", type: "core", body: `3 of ${wrong} gates are live.` }], "capsid");
  assert.equal(claims.filter((c) => c.noun === "live gates").length, 1, JSON.stringify(claims));
});
