import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// /authorize POST's body cap, measured against the real runtime. The consent POST
// is reachable without credentials (the handle is checked after the parse), so the
// body is bounded before loginHandler's request.formData() buffers and parses it.
//
// Separate from /csp-report because this is the OAuth consent path, where a small
// change can break logins. An ordinary form must still reach its handle check and be
// refused for that reason, not for a size reason.

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
    const body = `handle=x&decision=approve&pad=${"A".repeat(70_000)}`;
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(65_536);
    const resp = await postForm(body);
    expect(resp.status).toBe(413);
  });

  it("counts BYTES, not characters", async () => {
    // 30,000 three-byte characters is 90,000 bytes on the wire and 30,000 by
    // String#length. The cap measures what arrived, not the decoded string.
    const body = `handle=x&decision=approve&pad=${encodeURIComponent("あ".repeat(30_000))}`;
    const resp = await postForm(body);
    expect(resp.status).toBe(413);
  });

  it("an ordinary form still reaches the handle check, which is the behavior that must not change", async () => {
    // 400 for the handle rather than 413 (too large) or 500, which catches a bound so
    // tight or early that it broke consent.
    const resp = await postForm("handle=nonsense&decision=approve");
    expect(resp.status).toBe(400);
    expect(await resp.text()).not.toMatch(/too large/i);
  });

  it("a body that is not a form is refused before any parse, not a 500", async () => {
    const resp = await postForm("{}", { "Content-Type": "application/json" });
    expect(resp.status).toBe(415);
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
