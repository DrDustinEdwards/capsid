import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { liveChecks, parseLiveConfig, readLiveConfig } from "../src/live-checks";

// The live-checks document read against a real D1: the statement runs on SQLite, finds
// only a published capsid/policy/live-checks.md, and the document it returns parses.

const BODY = "# Live checks\n\n- site sample beacon /\n- site sample nobeacon /account\n";

async function put(status: string, body: string): Promise<void> {
  await env.DB.prepare("DELETE FROM documents WHERE namespace = 'capsid' AND path = 'policy/live-checks.md'").run();
  await env.DB.prepare("INSERT INTO documents (namespace, path, title, body, status) VALUES ('capsid', 'policy/live-checks.md', 'Live checks', ?1, ?2)").bind(body, status).run();
}

describe("readLiveConfig", () => {
  it("is null with no document, and null for one that is not published", async () => {
    await env.DB.prepare("DELETE FROM documents WHERE namespace = 'capsid' AND path = 'policy/live-checks.md'").run();
    expect(await readLiveConfig(env.DB)).toBeNull();
    await put("draft", BODY);
    expect(await readLiveConfig(env.DB)).toBeNull();
  });

  it("returns the published body, which parses into its rules and runs no check for a site that is not configured", async () => {
    await put("published", BODY);
    const config = await readLiveConfig(env.DB);
    expect(config).toEqual({ body: BODY });
    expect(parseLiveConfig(config!.body)).toEqual({
      rules: [
        { namespace: "sample", kind: "beacon", path: "/" },
        { namespace: "sample", kind: "nobeacon", path: "/account" },
      ],
    });
    const out = await liveChecks(config, [], [], { fetchImpl: async () => { throw new Error("fetched"); }, head: async () => { throw new Error("read"); } }, new Date());
    expect(out.findings.map((f) => f.fingerprint)).toEqual(["live-config-unknown-site-sample"]);
  });
});
