import assert from "node:assert/strict";
import { test } from "node:test";
import { modelDrift, type DriftFacts } from "../src/model-drift.ts";
import type { InstalledRepo } from "../src/github/client.ts";
import type { SystemModel } from "../src/system-model.ts";

// The model's daily drift check (docs/public-data.md): system/model.json against the
// namespace mapping, the App's repo list and the watched sites, both ways.

const MODEL: SystemModel = {
  version: 1,
  systems: [
    { id: "sample-site", name: "Sample", short: "Sample", family: "site", ring: "used", domain: "example.com", repos: ["example-org/sample-site"] },
    { id: "sample-app", name: "App", short: "App", family: "product", ring: "used", domain: "app.example.org", repos: ["example-org/sample-app"] },
  ],
  containers: [],
  relationships: [],
};

const repo = (full_name: string, o: Partial<InstalledRepo> = {}): InstalledRepo => ({ full_name, private: false, archived: false, pushed_at: null, ...o });

function facts(over: Partial<DriftFacts> = {}): DriftFacts {
  return {
    mapped: [{ namespace: "sample", repo: "example-org/sample-site" }],
    installed: [repo("example-org/sample-site"), repo("example-org/sample-app", { private: true })],
    sites: [{ namespace: "sample", host: "www.example.com" }],
    ...over,
  };
}

test("a model in step with every fact lists nothing, and says how much it compared", () => {
  const out = modelDrift(MODEL, facts());
  assert.deepEqual(out.items, []);
  assert.equal(out.read, 4);
});

test("both ways: a repo the model does not name, and a repo it names that GitHub does not list", () => {
  const out = modelDrift(
    MODEL,
    facts({
      mapped: [
        { namespace: "sample", repo: "example-org/sample-site" },
        { namespace: "sample", repo: "example-org/sample-docs" },
      ],
      installed: [repo("example-org/sample-site"), repo("example-org/side-project"), repo("example-org/sample-docs"), repo("example-org/old", { archived: true })],
    })
  );
  const lines = out.items.map((i) => `${i.rule} ${i.namespace}: ${i.line}`);
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.match(lines[0], /^model-drift sample: example-org\/sample-docs is mapped to sample but is not in system\/model.json/);
  assert.match(lines[1], /^model-drift capsid: example-org\/side-project is installed for the App but is not in system\/model.json/);
  assert.match(lines[2], /names example-org\/sample-app \(system sample-app\), which the App does not list/);
  // Each repo is listed once, and an archived one not at all.
  assert.equal(lines.filter((l) => l.includes("sample-docs")).length, 1);
  assert.ok(!lines.some((l) => l.includes("example-org/old")));
});

test("a repo the model leaves off is not asked for, and is named once GitHub stops listing it", () => {
  const model: SystemModel = { ...MODEL, left_off: [{ repo: "example-org/sample-kept-off", why: "Sample." }, { repo: "example-org/sample-gone", why: "Sample." }] };
  const out = modelDrift(model, facts({ installed: [...facts().installed!, repo("example-org/sample-kept-off")] }));
  assert.deepEqual(out.items.map((i) => i.line), ["system/model.json leaves example-org/sample-gone off the map, but the App no longer lists it: drop it from left_off."]);
});

test("a watched site whose host is no system's domain is named; a subdomain of one is covered", () => {
  const out = modelDrift(MODEL, facts({ sites: [{ namespace: "sample", host: "app.example.org" }, { namespace: "other", host: "notexample.com" }] }));
  assert.deepEqual(out.items.map((i) => [i.namespace, i.line]), [["other", "The watched site notexample.com is no model system's domain: add the domain to its system in system/model.json."]]);
});

test("an unread App list is its own not-checked line, and the other comparisons still run", () => {
  const out = modelDrift(MODEL, facts({ installed: null, mapped: [{ namespace: "sample", repo: "example-org/sample-docs" }] }));
  assert.deepEqual(out.items.map((i) => i.rule).sort(), ["model-drift", "model-not-checked"]);
});
