import assert from "node:assert/strict";
import { test } from "node:test";
import { b64urlDecode, b64urlEncode, base64Decode, base64Encode, bytesToHex } from "../src/encoding.ts";

// src/encoding.ts: the byte encodings, defined once.
//
// Split out of limits.test.ts (quality audit 6.6), where it was one of five
// unrelated subjects under a name that described only one of them.

test("the shared encoders round-trip, including non-ASCII and padding cases", () => {
  for (const text of ["", "a", "ab", "abc", "hello world", "café ✓ 中文"]) {
    assert.equal(b64urlDecode(b64urlEncode(text)), text, `b64url round-trip failed for ${text}`);
    assert.equal(base64Decode(base64Encode(text)), text, `base64 round-trip failed for ${text}`);
  }
  // url-safe alphabet, no padding: this is what the JWT and the cookie depend on.
  const encoded = b64urlEncode("??>>??>>");
  assert.doesNotMatch(encoded, /[+/=]/);
  // GitHub wraps its base64 across lines; atob rejects that without the strip.
  assert.equal(base64Decode("aGVsbG8g\nd29ybGQ="), "hello world");
  assert.equal(bytesToHex(new Uint8Array([0, 15, 16, 255])), "000f10ff");
});
