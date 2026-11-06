// As lists too, for a tool schema's enum (area 11, T4).
export const DOC_TYPE_LIST = [
  "core", "concept", "semantic", "note", "decision", "spec", "task", "protocol",
  "post", "episodic", "procedural", "source", "prompt", "reference",
] as const;
export const DOC_TYPES = new Set<string>(DOC_TYPE_LIST);

// Editorial state only. Lint visibility is the archive/ prefix, not this column.
export const DOC_STATUS_LIST = ["draft", "ready", "active", "published", "superseded", "closed"] as const;
export const DOC_STATUSES = new Set<string>(DOC_STATUS_LIST);

export function validateDocType(type: string): string | null {
  if (DOC_TYPES.has(type)) return null;
  return `unknown type '${type}'; valid types: ${[...DOC_TYPES].join(", ")}. Session logs and handoffs are 'episodic'.`;
}

export function validateDocStatus(status: string): string | null {
  if (DOC_STATUSES.has(status)) return null;
  return `unknown status '${status}'; valid statuses: ${[...DOC_STATUSES].join(", ")}. Status does not control lint visibility; only the archive/ path prefix does.`;
}
