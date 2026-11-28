import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  VERIFY_LIVE_CLIENT_PATH,
  clientDocument,
  handleClientDocument,
} from "../src/oauth-client-docs.ts";

// That the provider accepts the served document is test/cimd-probe.test.ts.

const ORIGIN = "https://capsid.example";
const FILE = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "scripts", "verify-live-client.json"), "utf8"),
) as Record<string, unknown>;

test("it says what the repo's file says, apart from client_id, so the probe is the same client in all but its id", () => {
  const { client_id: _file, ...fileRest } = FILE;
  void _file;
  const { client_id: _served, ...servedRest } = clientDocument(
    new URL(`${ORIGIN}${VERIFY_LIVE_CLIENT_PATH}`),
  )!;
  void _served;
  assert.deepEqual(servedRest, fileRest);
});

test("no other path under /oauth/clients/ answers with a document", () => {
  assert.equal(clientDocument(new URL(`${ORIGIN}/oauth/clients/other.json`)), null);
  assert.equal(handleClientDocument(new Request(`${ORIGIN}/oauth/clients/other.json`)).status, 404);
});
