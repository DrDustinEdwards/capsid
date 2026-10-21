import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { PortalLibrary } from "../src/ops-types/views";
import { portalSessionCookie } from "../src/portal-auth";
import { PORTAL_LIBRARY_PATH } from "../src/portal-library";

// The Library's route through the Worker, against the D1 the migrations build, so the
// search runs on the real FTS5 table and its triggers. The gate itself (a bearer's 403,
// an anonymous caller's sign-in) is driven for every Portal route in route-gates.test.ts.
// Fake data only: namespace "sample-library".

const ORIGIN = "https://capsid.test";
const SECRET = "integration-portal-library-key";
const NS = "sample-library";

async function signedGet(query: string): Promise<Response> {
  const cookie = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, new Date())).split(";")[0];
  const ctx = createExecutionContext();
  const response = await worker.fetch!(
    new Request(`${ORIGIN}${PORTAL_LIBRARY_PATH}${query}`, { headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" }, redirect: "manual" }) as never,
    { ...env, COOKIE_ENCRYPTION_KEY: SECRET } as never,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

async function plant(path: string, type: string, title: string, body: string): Promise<void> {
  await env.DB.prepare("INSERT INTO documents (namespace, path, title, type, status, body) VALUES (?1, ?2, ?3, ?4, 'published', ?5)")
    .bind(NS, path, title, type, body)
    .run();
}

const auditRows = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())!.n;

beforeAll(async () => {
  await plant("decisions.md", "decision", "Sample decisions", "We chose the quokka layout for job_0123456789ab.");
  await plant("rulings/layout.md", "note", "Layout ruling", "The quokka layout stands.");
  await plant("research/survey.md", "reference", "Survey", "Three layouts compared, quokka among them.");
  await plant("archive/research/old.md", "decision", "Old decisions", "Superseded quokka notes.");
  await plant("notes/loose.md", "note", "Loose note", "A quokka note on no shelf.");
  await env.DB.prepare("INSERT INTO document_links (from_ns, from_path, to_ns, to_path, type) VALUES (?1, 'rulings/layout.md', ?1, 'decisions.md', 'implements')")
    .bind(NS)
    .run();
});

describe("GET /portal/api/library", () => {
  it("PLANT: the shelves hold decisions, rulings and research, and leave archive/ and loose notes off", async () => {
    const before = await auditRows();
    const response = await signedGet("");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as PortalLibrary;
    expect(body.kind).toBe("shelves");
    if (body.kind !== "shelves") return;
    const mine = (shelf: keyof typeof body.shelves) => body.shelves[shelf].filter((r) => r.namespace === NS).map((r) => r.path);
    expect(mine("decisions")).toEqual(["decisions.md"]);
    expect(mine("rulings")).toEqual(["rulings/layout.md"]);
    expect(mine("research")).toEqual(["research/survey.md"]);
    expect(await auditRows(), "the Library wrote an audit row").toBe(before);
  });

  it("searches every namespace, marks the match, and takes FTS5 syntax as plain text", async () => {
    const response = await signedGet("?q=quokka");
    const body = (await response.json()) as PortalLibrary;
    expect(body.kind).toBe("search");
    if (body.kind !== "search") return;
    expect(body.rows.filter((r) => r.namespace === NS)).toHaveLength(5);
    expect(body.rows.find((r) => r.namespace === NS)!.snippet).toContain("\u0002quokka\u0003");
    // A hyphen is FTS5 syntax; the reader retries it as a phrase rather than failing.
    const hyphen = await signedGet(`?q=${encodeURIComponent("quokka-layout")}`);
    expect(hyphen.status, await hyphen.clone().text()).toBe(200);
  });

  it("reads one document with the edges that touch it", async () => {
    const response = await signedGet(`?ns=${NS}&path=${encodeURIComponent("decisions.md")}`);
    const body = (await response.json()) as PortalLibrary;
    expect(body.kind).toBe("document");
    if (body.kind !== "document") return;
    expect(body.doc.body).toContain("job_0123456789ab");
    expect(body.doc).not.toHaveProperty("id");
    expect(body.outgoing).toEqual([]);
    expect(body.incoming).toEqual([{ type: "implements", from_ns: NS, from_path: "rulings/layout.md" }]);
  });

  it("refuses half a document name and a bad path with 400, and a missing document with 404", async () => {
    expect((await signedGet(`?ns=${NS}`)).status).toBe(400);
    expect((await signedGet(`?ns=${NS}&path=${encodeURIComponent("../x.md")}`)).status).toBe(400);
    const missing = await signedGet(`?ns=${NS}&path=nowhere.md`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("No document sample-library/nowhere.md");
  });
});
