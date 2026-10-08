import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { logEvent } from "../src/log.ts";

describe("logEvent", () => {
  const seen: Array<{ level: string; line: unknown }> = [];
  const original = { log: console.log, warn: console.warn, error: console.error };

  beforeEach(() => {
    seen.length = 0;
    for (const level of ["log", "warn", "error"] as const) {
      console[level] = (line: unknown) => {
        seen.push({ level, line });
      };
    }
  });
  afterEach(() => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  });

  it("writes one JSON string with event first, then message, then the extra fields", () => {
    logEvent("error", "SOMETHING_FAILED", { message: "SOMETHING_FAILED x: boom", kind: "k", n: 3 });
    assert.equal(seen.length, 1);
    assert.equal(typeof seen[0].line, "string");
    assert.deepEqual(JSON.parse(seen[0].line as string), {
      event: "SOMETHING_FAILED",
      message: "SOMETHING_FAILED x: boom",
      kind: "k",
      n: 3,
    });
    assert.deepEqual(Object.keys(JSON.parse(seen[0].line as string)).slice(0, 2), ["event", "message"]);
  });

  it("keeps the level: log, warn and error go through the matching console method", () => {
    logEvent("log", "A_EVENT", { message: "a" });
    logEvent("warn", "B_EVENT", { message: "b" });
    logEvent("error", "C_EVENT", { message: "c" });
    assert.deepEqual(
      seen.map((s) => [s.level, JSON.parse(s.line as string).event]),
      [
        ["log", "A_EVENT"],
        ["warn", "B_EVENT"],
        ["error", "C_EVENT"],
      ]
    );
  });

  it("does not let a field override the event or message", () => {
    logEvent("log", "REAL_EVENT", { message: "real", event: "FAKE" });
    assert.equal(JSON.parse(seen[0].line as string).event, "REAL_EVENT");
  });

  it("does not throw on a circular field, and falls back to a plain string with the event", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    assert.doesNotThrow(() => logEvent("error", "LOOP_EVENT", { message: "the text", loop }));
    assert.equal(seen[0].line, "LOOP_EVENT the text");
  });

  it("does not throw on a BigInt field", () => {
    assert.doesNotThrow(() => logEvent("warn", "BIG_EVENT", { message: "big", n: 10n }));
    assert.equal(seen[0].line, "BIG_EVENT big");
    assert.equal(seen[0].level, "warn");
  });

  it("does not throw when console itself throws", () => {
    console.error = () => {
      throw new Error("no console");
    };
    assert.doesNotThrow(() => logEvent("error", "X_EVENT", { message: "x" }));
  });
});
