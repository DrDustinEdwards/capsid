import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceFiles } from "./source-files.ts";

// No file may compare a secret with a short-circuiting compare. Matched by shape, so a new secret compared with !== is caught.
test("every secret compare goes through safeEqual, in every file", () => {
  const offenders = sourceFiles().flatMap((f) =>
    f.text
      .split("\n")
      .map((line, i) => ({ file: f.name, line: i + 1, text: line.trim() }))
      .filter(
        (l) =>
          /(!==|===)\s*(await\s+)?(hmacSha256Hex|sha256Hex)\(/.test(l.text) ||
          /(csrfCookie|stateCookie|clientSecret)\s*(!==|===)/.test(l.text),
      ),
  );
  assert.deepEqual(
    offenders.map((o) => `src/${o.file}:${o.line} ${o.text}`),
    [],
    "a secret is compared with === or !== instead of safeEqual",
  );
});
