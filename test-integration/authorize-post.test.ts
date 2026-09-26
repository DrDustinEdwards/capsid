import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// /authorize POST's body cap, measured against the real runtime. The consent POST
// is reachable without credentials (the CSRF check runs after the parse), so the body
// is bounded before request.formData() buffers and parses it.
//
// Separate from /csp-report because this is the OAuth consent path, where a small
// change can break logins. An ordinary form must still reach its CSRF check and be
// refused for the CSRF reason, not for a size reason.

const ORIGIN = "https://capsid.test";

async function postForm(body: string, headers: Record<string, string> = {}) {
  return SELF.fetch(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

describe("/authorize POST bounds the body before parsing it", () => {
  it("refuses a body over the cap with 413", async () => {
    const body = `csrf=x&req=${"A".repeat(70_000)}`;
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(65_536);
    const resp = await postForm(body);
    expect(resp.status).toBe(413);
  });

  it("counts BYTES, not characters", async () => {
    // 30,000 three-byte characters is 90,000 bytes on the wire and 30,000 by
    // String#length. The cap measures what arrived, not the decoded string.
    const body = `csrf=x&req=${encodeURIComponent("あ".repeat(30_000))}`;
    const resp = await postForm(body);
    expect(resp.status).toBe(413);
  });

  it("an ordinary form still reaches the CSRF check, which is the behaviour that must not change", async () => {
    // 403 (csrf) rather than 413 (too large) or 500, which catches a bound so tight
    // or early that it broke consent.
    const resp = await postForm("csrf=nonsense&req=nonsense");
    expect(resp.status).toBe(403);
    expect(await resp.text()).toMatch(/csrf/i);
  });

  it("a form missing its fields is still a 400, not a size refusal", async () => {
    const resp = await postForm("nothing=here");
    expect(resp.status).toBe(400);
  });

  it("an empty body is a 400", async () => {
    const resp = await postForm("");
    expect(resp.status).toBe(400);
  });
});
