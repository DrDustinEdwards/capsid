import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error scripts/ is plain .mjs with no declarations, deliberately: it
// runs in the live CI job with no npm ci and no build step.
import { canaryReport, checkCanary } from "../scripts/canary-lib.mjs";

// Gate 2b reads one long-lived client: record from OAUTH_KV directly, since through /authorize a missing client and a KV outage are the same error page.

const CLIENT_ID = "canaryTestId123";
const KEY = `client:${CLIENT_ID}`;
const RECORD = JSON.stringify({
  clientId: CLIENT_ID,
  clientName: "canary",
  redirectUris: ["https://example.com/x"],
});

type Reply = {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
};

function fakeKvApi(opts: {
  value?: string | null;
  valueStatus?: number;
  expiration?: number;
  throwOnValue?: string;
  listStatus?: number;
  throwOnList?: string;
}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.includes("/values/")) {
      if (opts.throwOnValue) throw new Error(opts.throwOnValue);
      const status = opts.valueStatus ?? (opts.value == null ? 404 : 200);
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => opts.value ?? "",
      } as Reply;
    }
    if (opts.throwOnList) throw new Error(opts.throwOnList);
    if (opts.listStatus && opts.listStatus !== 200)
      return { ok: false, status: opts.listStatus, json: async () => null } as Reply;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        result: [{ name: KEY, ...(opts.expiration ? { expiration: opts.expiration } : {}) }],
      }),
    } as Reply;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const check = (stub: ReturnType<typeof fakeKvApi>) =>
  checkCanary({
    fetchImpl: stub.fetchImpl,
    base: "https://kv.example/ns",
    clientId: CLIENT_ID,
    auth: { Authorization: "Bearer t" },
  });

test("each canary outcome, and whether the gate passes", async () => {
  const cases: Array<[string, ReturnType<typeof fakeKvApi>, string, boolean, RegExp]> = [
    ["present", fakeKvApi({ value: RECORD }), "present", true, /non-expiring/],
    ["missing", fakeKvApi({ value: null }), "missing", false, /is GONE from capsid-mcp-oauth/],
    // A KV blip must not read as a vanished record.
    [
      "a 500",
      fakeKvApi({ valueStatus: 500, value: RECORD }),
      "unreachable",
      false,
      /NOT evidence the record is gone/,
    ],
    [
      "a throw",
      fakeKvApi({ throwOnValue: "ECONNRESET" }),
      "unreachable",
      false,
      /NOT evidence the record is gone/,
    ],
    // A record put back with DCR's 90-day TTL can expire on its own.
    [
      "a TTL",
      fakeKvApi({ value: RECORD, expiration: 1794583009 }),
      "has-ttl",
      false,
      /must not expire.*2026-11-13|2026-11-13.*must not expire/s,
    ],
    // An unread expiry must not print as non-expiring.
    [
      "a listing 500",
      fakeKvApi({ value: RECORD, listStatus: 500 }),
      "ttl-unverified",
      false,
      /TTL UNVERIFIED/,
    ],
    [
      "a listing throw",
      fakeKvApi({ value: RECORD, throwOnList: "ECONNRESET" }),
      "ttl-unverified",
      false,
      /TTL UNVERIFIED/,
    ],
  ];
  for (const [label, stub, outcome, passed, detail] of cases) {
    const result = await check(stub);
    assert.equal(result.outcome, outcome, label);
    if (outcome === "ttl-unverified") assert.equal(result.expiration, undefined, label);
    const report = canaryReport(result, CLIENT_ID, "capsid-mcp-oauth");
    assert.equal(report.passed, passed, label);
    assert.match(report.detail, detail, label);
    if (outcome === "unreachable") assert.doesNotMatch(report.detail, /GONE from/, label);
    if (outcome === "ttl-unverified") assert.doesNotMatch(report.detail, /non-expiring,/, label);
  }
  for (const value of ["", "not json", JSON.stringify({ clientId: "someone-else" })])
    assert.equal((await check(fakeKvApi({ value }))).outcome, "corrupt", JSON.stringify(value));
});
