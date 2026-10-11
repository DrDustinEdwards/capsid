import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { defaultScopes, type ScopeFlag } from "../src/agents-schema.ts";
import type { Agent } from "../src/agents.ts";
import { changelogSection, tagRefusal, tagRelease } from "../src/github/releases.ts";
import { buildServer } from "../src/server.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch, type Route } from "./fakes.ts";

// Tag and release (src/github/releases.ts), served as capsid_close_pr actions tag and
// release. A release takes its notes from the CHANGELOG section that names the tag, and
// one with no section is refused before any ref is created. Both go through guardedWrite
// and need can_merge, because a tag or a release can start a deploy as a merge can.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPOS = [{ repo: "o/r", label: "primary" }];

function env() {
  const d1 = fakeD1({ namespaces: [{ namespace: "sample", repos: JSON.stringify(REPOS) }] });
  return { d1, env: fakeEnv({ DB: d1.db, APP_KV: fakeKv({ seedToken: true }).kv }) };
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const changelogFile = (content: string) => ({ body: { type: "file", encoding: "base64", content: b64(content), size: content.length, sha: "file-sha" } });

const CHANGELOG = [
  "# Changelog",
  "",
  "## [1.4.0] - 2026-10-10",
  "",
  "### Added",
  "- The sample widget.",
  "",
  "## [1.3.0] - 2026-09-01",
  "- An older line that must not appear.",
].join("\n");

// GitHub, with the default branch, its head, the CHANGELOG at that head, and the two writes.
function github(changelog: string | null, extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    "GET /repos/o/r": { body: { default_branch: "main" } },
    "GET /repos/o/r/git/ref/heads/main": { body: { object: { sha: SHA } } },
    ...(changelog === null
      ? { "GET /repos/o/r/contents/CHANGELOG.md": { status: 404, body: { message: "Not Found" } } }
      : { "GET /repos/o/r/contents/CHANGELOG.md": changelogFile(changelog) }),
    "POST /repos/o/r/git/refs": { status: 201, body: { ref: "refs/tags/v1.4.0", object: { sha: SHA } } },
    "POST /repos/o/r/releases": { status: 201, body: { id: 77, html_url: "https://github.example.com/o/r/releases/tag/v1.4.0" } },
    ...extra,
  };
}

// changelogSection

test("changelogSection finds a bracketed heading and stops at the next heading of the same level", () => {
  const section = changelogSection(CHANGELOG, "v1.4.0");
  assert.equal(section, "### Added\n- The sample widget.");
  assert.doesNotMatch(section ?? "", /older line/);
});

test("changelogSection finds a bare '## v<tag>' heading, with or without the v on either side", () => {
  const md = "## v2.0.0\n\nBreaking: the sample API.\n\n## v1.9.0\n\nolder";
  assert.equal(changelogSection(md, "v2.0.0"), "Breaking: the sample API.");
  assert.equal(changelogSection(md, "2.0.0"), "Breaking: the sample API.");
  assert.equal(changelogSection("## 2.0.0\n\nno v in the heading", "v2.0.0"), "no v in the heading");
});

test("changelogSection keeps lower-level headings inside the section and stops at a higher one", () => {
  const md = "## [1.0.0]\n### Fixed\n- one\n#### Detail\n- two\n# Unreleased\n- three";
  assert.equal(changelogSection(md, "1.0.0"), "### Fixed\n- one\n#### Detail\n- two");
});

test("PLANT: changelogSection answers null for a missing version, a prefix of another version, and an empty section", () => {
  assert.equal(changelogSection(CHANGELOG, "v9.9.9"), null);
  // 1.4.0 must not match a heading for 1.4.01 or 1.4.0.1.
  assert.equal(changelogSection("## [1.4.01]\n- not this one", "v1.4.0"), null);
  assert.equal(changelogSection("## 1.4.0.1\n- not this one", "v1.4.0"), null);
  // The dot is literal: 1x4x0 is not 1.4.0.
  assert.equal(changelogSection("## 1x4x0\n- not this one", "v1.4.0"), null);
  assert.equal(changelogSection("## [1.4.0]\n\n## [1.3.0]\n- older", "v1.4.0"), null);
});

test("THE INNOCENT DIRECTION: a pre-release tag with a + or - suffix is matched literally", () => {
  assert.equal(changelogSection("## [1.4.0-rc.1]\n- candidate\n## [1.3.0]", "v1.4.0-rc.1"), "- candidate");
  assert.equal(changelogSection("## 1.4.0+build.7\n- built\n", "1.4.0+build.7"), "- built");
});

// tagRefusal

test("PLANT: tagRefusal refuses names that are not release versions", () => {
  for (const bad of ["", "latest", "v1", "v1.4", "1.4.0.1", "refs/tags/v1.4.0", "v1.4.0 ", "v1.4.0;rm", "../v1.4.0", "V1.4.0", `v1.4.0-${"a".repeat(41)}`]) {
    assert.match(tagRefusal(bad) ?? "", /is not a release tag/, `'${bad}' was accepted as a tag`);
  }
});

test("THE INNOCENT DIRECTION: tagRefusal accepts plain, v-prefixed, pre-release and build tags", () => {
  for (const good of ["v1.4.0", "1.4.0", "v1.4.0-rc.1", "1.4.0+build.7", "v10.20.30"]) {
    assert.equal(tagRefusal(good), null, `'${good}' was refused`);
  }
});

// tagRelease

test("PLANT: a release whose CHANGELOG has no section for the tag is refused before any ref is created", async () => {
  const { env: e } = env();
  await withFetch(github("# Changelog\n\n## [1.3.0]\n- older\n"), async (calls) => {
    await assert.rejects(
      () => tagRelease(e, "sample", { tag: "v1.4.0", publishRelease: true, changelogPath: "CHANGELOG.md" }),
      /CHANGELOG\.md at 0123456 has no section for v1\.4\.0.*Nothing was tagged\./s
    );
    assert.deepEqual(calls.filter((c) => c.method !== "GET"), [], "a release with no CHANGELOG section wrote to GitHub");
    // The CHANGELOG was read at the commit that would have been tagged.
    const read = calls.find((c) => c.path === "/repos/o/r/contents/CHANGELOG.md");
    assert.equal(new URLSearchParams(read?.search).get("ref"), SHA);
  });
});

test("PLANT: a release whose CHANGELOG cannot be read creates no ref either", async () => {
  const { env: e } = env();
  await withFetch(github(null), async (calls) => {
    await assert.rejects(() => tagRelease(e, "sample", { tag: "v1.4.0", publishRelease: true, changelogPath: "CHANGELOG.md" }), /404/);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0, "a release with no CHANGELOG created a ref");
  });
});

test("THE INNOCENT DIRECTION: a release with a section tags the commit and publishes the section as its notes", async () => {
  const { env: e } = env();
  await withFetch(github(CHANGELOG), async (calls) => {
    const result = await tagRelease(e, "sample", { tag: "v1.4.0", publishRelease: true, changelogPath: "CHANGELOG.md" });
    assert.equal(result.tag, "v1.4.0");
    assert.equal(result.sha, SHA);
    assert.equal(result.release?.id, 77);
    const posts = calls.filter((c) => c.method === "POST");
    assert.deepEqual(posts.map((c) => c.path), ["/repos/o/r/git/refs", "/repos/o/r/releases"], "the tag must be created before the release");
    assert.deepEqual(posts[0].body, { ref: "refs/tags/v1.4.0", sha: SHA });
    const release = posts[1].body as { tag_name: string; body: string; prerelease: boolean };
    assert.equal(release.tag_name, "v1.4.0");
    assert.equal(release.body, "### Added\n- The sample widget.");
    assert.equal(release.prerelease, false);
  });
});

test("THE INNOCENT DIRECTION: a tag alone works with no CHANGELOG section and never reads the CHANGELOG", async () => {
  const { env: e } = env();
  await withFetch(github(null), async (calls) => {
    const result = await tagRelease(e, "sample", { tag: "v1.4.0", publishRelease: false, changelogPath: "CHANGELOG.md" });
    assert.deepEqual(result, { repo: "o/r", tag: "v1.4.0", sha: SHA, release: null });
    assert.equal(calls.some((c) => c.path.includes("/contents/")), false, "a tag alone read the CHANGELOG");
    assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.path), ["/repos/o/r/git/refs"]);
  });
});

test("PLANT: a bad tag, a short sha, and sha with ref together are refused before GitHub is asked", async () => {
  const { env: e } = env();
  await withFetch(github(CHANGELOG), async (calls) => {
    await assert.rejects(() => tagRelease(e, "sample", { tag: "latest", publishRelease: false, changelogPath: "CHANGELOG.md" }), /is not a release tag/);
    await assert.rejects(() => tagRelease(e, "sample", { tag: "v1.4.0", sha: "abc1234", publishRelease: false, changelogPath: "CHANGELOG.md" }), /full 40-character commit sha/);
    await assert.rejects(() => tagRelease(e, "sample", { tag: "v1.4.0", sha: SHA, ref: "main", publishRelease: false, changelogPath: "CHANGELOG.md" }), /sha or ref, not both/);
    assert.equal(calls.length, 0, "a refused tag reached GitHub");
  });
});

test("an existing tag (422) is refused, saying nothing was changed, and no release is attempted", async () => {
  const { env: e } = env();
  await withFetch(github(CHANGELOG, { "POST /repos/o/r/git/refs": { status: 422, body: { message: "Reference already exists" } } }), async (calls) => {
    await assert.rejects(() => tagRelease(e, "sample", { tag: "v1.4.0", sha: SHA, publishRelease: true, changelogPath: "CHANGELOG.md" }), /already exists in o\/r.*Nothing was changed/s);
    assert.equal(calls.some((c) => c.path === "/repos/o/r/releases"), false);
  });
});

// Served: capsid_close_pr actions tag and release, through guardedWrite.

function driver(grant: ScopeFlag[] = []): Agent {
  const scopes = defaultScopes(["sample"]);
  scopes.grants = ["read", "write"];
  for (const flag of grant) scopes.flags[flag] = true;
  return { id: "agent_0123456789ab", name: "sample-driver", kind: "driver", actor: "agent:sample-driver", scopes, admin: false, row: null };
}

async function callAs(e: ReturnType<typeof env>["env"], caller: Agent, args: Record<string, unknown>) {
  const server = buildServer(e, caller);
  const client = new Client({ name: "tag-release", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name: "capsid_close_pr", arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: result.isError === true, text: result.content.map((c) => c.text).join("\n") };
  } finally {
    await client.close();
    await server.close();
  }
}

for (const action of ["tag", "release"]) {
  test(`PLANT: capsid_close_pr action ${action} refuses a driver without can_merge before GitHub is asked`, async () => {
    const { env: e, d1 } = env();
    await withFetch(github(CHANGELOG), async (calls) => {
      const r = await callAs(e, driver(), { action, namespace: "sample", tag: "v1.4.0" });
      assert.equal(r.isError, true, `${action} was not refused without can_merge`);
      assert.match(r.text, /needs the can_merge flag/);
      assert.equal(calls.length, 0, `${action} reached GitHub before refusing`);
      assert.equal(d1.rows.audit_log.length, 0, "a refused tag wrote an audit row");
    });
  });

  test(`THE INNOCENT DIRECTION: capsid_close_pr action ${action} runs for a driver holding can_merge, audit-logged`, async () => {
    const { env: e, d1 } = env();
    await withFetch(github(CHANGELOG), async (calls) => {
      const r = await callAs(e, driver(["can_merge"]), { action, namespace: "sample", tag: "v1.4.0" });
      assert.equal(r.isError, false, `${action} failed for a can_merge driver: ${r.text}`);
      assert.doesNotMatch(r.text, /needs the .* flag|unauthorized:/);
      const posts = calls.filter((c) => c.method === "POST").map((c) => c.path);
      assert.deepEqual(posts, action === "tag" ? ["/repos/o/r/git/refs"] : ["/repos/o/r/git/refs", "/repos/o/r/releases"]);
      const audit = d1.rows.audit_log as Array<Record<string, unknown>>;
      assert.equal(audit.length, 1, "guardedWrite wrote no audit row");
      assert.equal(audit[0].action, "tag_release");
      assert.equal(audit[0].actor, "agent:sample-driver");
      assert.equal(audit[0].namespace, "sample");
    });
  });
}

test("PLANT: capsid_close_pr action release with no CHANGELOG section is refused through the tool and creates no ref", async () => {
  const { env: e } = env();
  await withFetch(github("## [1.3.0]\n- older"), async (calls) => {
    const r = await callAs(e, driver(["can_merge"]), { action: "release", namespace: "sample", tag: "v1.4.0" });
    assert.equal(r.isError, true);
    assert.match(r.text, /no section for v1\.4\.0/);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });
});
