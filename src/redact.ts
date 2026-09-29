// Secret redaction for text this Worker relays from somewhere it does not control.
//
// A CI log carries whatever the workflow echoed: a token a step printed by accident, an
// Authorization header from a verbose curl, a key file cat'd while debugging. GitHub
// masks the secrets it knows about as ***, and nothing else. ci_status returns log text
// to any write-grant caller, including a namespace's driver, so every log text it
// returns passes through redact() first (src/github/actions.ts).
//
// Each pattern replaces the secret, never the line, with [REDACTED:<kind>], so the
// caller still sees where it was and what kind it was. Order matters: the specific
// shapes run first, so a GitHub token in `GITHUB_TOKEN=ghp_...` is named github-token
// rather than the generic assignment.
//
// This errs toward over-redacting. A false positive costs a caller one value in a log;
// a false negative hands a credential to an agent.

export type RedactionKind =
  | "private-key"
  | "jwt"
  | "github-token"
  | "slack-token"
  | "aws-access-key-id"
  | "auth"
  | "assignment"
  | "high-entropy";

const marker = (kind: RedactionKind) => `[REDACTED:${kind}]`;

// A value the generic patterns may take: no whitespace, quote, separator or ampersand,
// and never an earlier marker, so a redacted value is not redacted twice under a
// vaguer name.
const VALUE = String.raw`(?!\[REDACTED)[^\s"',;&]{6,}`;

// Key names whose assigned value is a secret. Deliberately without bare "key" and
// "auth": "key" is every cache key in a CI log, and "auth" is "author".
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|signing[_-]?key|credential)[A-Za-z0-9_.-]*`;

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  // Default: the whole match becomes the marker.
  replace?: (match: string, ...groups: string[]) => string;
}

const RULES: Rule[] = [
  // A PEM or PGP private key block, whole. An unterminated block (a log cut mid-key)
  // is redacted to the end of the text rather than left half-shown.
  {
    kind: "private-key",
    pattern: /-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END \1PRIVATE KEY\2-----|$)/g,
  },
  // Header and payload are base64url JSON, so both start with eyJ ('{"').
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  // Classic (ghp_ personal, gho_ OAuth, ghu_ user-to-server, ghs_ server-to-server,
  // ghr_ refresh) and fine-grained personal access tokens.
  { kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "slack-token", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { kind: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[A-Z0-9]{16}\b/g },
  // An Authorization header's value, with its scheme kept. The scheme word is never
  // taken as the value, so a header whose value an earlier rule already redacted is
  // left as it is.
  {
    kind: "auth",
    pattern: new RegExp(
      String.raw`\b(authorization["']?\s*[:=]\s*["']?)((?:bearer|basic|token|digest)\s+)?(?!(?:bearer|basic|token|digest)\s)(${VALUE})`,
      "gi"
    ),
    replace: (_m, lead, scheme) => `${lead}${scheme ?? ""}${marker("auth")}`,
  },
  // A Bearer or Basic credential outside a header. The value must hold a digit or a
  // base64 symbol, so the prose "Bearer tokens" and "Basic authentication" survive.
  {
    kind: "auth",
    pattern: /\b(Bearer|Basic)(\s+)(?=[A-Za-z0-9._~+/-]*[0-9+/=])[A-Za-z0-9._~+/-]{8,}=*/gi,
    replace: (_m, scheme, space) => `${scheme}${space}${marker("auth")}`,
  },
  // NAME=value, NAME: value, "name": "value", ?name=value, for a secret-shaped name.
  {
    kind: "assignment",
    pattern: new RegExp(String.raw`(?<![A-Za-z0-9_.-])(["']?)(${SECRET_NAME})\1(\s*[:=]\s*)(["']?)(${VALUE})`, "gi"),
    replace: (_m, q1, name, sep, q2) => `${q1}${name}${q1}${sep}${q2}${marker("assignment")}`,
  },
  // A long random-looking run shortly after a word like secret, token, key or password,
  // in forms the assignment rule does not cover ("the token is 3f9a...").
  {
    kind: "high-entropy",
    pattern: /\b((?:secret|token|key|password|passwd|credential)s?\b[^\n]{0,24}?)([A-Za-z0-9+/_-]{32,}={0,2})/gi,
    replace: (match, lead, run) => (looksRandom(run) ? `${lead}${marker("high-entropy")}` : match),
  },
];

// A run of 32 or more is random-looking if it is all hex, or mixes letters and digits.
// A long word or a long run of one character is not.
function looksRandom(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run) && /\d/.test(run)) return true;
  return /\d/.test(run) && /[A-Za-z]/.test(run);
}

export interface Redacted {
  text: string;
  // How many values of each kind were replaced; empty when none were.
  redactions: Partial<Record<RedactionKind, number>>;
}

/** Replaces every secret-shaped value in `text` with [REDACTED:<kind>]. */
export function redact(text: string): Redacted {
  const redactions: Partial<Record<RedactionKind, number>> = {};
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      // rest ends with offset, input (and groups when named); only the captures are strings we pass on.
      const groups = rest.slice(0, -2) as string[];
      const replaced = rule.replace ? rule.replace(match, ...groups) : marker(rule.kind);
      if (replaced !== match) redactions[rule.kind] = (redactions[rule.kind] ?? 0) + 1;
      return replaced;
    });
  }
  return { text: out, redactions };
}

/** redact() when only the text is wanted, for a short error body. */
export const redactText = (text: string): string => redact(text).text;
