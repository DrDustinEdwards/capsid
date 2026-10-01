import type { AuditChange, AuditDetail, AuditField } from "./ops-types";

// What an audit row recorded, in plain English, for the Portal's Activity drawer
// (job_fe0da37c07e0 PR 2; capsid/decisions.md 2026-09-30, "admin panels review
// adopted", item 2). The reason typed with a change, a field-by-field before and after
// where the row carries both, and the row's other fields by name.
//
// NAMED FIELDS, NEVER RAW PARAMS. The same rule cloudflare_config follows ("copies
// named fields only"): a document write's params carry a content hash, and a signed
// row a signature, neither of which belongs on a page. Those, and any nested value,
// are counted in `withheld` and not shown.

// A key naming a hash, a signature, a credential or a body. Matched per underscore-
// separated word, so `sha256` and `body_sha256` are withheld and `merge_sha` is shown.
const WITHHELD_WORD = /^(sha256|hash|sig|signature|token|secret|key|jti|nonce|body|content|text)$/i;
const VALUE_MAX = 300;

// How a key reads in the drawer, where the plain form ("job_id" as "Job id") is not
// enough. Anything else is shown with its underscores as spaces.
const LABELS: Record<string, string> = {
  id: "Id",
  job_id: "Job",
  run_url: "GitHub run",
  pr_url: "Pull request",
  undo: "Undo of a change just made",
  ran: "Ran",
  posted: "Findings posted",
  cleared: "Findings cleared",
  note: "Note",
  error: "Error",
  value: "Set to",
  enabled: "On",
  old: "From",
  new: "To",
  new_path: "New path",
  max_sessions: "Most sessions at once",
};

function withheld(key: string): boolean {
  return key.split("_").some((word) => WITHHELD_WORD.test(word));
}

function label(key: string): string {
  const known = LABELS[key];
  if (known) return known;
  const plain = key.replace(/_/g, " ").trim();
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A scalar, or a list of scalars, as one line; null for anything nested. */
function text(v: unknown): string | null {
  if (v === null || v === undefined) return "none";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.length > VALUE_MAX ? `${v.slice(0, VALUE_MAX - 1)}…` : v;
  if (Array.isArray(v)) {
    if (v.length === 0) return "none";
    const parts = v.map(text);
    return parts.every((p): p is string => p !== null) ? text(parts.join(", ")) : null;
  }
  return null;
}

/** Each field that differs between `before` and `after`, in the order the row has
 *  them. A row with only `after` (an add) lists every field as new; only `before` (a
 *  remove) lists every field as gone. */
function changesOf(before: Record<string, unknown> | null, after: Record<string, unknown> | null): { changes: AuditChange[]; withheld: number } {
  const keys = [...new Set([...Object.keys(after ?? {}), ...Object.keys(before ?? {})])];
  const changes: AuditChange[] = [];
  let hidden = 0;
  for (const key of keys) {
    if (withheld(key)) {
      hidden++;
      continue;
    }
    const was = before && key in before ? text(before[key]) : null;
    const is = after && key in after ? text(after[key]) : null;
    if ((before && key in before && was === null) || (after && key in after && is === null)) {
      hidden++;
      continue;
    }
    if (before && after && was === is) continue;
    changes.push({ field: label(key), before: before ? was : null, after: after ? is : null });
  }
  return { changes, withheld: hidden };
}

export function auditDetail(params: string | null): AuditDetail {
  const empty: AuditDetail = { reason: null, changes: null, fields: [], withheld: 0, unreadable: false };
  if (params === null || params.trim() === "") return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(params);
  } catch {
    // Rows written before params were always JSON exist. Said, not hidden.
    return { ...empty, unreadable: true };
  }
  if (!isObject(parsed)) {
    const value = text(parsed);
    return value === null || value === "none" ? { ...empty, withheld: value === null ? 1 : 0 } : { ...empty, fields: [{ name: "Recorded", value }] };
  }

  const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : null;
  const before = isObject(parsed.before) ? parsed.before : null;
  const after = isObject(parsed.after) ? parsed.after : null;
  let hidden = 0;
  let changes: AuditChange[] | null = null;
  if (before || after) {
    const diff = changesOf(before, after);
    changes = diff.changes;
    hidden += diff.withheld;
  }

  const fields: AuditField[] = [];
  for (const [key, v] of Object.entries(parsed)) {
    // The reason is shown above the fields, and a blank one is no reason at all.
    if (key === "reason" && typeof v === "string") continue;
    if ((key === "before" && before) || (key === "after" && after)) continue;
    const value = withheld(key) ? null : text(v);
    if (value === null) {
      hidden++;
      continue;
    }
    fields.push({ name: label(key), value });
  }
  return { reason, changes, fields, withheld: hidden, unreadable: false };
}
