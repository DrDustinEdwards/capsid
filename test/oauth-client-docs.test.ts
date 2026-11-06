import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error scripts/ is plain .mjs with no declarations, deliberately: it
// runs in the live CI job with no npm ci and no build step.
import { PROBE_REDIRECT, probeDocumentProblem } from "../scripts/cimd-probe-lib.mjs";
import { VERIFY_LIVE_CLIENT_PATH, clientDocument, handleClientDocument } from "../src/oauth-client-docs.ts";

// The verify-live probe's client document served by the Worker at a path that names no
// branch (job_bf05bc756c5e). It must be one the provider accepts, and say the same as the
// file it replaces, apart from its own URL.

const ORIGIN = "https://capsid.example";
const FILE = JSON.parse(readFileSync(join(import.meta.dirname, "..", "scripts", "verify-live-client.json"), "utf8")) as Record<string, unknown>;

test("PLANT: the served document is one the provider accepts at its own URL", async () => {
  const url = `${ORIGIN}${VERIFY_LIVE_CLIENT_PATH}`;
  const response = handleClientDocument(new Request(url));
  assert.equal(response.status, 200);
  const doc = (await response.json()) as Record<string, unknown>;
  assert.equal(probeDocumentProblem(doc, url, PROBE_REDIRECT), null);
  assert.equal(doc.client_id, url, "a client id is the URL its document is fetched at");
});

test("it says what the repo's file says, apart from client_id, so the probe is the same client in all but its id", () => {
  const { client_id: _file, ...fileRest } = FILE;
  void _file;
  const { client_id: _served, ...servedRest } = clientDocument(new URL(`${ORIGIN}${VERIFY_LIVE_CLIENT_PATH}`))!;
  void _served;
  assert.deepEqual(servedRest, fileRest);
});

test("no other path under /oauth/clients/ answers with a document", () => {
  assert.equal(clientDocument(new URL(`${ORIGIN}/oauth/clients/other.json`)), null);
  assert.equal(handleClientDocument(new Request(`${ORIGIN}/oauth/clients/other.json`)).status, 404);
});
