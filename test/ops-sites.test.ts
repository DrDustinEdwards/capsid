import assert from "node:assert/strict";
import { test } from "node:test";
import { healthPathRefusal, hostnameRefusal, originFrom, siteMapDrift, sitesFrom, validateSite } from "../src/ops-sites.ts";
import type { OpsSiteConfig } from "../src/ops-types.ts";
import { siteMapFindings } from "../src/watcher.ts";

// The Portal's site configuration (src/ops-sites.ts): what an edit may say, how rows
// become probed sites, and the site map against the registered namespaces. The table,
// its seed and the writes run against real D1 in test-integration/ops-sites.test.ts.

function row(namespace: string, over: Partial<OpsSiteConfig> = {}): OpsSiteConfig {
  return {
    namespace,
    name: namespace,
    origin: `https://${namespace}.example.com`,
    health_path: null,
    platform: "cloudflare",
    script: null,
    self_probe: false,
    revision: 1,
    updated_at: "2026-09-29 00:00:00",
    ...over,
  };
}

// Origins

const GOOD_ORIGINS: Array<[string, string]> = [
  ["https://example.com", "https://example.com"],
  ["https://example.com/", "https://example.com"],
  ["https://abscissa.dustinedwards.info", "https://abscissa.dustinedwards.info"],
  ["https://capsid.sample-name.workers.dev", "https://capsid.sample-name.workers.dev"],
  ["https://a1.b-2.example.org", "https://a1.b-2.example.org"],
];

// scanner-rule: every origin a probe could be pointed at wrongly is refused
const BAD_ORIGINS = [
  "http://example.com",
  "HTTPS://example.com",
  "example.com",
  "https://example.com:8443",
  "https://user:pw@example.com",
  "https://user@example.com",
  "https://example.com/health",
  "https://example.com/?x=1",
  "https://example.com#top",
  "https://Example.com",
  "https://127.0.0.1",
  "https://[::1]",
  "https://localhost",
  "https://printer.local",
  "https://db.internal",
  "https://intranet",
  "https://-bad.example.com",
  "https://bad-.example.com",
  "https://under_score.example.com",
  "https://example.123",
  `https://${"a".repeat(64)}.example.com`,
  "https://exa mple.com",
  "https://example..com",
  "",
];

test("a good origin is kept as https:// and the hostname, with any trailing slash dropped", () => {
  for (const [raw, want] of GOOD_ORIGINS) {
    const got = originFrom(raw);
    assert.ok(got.ok, `${raw} was refused: ${got.ok ? "" : got.refusal}`);
    assert.equal(got.ok && got.origin, want);
  }
});

test("PLANT: every origin that is not https:// and a public hostname alone is refused, with a reason", () => {
  // Twenty-four: scheme (3), port, credentials (2), path, query, fragment, case, IP
  // literals (2), local names (4), bad labels (4), a numeric top label, an overlong
  // label, a space, an empty label, and the empty string.
  assert.equal(BAD_ORIGINS.length, 24);
  for (const raw of BAD_ORIGINS) {
    const got = originFrom(raw);
    assert.equal(got.ok, false, `${JSON.stringify(raw)} was accepted`);
    assert.ok(!got.ok && got.refusal.length > 20, `${JSON.stringify(raw)} was refused with no reason`);
  }
});

test("hostnameRefusal names what is wrong", () => {
  assert.match(hostnameRefusal("127.0.0.1") ?? "", /IP address/);
  assert.match(hostnameRefusal("localhost") ?? "", /local name/);
  assert.match(hostnameRefusal("intranet") ?? "", /single-label/);
  assert.match(hostnameRefusal("Example.com") ?? "", /lowercase/);
  assert.equal(hostnameRefusal("example.com"), null);
});

// Health paths

const GOOD_PATHS = ["/", "/health", "/api/health", "/v1/status.json", "/_health", "/a~b/c-d", "/health/"];
// scanner-rule: every health path that could change what the probe fetches is refused
const BAD_PATHS = ["health", "/health?full=1", "/health#x", "/he alth", "/%2e%2e/admin", "//evil.example.com", "/a//b", "/../admin", "/./health", `/${"a".repeat(200)}`, ""];

test("PLANT: a health path is a plain absolute path; a query, a fragment, an escape or a dot segment is refused", () => {
  for (const p of GOOD_PATHS) assert.equal(healthPathRefusal(p), null, `${p} was refused`);
  // Eleven: no leading slash, query, fragment, space, percent escape, a protocol-relative
  // start, an empty segment, '..', '.', too long, and empty.
  assert.equal(BAD_PATHS.length, 11);
  for (const p of BAD_PATHS) assert.ok(healthPathRefusal(p), `${JSON.stringify(p)} was accepted`);
});

// The whole edit

test("a site edit is normalized: a name defaults to the namespace, blank optional fields are null", () => {
  const got = validateSite({ namespace: "abscissa", origin: "https://abscissa.dustinedwards.info/", platform: "cloudflare" });
  assert.deepEqual(got, {
    ok: true,
    site: { namespace: "abscissa", name: "abscissa", origin: "https://abscissa.dustinedwards.info", health_path: null, platform: "cloudflare", script: null },
  });
});

test("a namespace with no origin serves no site, and then takes no other field", () => {
  assert.deepEqual(validateSite({ namespace: "claude-skills" }), {
    ok: true,
    site: { namespace: "claude-skills", name: "claude-skills", origin: null, health_path: null, platform: null, script: null },
  });
  for (const extra of [{ platform: "cloudflare" }, { health_path: "/health" }, { script: "x" }]) {
    const got = validateSite({ namespace: "claude-skills", ...extra });
    assert.equal(got.ok, false, `${JSON.stringify(extra)} was accepted on a no-site row`);
  }
});

test("PLANT: the platform, the script and the namespace are checked", () => {
  const base = { namespace: "sample", origin: "https://sample.example.com" };
  const refused: Array<[Record<string, string>, RegExp]> = [
    [{ ...base }, /platform must be one of cloudflare, vercel/],
    [{ ...base, platform: "netlify" }, /platform must be one of/],
    [{ ...base, platform: "vercel", script: "sample" }, /only a Cloudflare site names a Worker script/],
    [{ ...base, platform: "cloudflare", script: "Sample Web" }, /not a Worker script name/],
    [{ ...base, namespace: "Sample", platform: "cloudflare" }, /not a namespace name/],
    [{ ...base, namespace: "", platform: "cloudflare" }, /not a namespace name/],
    [{ ...base, platform: "cloudflare", name: "x\u0007" }, /no control characters/],
    [{ ...base, platform: "cloudflare", name: "n".repeat(81) }, /at most 80 characters/],
  ];
  assert.equal(refused.length, 8);
  for (const [params, pattern] of refused) {
    const got = validateSite(params);
    assert.equal(got.ok, false, `${JSON.stringify(params)} was accepted`);
    assert.match(got.ok ? "" : got.refusal, pattern);
  }
  assert.equal(validateSite({ ...base, platform: "cloudflare", script: "sample-web" }).ok, true);
});

// Rows to sites

test("only rows with an origin become probed sites; the script and the self-probe carry over", () => {
  const sites = sitesFrom([
    row("capsid", { script: "capsid", self_probe: true, health_path: "/health" }),
    row("claude-skills", { origin: null, platform: null }),
    row("julieedwards", { platform: "vercel" }),
  ]);
  assert.deepEqual(sites, [
    { namespace: "capsid", name: "capsid", origin: "https://capsid.example.com", healthPath: "/health", platform: "cloudflare", script: "capsid", self: true },
    { namespace: "julieedwards", name: "julieedwards", origin: "https://julieedwards.example.com", healthPath: null, platform: "vercel" },
  ]);
  assert.deepEqual(sitesFrom([]), []);
});

// The site map

test("the site map is compared with the registered namespaces both ways, a no-site row counting as decided", () => {
  const config = [row("capsid"), row("txasm"), row("claude-skills", { origin: null, platform: null })];
  const registered = ["capsid", "claude-skills", "txasm"];
  assert.deepEqual(siteMapDrift(registered, config), { unmapped: [], unknown: [] });
  assert.deepEqual(siteMapFindings(siteMapDrift(registered, config)), []);

  const drift = siteMapDrift(["capsid", "claude-skills", "carrel"], config);
  assert.deepEqual(drift, { unmapped: ["carrel"], unknown: ["txasm"] });
  const [f] = siteMapFindings(drift);
  assert.equal(f.fingerprint, "site-map-drift-add-carrel-drop-txasm");
  assert.match(f.body, /carrel: registered, but has no row in the Portal's site configuration/);
  assert.match(f.body, /txasm: in the Portal's site configuration, but not a registered namespace/);
});

test("with nothing configured, every registered namespace is unmapped", () => {
  assert.deepEqual(siteMapDrift(["b", "a"], []), { unmapped: ["a", "b"], unknown: [] });
});
