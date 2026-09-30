import assert from "node:assert/strict";
import { test } from "node:test";
import { redact, redactText } from "../src/redact.ts";

// Secret redaction for the log text ci_status returns (src/redact.ts). One test per
// pattern, and the innocent text that must come through unchanged.
//
// Every secret-shaped fixture is assembled at run time from fragments, so this public
// repo holds no string a secret scanner would read as a credential. They are fake.

const GH_CLASSIC = (prefix: string) => `gh${prefix}_` + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2";
const GH_FINE = "github" + "_pat_" + "11ABCDEFG0" + "a".repeat(20) + "_" + "B".repeat(30);
const AWS_ID = "AK" + "IA" + "EXAMPLEFAKE12345";
const JWT = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiJzYW1wbGUifQ", "c2lnbmF0dXJlLWZha2UtZm9yLXRlc3Rz"].join(".");
const SLACK = "xo" + "xb-" + "1234567890-abcdefghij";
const PEM_BEGIN = "-----BEGIN " + "RSA PRIVATE KEY-----";
const PEM_END = "-----END " + "RSA PRIVATE KEY-----";

const kinds = (text: string) => redact(text).redactions;

test("GitHub tokens of every prefix are redacted", () => {
  for (const prefix of ["p", "o", "u", "s", "r"]) {
    const token = GH_CLASSIC(prefix);
    const out = redactText(`pushing with ${token} now`);
    assert.equal(out, "pushing with [REDACTED:github-token] now", `gh${prefix}_ survived: ${out}`);
  }
  const fine = redactText(`GH_PAT ${GH_FINE}`);
  assert.equal(fine.includes("github_pat_"), false, fine);
  assert.match(fine, /\[REDACTED:github-token\]/);
  // Inside a clone URL's userinfo, too.
  assert.doesNotMatch(redactText(`https://x-access-token:${GH_CLASSIC("s")}@github.com/o/r.git`), /ghs_/);
});

test("an Authorization header keeps its scheme and loses its value", () => {
  assert.equal(redactText("Authorization: Bearer abc123.def456"), "Authorization: Bearer [REDACTED:auth]");
  assert.equal(redactText(`"authorization": "Basic dXNlcjpwYXNz"`), `"authorization": "Basic [REDACTED:auth]"`);
  assert.equal(redactText("authorization=token9f8e7d6c5b4a"), "authorization=[REDACTED:auth]");
});

test("a Bearer or Basic credential outside a header is redacted", () => {
  assert.equal(redactText("curl -H 'x: Bearer sk_live_0a1b2c3d4e'"), "curl -H 'x: Bearer [REDACTED:auth]'");
  assert.equal(redactText("using Basic dXNlcjpwYXNzd29yZA=="), "using Basic [REDACTED:auth]");
});

test("an AWS access key id is redacted", () => {
  assert.equal(redactText(`key id ${AWS_ID} in use`), "key id [REDACTED:aws-access-key-id] in use");
  assert.deepEqual(kinds(AWS_ID), { "aws-access-key-id": 1 });
});

test("a private key block is redacted whole, and an unterminated one to the end", () => {
  const block = [PEM_BEGIN, "MIIEowIBAAKCAQEAfakefakefake", "c2VjcmV0LWJvZHktbGluZQ==", PEM_END].join("\n");
  const out = redactText(`before\n${block}\nafter`);
  assert.equal(out, "before\n[REDACTED:private-key]\nafter");
  // A log cut mid-key: nothing after BEGIN survives.
  const cut = redactText(`before\n${PEM_BEGIN}\nMIIEowIBAAKCAQEAfakefakefake\nc2VjcmV0`);
  assert.equal(cut, "before\n[REDACTED:private-key]");
  // Timestamped CI lines, as a key echoed by a step arrives.
  const stamped = redactText(`2026-09-06T00:58:40.0Z ${PEM_BEGIN}\n2026-09-06T00:58:40.1Z MIIEfake\n2026-09-06T00:58:40.2Z ${PEM_END}\n2026-09-06T00:58:41.0Z next`);
  assert.equal(stamped, "2026-09-06T00:58:40.0Z [REDACTED:private-key]\n2026-09-06T00:58:41.0Z next");
});

test("a JWT is redacted", () => {
  assert.equal(redactText(`id_token ${JWT} end`).includes("eyJ"), false);
  assert.deepEqual(kinds(`jwt: ${JWT}`), { jwt: 1 });
});

test("Slack tokens and webhook URLs are redacted", () => {
  assert.equal(redactText(`slack ${SLACK}`), "slack [REDACTED:slack-token]");
  const hook = "https://hooks.slack.com/services/" + "T000FAKE/B000FAKE/abcdefFAKE123";
  assert.equal(redactText(`posting to ${hook}`), "posting to [REDACTED:slack-token]");
});

test("secret-named assignments are redacted in env, YAML, JSON and query forms", () => {
  assert.equal(redactText("API_TOKEN=abcdef123456"), "API_TOKEN=[REDACTED:assignment]");
  assert.equal(redactText("db_password: hunter22"), "db_password: [REDACTED:assignment]");
  assert.equal(redactText(`{"client_secret": "s3cr3t-value"}`), `{"client_secret": "[REDACTED:assignment]"}`);
  assert.equal(redactText("https://example.com/cb?access_token=abc123xyz&page=2"), "https://example.com/cb?access_token=[REDACTED:assignment]&page=2");
  assert.equal(redactText("ANTHROPIC_API_KEY=sample-not-a-key-0000"), "ANTHROPIC_API_KEY=[REDACTED:assignment]");
});

test("a specific kind is named over the generic assignment, and never redacted twice", () => {
  const out = redact(`GITHUB_TOKEN=${GH_CLASSIC("s")}`);
  assert.equal(out.text, "GITHUB_TOKEN=[REDACTED:github-token]");
  assert.deepEqual(out.redactions, { "github-token": 1 });
});

test("a long random run after a word like secret, token, key or password is redacted", () => {
  const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
  assert.equal(redactText(`the signing secret is ${hex}`), "the signing secret is [REDACTED:high-entropy]");
  const b64 = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo";
  assert.equal(redactText(`password was ${b64}`), "password was [REDACTED:high-entropy]");
});

test("innocent text survives: a sha, a URL, ordinary prose, a masked secret and a timestamp", () => {
  const innocent = [
    "2026-09-06T00:58:31.0Z ##[group]Run npm run check:ci",
    "HEAD is now at 3bcf8583a59659c255843ab5b8cecd2f56761da6 Merge pull request #7",
    "commit 3bcf8583a59659c255843ab5b8cecd2f56761da6",
    "https://github.com/o/r/actions/runs/42/job/9",
    "https://example.com/path?page=2&sort=asc",
    "The token was refused; see the password policy and the Bearer tokens section.",
    "Basic authentication is off.",
    "GITHUB_TOKEN: ***",
    "max_tokens=1024",
    "tokens: 5",
    "check:floors ... FAILED",
    "##[error]Process completed with exit code 1.",
    "npm error code ELIFECYCLE",
    "Author: Sample Person <sample@example.com>",
  ].join("\n");
  const out = redact(innocent);
  assert.equal(out.text, innocent, `innocent text was altered:\n${out.text}`);
  assert.deepEqual(out.redactions, {});
});

test("the counts name each kind and how many", () => {
  const out = redact(`${GH_CLASSIC("p")} and ${GH_CLASSIC("o")} and ${AWS_ID}`);
  assert.deepEqual(out.redactions, { "github-token": 2, "aws-access-key-id": 1 });
});
