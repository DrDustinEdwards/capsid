import assert from "node:assert/strict";
import { test } from "node:test";
import { modelDrift, parseUnlisted, type DriftFacts } from "../src/model-drift.ts";
import type { InstalledRepo } from "../src/github/client.ts";
import type { SystemModel } from "../src/system-model.ts";

// The model's daily drift check (docs/public-data.md): system/model.json against the
// namespace mapping, the App's repo list and the watched sites, both ways.

const MODEL: SystemModel = {
  version: 1,
  systems: [
    { id: "sample-site", name: "Sample", short: "Sample", family: "site", ring: "used", public: true, domain: "example.com", repos: ["example-org/sample-site"] },
    { id: "sample-app", name: "App", short: "App", family: "product", ring: "used", public: false, domain: "app.example.org", repos: ["example-org/sample-app"] },
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
    unlisted: new Set(),
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
  assert.match(lines[0], /^model-drift sample: example-org\/sample-docs is mapped to sample but is in neither/);
  assert.match(lines[1], /^model-drift capsid: example-org\/side-project is installed for the App but is in neither/);
  assert.match(lines[2], /names example-org\/sample-app \(system sample-app\), which the App does not list/);
  // Each repo is listed once, and an archived one not at all.
  assert.equal(lines.filter((l) => l.includes("sample-docs")).length, 1);
  assert.ok(!lines.some((l) => l.includes("example-org/old")));
});

test("a repo listed in the unlisted document is skipped, by any case", () => {
  const out = modelDrift(MODEL, facts({ installed: [...(facts().installed ?? []), repo("Example-Org/Private-Notes", { private: true })], unlisted: parseUnlisted("# Unlisted\n\n- example-org/private-notes\n- `example-org/other`\nnot a list line example-org/x") }));
  assert.deepEqual(out.items, []);
  assert.deepEqual([...parseUnlisted("- `a/b`\n* c/d\ntext e/f")], ["a/b", "c/d"]);
});

test("a system marked public whose repo GitHub reports private is named, so the seat can fix one side", () => {
  const out = modelDrift(MODEL, facts({ installed: [repo("example-org/sample-site", { private: true }), repo("example-org/sample-app", { private: true })] }));
  assert.equal(out.items.length, 1);
  assert.match(out.items[0].line, /marks sample-site public, but GitHub reports example-org\/sample-site private/);
});

test("a watched site whose host is no system's domain is named; a subdomain of one is covered", () => {
  const out = modelDrift(MODEL, facts({ sites: [{ namespace: "sample", host: "app.example.org" }, { namespace: "other", host: "notexample.com" }] }));
  assert.deepEqual(out.items.map((i) => [i.namespace, i.line]), [["other", "The watched site notexample.com is no model system's domain: add the domain to its system in system/model.json."]]);
});

test("an unread App list is its own not-checked line, and the other comparisons still run", () => {
  const out = modelDrift(MODEL, facts({ installed: null, mapped: [{ namespace: "sample", repo: "example-org/sample-docs" }] }));
  assert.deepEqual(out.items.map((i) => i.rule).sort(), ["model-drift", "model-not-checked"]);
});
