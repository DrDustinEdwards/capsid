// THE D1 FAKE'S WHERE, SET AND SELECT EVALUATOR (audit 2026-09-25, C1-17).
//
// Part of the one D1 fake in test/fakes.ts, not a second fake. Before this, the fake
// recorded every write to documents, audit_log, jobs and namespaces without applying
// it, answered every run() with changes: 1, returned a raw job row for a COUNT, and
// resolved a jobs or documents lookup from one or two of its filters. A handler that
// dropped a predicate could not fail against it.
//
// It covers the statement shapes src/ writes and no more: comparisons, IS, IN, LIKE,
// GLOB, AND, OR and parentheses in a WHERE; bound markers, literals, COALESCE, substr,
// datetime('now'), `||` and `+` in a value; single-table SELECTs with COUNT and SUM
// aggregates, GROUP BY, ORDER BY and LIMIT. ANYTHING ELSE THROWS, so a new shape is a
// loud failure to model rather than a filter silently ignored. A subquery (EXISTS,
// IN (SELECT ...)) and a JOIN are refused here: the callers that issue one are modelled
// by name in fakes.ts.

export type Row = Record<string, unknown>;

export interface EvalContext {
  params: unknown[];
  row?: Row;
  // The row an upsert tried to insert, for `excluded.col`.
  excluded?: Row;
}

const unmodelled = (what: string, text: string): Error =>
  new Error(`fake D1: unmodelled ${what} '${text}'. Model it in test/fake-sql.ts rather than ignoring it.`);

// SQLite's datetime('now') text form, from the real clock, so an age predicate such as
// `seen_at < datetime('now', '-1 day')` compares against the same instant the database would.
export function sqliteNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace("T", " ");
}

function modifierMs(modifier: string): number {
  const m = /^([+-]?\d+(?:\.\d+)?) (day|hour|minute|second)s?$/i.exec(modifier.trim());
  if (!m) throw unmodelled("datetime modifier", modifier);
  const unit = { day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1000 }[m[2].toLowerCase() as "day"];
  return Number(m[1]) * unit;
}

// Split at a delimiter that sits outside quotes and parentheses. The delimiter match is
// case-insensitive, so " AND " also splits " and ".
export function splitTop(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  const want = delimiter.toUpperCase();
  let depth = 0;
  let quoted = false;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") quoted = !quoted;
    if (quoted) continue;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && text.slice(i, i + want.length).toUpperCase() === want) {
      parts.push(text.slice(from, i));
      from = i + want.length;
      i += want.length - 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((p) => p.trim());
}

// `(a OR b)` wrapped whole, as opposed to `(a) OR (b)`.
function unwrap(text: string): string {
  let t = text.trim();
  while (t.startsWith("(") && t.endsWith(")")) {
    let depth = 0;
    let quoted = false;
    let wholly = true;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === "'") quoted = !quoted;
      if (quoted) continue;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (depth === 0 && i < t.length - 1) {
        wholly = false;
        break;
      }
    }
    if (!wholly) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

function column(row: Row | undefined, name: string, text: string): unknown {
  if (!row) throw unmodelled("column reference outside a row", text);
  return row[name] ?? null;
}

export function evalExpr(expr: string, ctx: EvalContext): unknown {
  const t = unwrap(expr);
  const concat = splitTop(t, "||");
  if (concat.length > 1) {
    const pieces = concat.map((p) => evalExpr(p, ctx));
    return pieces.some((p) => p === null || p === undefined) ? null : pieces.map(String).join("");
  }
  const sum = splitTop(t, " + ");
  if (sum.length > 1) {
    const terms = sum.map((p) => evalExpr(p, ctx));
    return terms.some((p) => p === null || p === undefined) ? null : terms.reduce<number>((n, p) => n + Number(p), 0);
  }
  const marker = /^\?(\d+)$/.exec(t);
  if (marker) return ctx.params[Number(marker[1]) - 1] ?? null;
  if (/^'(?:[^']|'')*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (/^NULL$/i.test(t)) return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const call = /^(\w+)\((.*)\)$/s.exec(t);
  if (call) {
    const name = call[1].toLowerCase();
    const args = splitTop(call[2], ",");
    if (name === "datetime" && /^'now'$/i.test(args[0])) {
      return sqliteNow(args[1] === undefined ? 0 : modifierMs(String(evalExpr(args[1], ctx))));
    }
    if (name === "coalesce") {
      for (const a of args) {
        const v = evalExpr(a, ctx);
        if (v !== null && v !== undefined) return v;
      }
      return null;
    }
    if (name === "substr") {
      const v = evalExpr(args[0], ctx);
      if (v === null) return null;
      const start = Number(evalExpr(args[1], ctx));
      const length = args[2] === undefined ? undefined : Number(evalExpr(args[2], ctx));
      return String(v).substr(start - 1, length);
    }
    if (name === "json_array_length") {
      const v = evalExpr(args[0], ctx);
      return v === null ? null : (JSON.parse(String(v)) as unknown[]).length;
    }
    if (name === "length") {
      const v = evalExpr(args[0], ctx);
      return v === null ? null : String(v).length;
    }
    throw unmodelled("function", t);
  }
  const excluded = /^excluded\.(\w+)$/i.exec(t);
  if (excluded) {
    if (!ctx.excluded) throw unmodelled("excluded reference outside an upsert", t);
    return ctx.excluded[excluded[1]] ?? null;
  }
  const qualified = /^\w+\.(\w+)$/.exec(t);
  if (qualified) return column(ctx.row, qualified[1], t);
  if (/^[a-z_]\w*$/i.test(t)) return column(ctx.row, t, t);
  throw unmodelled("expression", t);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function likeToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${body}$`, "is");
}

function globToRegExp(pattern: string): RegExp {
  if (/[?[]/.test(pattern)) throw unmodelled("GLOB metacharacter", pattern);
  const body = pattern.replace(/[.+^${}()|\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${body}$`, "s");
}

function listValues(list: string, ctx: EvalContext): unknown[] {
  if (/^\s*SELECT\b/i.test(list)) throw unmodelled("IN subquery", list);
  return splitTop(list, ",").map((item) => evalExpr(item, ctx));
}

const COMPARATORS = ["<=", ">=", "<>", "!=", "=", "<", ">"];

function findComparator(t: string): { at: number; op: string } | null {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "'") quoted = !quoted;
    if (quoted) continue;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0) {
      if (t.slice(i, i + 2) === "||") {
        i++;
        continue;
      }
      const op = COMPARATORS.find((o) => t.slice(i, i + o.length) === o);
      if (op) return { at: i, op };
    }
  }
  return null;
}

export function evalCond(cond: string, ctx: EvalContext): boolean {
  const t = unwrap(cond);
  const ors = splitTop(t, " OR ");
  if (ors.length > 1) return ors.some((p) => evalCond(p, ctx));
  const ands = splitTop(t, " AND ");
  if (ands.length > 1) return ands.every((p) => evalCond(p, ctx));
  if (/^(NOT )?EXISTS\b/i.test(t)) throw unmodelled("EXISTS subquery", t);
  let m = /^(.+?) IS NOT NULL$/is.exec(t);
  if (m) return evalExpr(m[1], ctx) !== null;
  m = /^(.+?) IS NULL$/is.exec(t);
  if (m) return evalExpr(m[1], ctx) === null;
  m = /^(.+?) IS NOT (.+)$/is.exec(t);
  if (m) return evalExpr(m[1], ctx) !== evalExpr(m[2], ctx);
  m = /^(.+?) IS (.+)$/is.exec(t);
  if (m) return evalExpr(m[1], ctx) === evalExpr(m[2], ctx);
  m = /^(.+?) (NOT )?IN \((.*)\)$/is.exec(t);
  if (m) {
    const v = evalExpr(m[1], ctx);
    if (v === null) return false;
    const hit = listValues(m[3], ctx).some((x) => x !== null && compare(v, x) === 0);
    return m[2] ? !hit : hit;
  }
  m = /^(.+?) (NOT )?LIKE (.+)$/is.exec(t);
  if (m) {
    const v = evalExpr(m[1], ctx);
    const p = evalExpr(m[3], ctx);
    if (v === null || p === null) return false;
    const hit = likeToRegExp(String(p)).test(String(v));
    return m[2] ? !hit : hit;
  }
  m = /^(.+?) GLOB (.+)$/is.exec(t);
  if (m) {
    const v = evalExpr(m[1], ctx);
    const p = evalExpr(m[2], ctx);
    if (v === null || p === null) return false;
    return globToRegExp(String(p)).test(String(v));
  }
  const found = findComparator(t);
  if (!found) throw unmodelled("condition", t);
  const a = evalExpr(t.slice(0, found.at), ctx);
  const b = evalExpr(t.slice(found.at + found.op.length), ctx);
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const c = compare(a, b);
  switch (found.op) {
    case "=":
      return c === 0;
    case "!=":
    case "<>":
      return c !== 0;
    case "<":
      return c < 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    default:
      return c >= 0;
  }
}

// `SET a = ?1, b = b + 1` against one row. Every right-hand side is evaluated against the
// row BEFORE the update, as SQLite does.
export function applySet(clause: string, ctx: EvalContext & { row: Row }): Row {
  const patch: Row = {};
  for (const assignment of splitTop(clause, ",")) {
    const eq = assignment.indexOf("=");
    if (eq < 0) throw unmodelled("assignment", assignment);
    const target = assignment.slice(0, eq).trim().replace(/^\w+\./, "");
    patch[target] = evalExpr(assignment.slice(eq + 1), ctx);
  }
  return patch;
}

// ---- single-table SELECT ------------------------------------------------------

interface SelectParts {
  list: string;
  table: string;
  where: string | null;
  groupBy: string | null;
  orderBy: string | null;
  limit: string | null;
}

export function parseSelect(sql: string): SelectParts | null {
  const flat = sql.replace(/\s+/g, " ").trim();
  const m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: GROUP BY (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\S+))?$/i.exec(flat);
  if (!m) return null;
  return { list: m[1], table: m[2], where: m[3] ?? null, groupBy: m[4] ?? null, orderBy: m[5] ?? null, limit: m[6] ?? null };
}

const AGGREGATE = /\b(COUNT|SUM)\(/i;

function aggregateItem(expr: string, group: Row[], ctx: EvalContext): unknown {
  const t = unwrap(expr);
  if (/^COUNT\(\*\)$/i.test(t)) return group.length;
  const sum = /^SUM\((.+)\)$/i.exec(t);
  if (sum) {
    const values = group.map((row) => evalExpr(sum[1], { ...ctx, row })).filter((v) => v !== null);
    return values.length ? values.reduce<number>((n, v) => n + Number(v), 0) : null;
  }
  const coalesce = /^COALESCE\((.+)\)$/i.exec(t);
  if (coalesce) {
    for (const arg of splitTop(coalesce[1], ",")) {
      const v = AGGREGATE.test(arg) ? aggregateItem(arg, group, ctx) : evalExpr(arg, { ...ctx, row: group[0] });
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }
  if (AGGREGATE.test(t)) throw unmodelled("aggregate", t);
  return group.length ? evalExpr(t, { ...ctx, row: group[0] }) : null;
}

function itemName(item: string): { expr: string; name: string } {
  const as = /^(.+) AS (\w+)$/is.exec(item.trim());
  if (as) return { expr: as[1].trim(), name: as[2] };
  return { expr: item.trim(), name: item.trim().replace(/^\w+\./, "") };
}

// Filter, group, order and limit one table's rows as the statement asks. Refuses a JOIN
// or a subquery, which parseSelect's shape cannot hold.
export function selectRows(table: Row[], sql: string, params: unknown[]): Row[] {
  const parts = parseSelect(sql);
  if (!parts) throw unmodelled("SELECT", sql.replace(/\s+/g, " ").trim());
  if (/\bSELECT\b/i.test(parts.where ?? "") || /\bSELECT\b/i.test(parts.list)) throw unmodelled("subquery", sql);
  const ctx: EvalContext = { params };
  let rows = table.filter((row) => (parts.where ? evalCond(parts.where, { ...ctx, row }) : true));
  const items = parts.list.trim() === "*" ? null : splitTop(parts.list, ",").map(itemName);
  const aggregated = Boolean(parts.groupBy) || (items ?? []).some((i) => AGGREGATE.test(i.expr));
  let out: Row[];
  if (aggregated) {
    if (!items) throw unmodelled("SELECT * with GROUP BY", sql);
    const keys = parts.groupBy ? splitTop(parts.groupBy, ",") : [];
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = JSON.stringify(keys.map((k) => evalExpr(k, { ...ctx, row })));
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    // An aggregate with no GROUP BY answers one row even over no rows, as SQL does.
    if (!keys.length && !groups.size) groups.set("[]", []);
    out = [...groups.values()].map((group) =>
      Object.fromEntries(items.map((i) => [i.name, aggregateItem(i.expr, group, ctx)]))
    );
    rows = out;
  }
  if (parts.orderBy) {
    const terms = splitTop(parts.orderBy, ",").map((term) => {
      const desc = / DESC$/i.test(term);
      return { expr: term.replace(/ (ASC|DESC)$/i, ""), desc };
    });
    rows = [...rows].sort((a, b) => {
      for (const term of terms) {
        const x = evalExpr(term.expr, { ...ctx, row: a });
        const y = evalExpr(term.expr, { ...ctx, row: b });
        const c = x === y ? 0 : x === null ? -1 : y === null ? 1 : compare(x, y);
        if (c !== 0) return term.desc ? -c : c;
      }
      return 0;
    });
  }
  if (parts.limit) rows = rows.slice(0, Number(evalExpr(parts.limit, ctx)));
  if (aggregated || !items) return rows.map((r) => ({ ...r }));
  return rows.map((row) => Object.fromEntries(items.map((i) => [i.name, evalExpr(i.expr, { ...ctx, row })])));
}

// ---- writes -------------------------------------------------------------------

export interface TableSpec {
  rows: Row[];
  // UNIQUE and PRIMARY KEY column sets. An INSERT that collides with one throws, as
  // SQLite does, unless the statement says OR IGNORE or ON CONFLICT.
  unique: string[][];
  // The column defaults the migrations declare, applied before the inserted values.
  defaults?: () => Row;
  // INTEGER PRIMARY KEY AUTOINCREMENT.
  autoId?: boolean;
}

export interface WriteResult {
  changes: number;
  returning: Row[];
}

function returningOf(clause: string | undefined, row: Row, params: unknown[]): Row[] {
  if (!clause) return [];
  const items = splitTop(clause, ",").map(itemName);
  return [Object.fromEntries(items.map((i) => [i.name, evalExpr(i.expr, { params, row })]))];
}

// INSERT ... VALUES [ON CONFLICT ...], UPDATE ... WHERE and DELETE ... WHERE against one
// table. Returns null for a statement of another shape (INSERT ... SELECT), which the
// caller models by name or refuses.
export function applyWrite(tables: Record<string, TableSpec>, sql: string, params: unknown[]): WriteResult | null {
  const flat = sql.replace(/\s+/g, " ").trim();
  const insert =
    /^INSERT (OR IGNORE )?INTO (\w+) \(([^)]+)\) VALUES \((.+?)\)(?: ON CONFLICT ?\(([^)]+)\) DO (NOTHING|UPDATE SET (.+?)))?(?: RETURNING (.+))?$/i.exec(
      flat
    );
  if (insert) {
    const [, orIgnore, name, colList, valueList, , action, setClause, returning] = insert;
    const spec = tables[name];
    if (!spec) throw unmodelled("table", name);
    const cols = splitTop(colList, ",");
    const values = splitTop(valueList, ",");
    if (cols.length !== values.length) throw new Error(`fake D1: ${cols.length} columns against ${values.length} values in: ${flat}`);
    const row: Row = { ...(spec.defaults?.() ?? {}) };
    cols.forEach((c, i) => (row[c] = evalExpr(values[i], { params })));
    const clash = spec.rows.find((existing) =>
      spec.unique.some((key) => key.every((k) => existing[k] !== null && existing[k] !== undefined && existing[k] === row[k]))
    );
    if (clash) {
      if (orIgnore || /^NOTHING$/i.test(action ?? "")) return { changes: 0, returning: [] };
      if (setClause) {
        Object.assign(clash, applySet(setClause, { params, row: clash, excluded: row }));
        return { changes: 1, returning: returningOf(returning, clash, params) };
      }
      throw new Error(`D1_ERROR: UNIQUE constraint failed: ${name}`);
    }
    if (spec.autoId && (row.id === undefined || row.id === null)) {
      row.id = spec.rows.reduce((max, r) => Math.max(max, Number(r.id ?? 0)), 0) + 1;
    }
    spec.rows.push(row);
    return { changes: 1, returning: returningOf(returning, row, params) };
  }
  const update = /^UPDATE (\w+) SET (.+?) WHERE (.+?)(?: RETURNING (.+))?$/i.exec(flat);
  if (update) {
    const [, name, setClause, where, returning] = update;
    const spec = tables[name];
    if (!spec) throw unmodelled("table", name);
    const hits = spec.rows.filter((row) => evalCond(where, { params, row }));
    const patches = hits.map((row) => applySet(setClause, { params, row }));
    hits.forEach((row, i) => Object.assign(row, patches[i]));
    return { changes: hits.length, returning: hits.flatMap((row) => returningOf(returning, row, params)) };
  }
  const del = /^DELETE FROM (\w+) WHERE (.+)$/i.exec(flat);
  if (del) {
    const [, name, where] = del;
    const spec = tables[name];
    if (!spec) throw unmodelled("table", name);
    const keep = spec.rows.filter((row) => !evalCond(where, { params, row }));
    const changes = spec.rows.length - keep.length;
    spec.rows.length = 0;
    spec.rows.push(...keep);
    return { changes, returning: [] };
  }
  return null;
}
