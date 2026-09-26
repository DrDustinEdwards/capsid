import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMetaLoop } from "../src/improve-meta";
import { META_LAST_KEY, PROPOSAL_PREFIX, RUN_PROMPT_PATH, SCORES_PATH } from "../src/improve-schema";

// The meta-loop writes only a draft proposal, driven end to end on a real D1 with a
// stubbed model. The assertions are on what the store holds afterwards: one new
// document under the proposals prefix, a draft that says it is not applied, and the
// run prompt it proposes to change left as it was.

const PROMPT_BODY = "lorem ipsum run prompt, the one in force";
const REVISED = "lorem ipsum revised run prompt";

function modelAnswer(parsed: unknown) {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus",
      content: [{ type: "text", text: JSON.stringify(parsed) }],
      stop_reason: "end_turn",
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function documents(): Promise<Array<{ path: string; status: string; body: string }>> {
  const { results } = await env.DB.prepare("SELECT path, status, body FROM documents WHERE namespace = 'capsid' ORDER BY path").all<{
    path: string;
    status: string;
    body: string;
  }>();
  return results ?? [];
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM documents").run();
  await env.DB.prepare("DELETE FROM document_versions").run();
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM improve_runs").run();
  await env.APP_KV.delete(META_LAST_KEY);
  // Evidence for the aggregate: one finished run in the last 14 days.
  await env.DB.prepare(
    `INSERT INTO improve_runs (id, namespace, mode, status, started, condition, attempts, kept, reverts)
     VALUES ('capsid-meta-r1', 'capsid', 'subscription', 'done', datetime('now'), 'full', 3, 1, 2)`
  ).run();
  for (const path of [RUN_PROMPT_PATH, SCORES_PATH]) {
    await env.DB.prepare("INSERT INTO documents (namespace, path, title, body, type, status) VALUES ('capsid', ?1, 'protected', ?2, 'procedural', 'published')")
      .bind(path, PROMPT_BODY)
      .run();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runMetaLoop", () => {
  it("writes its proposal as a draft under the proposals prefix, and nothing else", async () => {
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      asked.push(url);
      if (url.includes("/v1/messages")) return modelAnswer({ propose: true, rationale: "lorem rationale", revised_prompt: REVISED });
      return new Response("not stubbed", { status: 500 });
    });
    const before = await documents();

    const result = await runMetaLoop({ ...env, ANTHROPIC_API_KEY: "sk-test-not-a-real-key" } as typeof env, new Date());

    expect(asked.some((u) => u.includes("/v1/messages")), "the model was never asked, so this proves nothing").toBe(true);
    expect(result.proposed, result.note).toBe(true);
    expect(result.path?.startsWith(PROPOSAL_PREFIX)).toBe(true);

    const after = await documents();
    const added = after.filter((d) => !before.some((b) => b.path === d.path));
    expect(added.map((d) => d.path)).toEqual([result.path]);
    const proposal = added[0];
    expect(proposal.status, "a proposal is not in force and its status must say so").toBe("draft");
    expect(proposal.body).toContain("**NOT APPLIED.**");
    expect(proposal.body).toContain(REVISED);

    // The documents the loop is measured against are untouched: same body, no version
    // row, no audit row.
    for (const path of [RUN_PROMPT_PATH, SCORES_PATH]) {
      expect(after.find((d) => d.path === path)?.body).toBe(PROMPT_BODY);
    }
    const versions = await env.DB.prepare("SELECT path FROM document_versions WHERE namespace = 'capsid'").all<{ path: string }>();
    expect(versions.results.filter((v) => !v.path.startsWith(PROPOSAL_PREFIX))).toEqual([]);
    const audits = await env.DB.prepare("SELECT path FROM audit_log WHERE namespace = 'capsid'").all<{ path: string | null }>();
    expect(audits.results.length, "the proposal write was not audited").toBeGreaterThan(0);
    expect(audits.results.filter((a) => !String(a.path).startsWith(PROPOSAL_PREFIX))).toEqual([]);
  });
});
