import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server";
import { auditStatement } from "../src/store-guards";

// A write through an OAuth client records the client's name beside the actor, in each statement shape: the plain write,
// the links and delete INSERT ... SELECT, and a read says who last wrote. A write with no client records null.

async function call(clientName: string | undefined, name: string, args: Record<string, unknown>) {
  const server = buildServer(env as never, "write", "test:integration", "client-1", clientName);
  const client = new Client({ name: "client-attribution", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

const clients = async (action: string, path: string) =>
  (
    await env.DB.prepare(
      "SELECT client FROM audit_log WHERE action = ?1 AND namespace = 'sample' AND path = ?2 ORDER BY id",
    )
      .bind(action, path)
      .all<{ client: string | null }>()
  ).results.map((r) => r.client);

describe("the MCP client behind a write", () => {
  it("is recorded on write, links and delete, shown by read, and null without a client", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES ('sample', '[]')",
    ).run();
    await call("Sample Bot", "capsid_write_doc", {
      namespace: "sample",
      path: "a.md",
      title: "A",
      body: "one",
      links: JSON.stringify([{ type: "references", to_path: "core.md" }]),
    });
    expect(await clients("write", "a.md")).toEqual(["Sample Bot"]);
    expect(await clients("links", "a.md")).toEqual(["Sample Bot"]);
    expect(
      (await call(undefined, "capsid_read_doc", { namespace: "sample", path: "a.md" })).last_client,
    ).toBe("Sample Bot");

    await call(undefined, "capsid_write_doc", {
      namespace: "sample",
      path: "a.md",
      title: "A",
      body: "two",
      confirm: true,
    });
    expect(await clients("write", "a.md")).toEqual(["Sample Bot", null]);

    await call("Sample Bot", "capsid_write_doc", {
      namespace: "sample",
      path: "handoff/x.md",
      title: "X",
      body: "handoff",
      type: "episodic",
    });
    const brief = await call(undefined, "capsid_start_session", { namespace: "sample" });
    expect((brief.recent_episodics as Array<{ last_client: string }>)[0]?.last_client).toBe(
      "Sample Bot",
    );

    // No client: the Worker's own pass is "system", an agent key on a job names the job, a person is not guessed.
    for (const [actor, params] of [
      ["system:maintenance", {}],
      ["agent:runner", { job_id: "job_1" }],
      ["access:a@example.com", {}],
    ] as const)
      await auditStatement(env.DB, actor, "sample-label", "sample", null, params).run();
    const labels = await env.DB.prepare(
      "SELECT client FROM audit_log WHERE action = 'sample-label' ORDER BY id",
    ).all<{ client: string | null }>();
    expect(labels.results.map((r) => r.client)).toEqual(["system", "job:job_1", null]);

    await call("Other Bot", "capsid_delete_doc", {
      namespace: "sample",
      path: "a.md",
      confirm: true,
    });
    expect(await clients("delete", "a.md")).toEqual(["Other Bot"]);
  });
});
