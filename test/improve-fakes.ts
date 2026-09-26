// The improve tables, taught to the one D1 fake.
//
// A separate module, not a second fake: test/fakes.ts owns the single fakeD1(),
// and this file is the dialect it delegates to when a statement names an improve_*
// table.
//
// It is row-backed and bind-aware, because a fake that answers on SQL shape alone
// cannot disagree with the handler. Asking for the wrong run id gets nothing back,
// as D1 would answer.
//
// It throws on a statement it does not recognise. Returning an empty result for an
// unmodelled shape would let the handler take its empty-set branch and make the
// assertion about that branch vacuously true.

export const IMPROVE_RUN_DEFAULTS: Record<string, unknown> = {
  id: "run-1",
  namespace: "capsid",
  mode: "api",
  started: "2026-09-01 08:00:00",
  finished: null,
  attempts: 0,
  kept: 0,
  reverts: 0,
  cost_usd: 0,
  ci_minutes: 0,
  status: "opening",
  consecutive_reverts: 0,
  consecutive_unjudged: 0,
  current_attempt: null,
  base_sha: "base000",
  pr_url: null,
  note: null,
  condition: "full",
  advanced_at: "2026-09-01 08:00:00",
};

export const IMPROVE_ATTEMPT_DEFAULTS: Record<string, unknown> = {
  id: "attempt-1",
  namespace: "capsid",
  run_id: "run-1",
  change_summary: null,
  diff_ref: null,
  score_before: null,
  score_after: null,
  kept: 0,
  reason: null,
  lineage_parent: null,
  status: "pending",
  branch: null,
  head_sha: null,
  base_sha: null,
  flagged: 0,
  flag_reason: null,
  skill_id: null,
  anchors_json: null,
  secondary_json: null,
  dispatched_at: null,
  ts: "2026-09-01 08:00:00",
};

export const IMPROVE_SKILL_DEFAULTS: Record<string, unknown> = {
  id: "skill-1",
  source_namespace: "foxing",
  title: "A skill",
  body_ref: "improve/skills/skill-1.md",
  wins: 0,
  losses: 0,
  source_attempt: null,
  ts: "2026-09-01 08:00:00",
};

export interface ImproveRows {
  improve_runs: Array<Record<string, unknown>>;
  improve_attempts: Array<Record<string, unknown>>;
  improve_scores: Array<Record<string, unknown>>;
  improve_skills: Array<Record<string, unknown>>;
  // The replay cache (migrations/0004). Row-backed so the PRIMARY KEY behaviour is
  // modelled: a second claim of the same (scope, jti) returns no row.
  improve_jti: Array<Record<string, unknown>>;
  // The skill lifecycle's evidence (migrations 0012 and 0013). Row-backed like the
  // rest so a summary assertion can actually disagree with the handler.
  skill_evaluations: Array<Record<string, unknown>>;
  skill_edits: Array<Record<string, unknown>>;
  skill_failures: Array<Record<string, unknown>>;
  // The recommend branch needs the document bodies, because the query it models joins
  // documents_fts and matches against a skill's prose. Optional: only that branch
  // reads it, and fakeD1 passes its own rows object, which carries documents.
  documents?: ReadonlyArray<{ namespace: string; path: string; body?: string | null }>;
  // The skill transition's audit row lands here when its condition holds. Optional
  // for the same reason as documents: fakeD1 passes its own rows object.
  audit_log?: Array<Record<string, unknown>>;
}

export type ImproveAnswer = { handled: false } | { handled: true; results: unknown[] };

import { evalCond, selectRows, splitTop, sqliteNow } from "./fake-sql.ts";

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

export function isImproveStatement(sql: string): boolean {
  return /\b(improve_(runs|attempts|scores|skills|jti)|skill_evaluations|skill_edits|skill_failures)\b/i.test(sql);
}

// The column list from `INSERT INTO t (a, b, c) VALUES (?1, ?2, ?3)`, paired with
// the bound values by POSITION, resolved from the ?N markers rather than assumed
// to be 1..n in order. A literal in the VALUES list (there is one, `0`) is carried
// through as itself.
//
// The VALUES list is read to its balanced closing parenthesis and split at top-level
// commas, so the `)` inside `datetime('now')` does not end it.
function valuesList(text: string): string | undefined {
  const open = /VALUES \(/i.exec(text);
  if (!open) return undefined;
  let depth = 1;
  let quoted = false;
  for (let i = open.index + open[0].length; i < text.length; i++) {
    const c = text[i];
    if (c === "'") quoted = !quoted;
    if (quoted) continue;
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(open.index + open[0].length, i);
  }
  return undefined;
}

function insertRow(sql: string, params: unknown[]): Record<string, unknown> {
  const text = flat(sql);
  const cols = /INSERT INTO \w+ \(([^)]+)\)/i.exec(text)?.[1];
  const vals = valuesList(text);
  if (!cols || !vals) throw new Error(`improve fake: could not parse the INSERT column list from: ${text}`);
  const names = cols.split(",").map((c) => c.trim());
  const values = splitTop(vals, ",");
  if (names.length !== values.length) {
    throw new Error(`improve fake: ${names.length} columns against ${values.length} values in: ${text}`);
  }
  const row: Record<string, unknown> = {};
  names.forEach((name, i) => {
    const value = values[i];
    const marker = /^\?(\d+)$/.exec(value);
    if (marker) row[name] = params[Number(marker[1]) - 1];
    else if (/^'.*'$/.test(value)) row[name] = value.slice(1, -1);
    else if (value === "datetime('now')") row[name] = "2026-09-01 08:00:00";
    else if (/^-?\d+(\.\d+)?$/.test(value)) row[name] = Number(value);
    else throw new Error(`improve fake: unmodelled VALUES entry '${value}' in: ${text}`);
  });
  return row;
}

// `SET a = ?1, b = datetime('now'), c = c + 1` into a patch. Handles the three
// forms the code actually emits and refuses anything else, so a fourth form is a
// failure rather than a silently ignored assignment.
function setPatch(sql: string, params: unknown[], current: Record<string, unknown>): Record<string, unknown> {
  const clause = /SET (.+?)(?: WHERE | RETURNING |$)/i.exec(flat(sql))?.[1];
  if (!clause) throw new Error(`improve fake: could not parse a SET clause from: ${flat(sql)}`);
  const patch: Record<string, unknown> = {};
  for (const assignment of clause.split(/,\s*(?=[a-z_]+\s*=)/i)) {
    const [rawCol, rawVal] = assignment.split("=").map((x) => x.trim());
    const marker = /^\?(\d+)$/.exec(rawVal);
    if (marker) patch[rawCol] = params[Number(marker[1]) - 1];
    else if (rawVal === "datetime('now')") patch[rawCol] = "2026-09-01 08:05:00";
    else if (/^'.*'$/.test(rawVal)) patch[rawCol] = rawVal.slice(1, -1);
    else if (new RegExp(`^${rawCol} \\+ 1$`).test(rawVal)) patch[rawCol] = Number(current[rawCol] ?? 0) + 1;
    else if (/^\d+(\.\d+)?$/.test(rawVal)) patch[rawCol] = Number(rawVal);
    else throw new Error(`improve fake: unmodelled assignment '${assignment}' in: ${flat(sql)}`);
  }
  return patch;
}

// The trailing `WHERE id = ?n AND status = ?m` of the guarded run update. Read
// from the END of the bind list rather than by position, because advanceRun
// appends the two predicate binds after however many the patch produced.
function guardedWhere(sql: string, params: unknown[]): { id: unknown; status: unknown } | null {
  const text = flat(sql);
  const m = /WHERE id = \?(\d+) AND status = \?(\d+)/i.exec(text);
  if (!m) return null;
  return { id: params[Number(m[1]) - 1], status: params[Number(m[2]) - 1] };
}

export function improveExec(sql: string, params: unknown[], rows: ImproveRows): ImproveAnswer {
  const text = flat(sql);
  if (!isImproveStatement(text)) return { handled: false };

  // The backup dump, which reads every table with a bare `SELECT * FROM <table>`.
  // Handled first so the per-table readers do not mistake it for a filtered read.
  const dump = /^SELECT \* FROM (improve_\w+)$/i.exec(text);
  if (dump) {
    // documents is excluded: this branch only matches improve_* tables, and including
    // it would widen the result type to the read-only shape the recommend branch uses.
    // audit_log is excluded because no improve_* dump names it.
    const table = dump[1] as Exclude<keyof ImproveRows, "documents" | "audit_log">;
    if (!(table in rows)) throw new Error(`improve fake: the dump named an unknown table '${table}'`);
    return { handled: true, results: rows[table] };
  }

  // runs

  if (/^INSERT INTO improve_runs/i.test(text)) {
    const row = { ...IMPROVE_RUN_DEFAULTS, ...insertRow(text, params) };
    // The partial unique index: one active run per namespace.
    const clash = rows.improve_runs.some(
      (r) => r.namespace === row.namespace && r.status !== "done" && r.status !== "paused"
    );
    if (clash) throw new Error("UNIQUE constraint failed: improve_runs.namespace (improve_runs_one_active)");
    rows.improve_runs.push(row);
    return { handled: true, results: [] };
  }

  if (/^UPDATE improve_runs/i.test(text)) {
    const where = guardedWhere(text, params);
    if (!where) throw new Error(`improve fake: an unguarded UPDATE on improve_runs: ${text}`);
    const row = rows.improve_runs.find((r) => r.id === where.id && r.status === where.status);
    if (!row) return { handled: true, results: [] };
    Object.assign(row, setPatch(text, params, row));
    return { handled: true, results: [{ id: row.id }] };
  }

  // The budget month-spend aggregate: whole-table sums bounded by started date.
  if (/^SELECT COALESCE\(SUM\(cost_usd\), 0\) AS cost_usd/i.test(text) && /started >= \?1/i.test(text)) {
    const from = String(params[0]);
    const inMonth = rows.improve_runs.filter((r) => String(r.started) >= from);
    const sum = (key: string) => inMonth.reduce((n, r) => n + Number(r[key] ?? 0), 0);
    return { handled: true, results: [{ cost_usd: sum("cost_usd"), ci_minutes: sum("ci_minutes") }] };
  }

  if (/^SELECT COUNT\(\*\) AS runs/i.test(text)) {
    const ns = params[0];
    const mine = rows.improve_runs.filter((r) => r.namespace === ns);
    const sum = (key: string) => mine.reduce((n, r) => n + Number(r[key] ?? 0), 0);
    return {
      handled: true,
      results: [
        {
          runs: mine.length,
          attempts: sum("attempts"),
          kept: sum("kept"),
          reverts: sum("reverts"),
          cost_usd: sum("cost_usd"),
          ci_minutes: sum("ci_minutes"),
        },
      ],
    };
  }

  // The meta-loop aggregate. Grouped by namespace over every run, with `flagged`
  // counted from the attempts table. The date predicate is not modelled: fixtures
  // are small and every row in one is deliberately in scope.
  if (/FROM improve_runs r/i.test(text) && /GROUP BY r\.namespace/i.test(text)) {
    const byNs = new Map<string, Record<string, number>>();
    for (const r of rows.improve_runs) {
      const ns = String(r.namespace);
      const acc = byNs.get(ns) ?? { runs: 0, attempts: 0, kept: 0, reverts: 0, cost_usd: 0, flagged: 0 };
      acc.runs += 1;
      acc.attempts += Number(r.attempts ?? 0);
      acc.kept += Number(r.kept ?? 0);
      acc.reverts += Number(r.reverts ?? 0);
      acc.cost_usd += Number(r.cost_usd ?? 0);
      byNs.set(ns, acc);
    }
    for (const [ns, acc] of byNs) {
      acc.flagged = rows.improve_attempts.filter((a) => a.namespace === ns && Number(a.flagged) === 1).length;
    }
    return {
      handled: true,
      results: [...byNs.entries()].map(([namespace, acc]) => ({ namespace, ...acc })).sort((a, b) => a.namespace.localeCompare(b.namespace)),
    };
  }

  // The per-namespace kept and reverted totals (src/agent-record.ts,
  // src/console-reputation.ts), matched before the reader below, which would return
  // one raw row per run instead of one summed row per namespace.
  if (/^SELECT namespace, .+ FROM improve_runs GROUP BY namespace$/i.test(text)) {
    return { handled: true, results: selectRows(rows.improve_runs, text, params) };
  }

  if (/FROM improve_runs/i.test(text)) {
    if (/\b(GROUP BY|SUM\(|COUNT\()/i.test(text)) {
      throw new Error(`improve fake: an unmodelled aggregate over improve_runs: ${text}`);
    }
    let out = [...rows.improve_runs];
    if (/WHERE id = \?1/i.test(text)) out = out.filter((r) => r.id === params[0]);
    else {
      if (/namespace = \?1/i.test(text)) out = out.filter((r) => r.namespace === params[0]);
      if (/status NOT IN \('done', 'paused'\)/i.test(text)) out = out.filter((r) => r.status !== "done" && r.status !== "paused");
    }
    if (/ORDER BY started DESC/i.test(text)) out.sort((a, b) => String(b.started).localeCompare(String(a.started)));
    if (/ORDER BY advanced_at ASC/i.test(text)) out.sort((a, b) => String(a.advanced_at).localeCompare(String(b.advanced_at)));
    const literal = /LIMIT (\d+)/i.exec(text);
    const bound = /LIMIT \?(\d+)/i.exec(text);
    const limit = literal ? Number(literal[1]) : bound ? Number(params[Number(bound[1]) - 1]) : out.length;
    return { handled: true, results: out.slice(0, limit) };
  }

  // the replay cache

  // INSERT ... ON CONFLICT DO NOTHING RETURNING. The database decides who claimed the
  // nonce, so the fake models the uniqueness: a row already present returns nothing.
  if (/^INSERT INTO improve_jti/i.test(text)) {
    const [scope, jti] = params;
    const already = rows.improve_jti.some((r) => r.scope === scope && r.jti === jti);
    if (already) return { handled: true, results: [] };
    rows.improve_jti.push({ scope, jti, seen_at: sqliteNow() });
    return { handled: true, results: [{ jti }] };
  }

  // The nightly prune, which drops only nonces older than a day. The WHERE clause is
  // evaluated, so a recent nonce stays and a replay of it is still refused.
  if (/^DELETE FROM improve_jti/i.test(text)) {
    const where = /^DELETE FROM improve_jti WHERE (.+)$/i.exec(text)?.[1];
    if (!where) throw new Error(`improve fake: an unfiltered DELETE on improve_jti: ${text}`);
    const keep = rows.improve_jti.filter((row) => !evalCond(where, { params, row }));
    rows.improve_jti.length = 0;
    rows.improve_jti.push(...keep);
    return { handled: true, results: [] };
  }

  // The whole-table read the nightly dump makes, matched before the filtered ones so
  // a `SELECT *` is not answered by a branch that expects bound parameters.
  if (/^SELECT \* FROM skill_(evaluations|edits|failures)/i.test(text)) {
    const table = /FROM (skill_\w+)/i.exec(text)?.[1] as "skill_evaluations" | "skill_edits" | "skill_failures";
    return { handled: true, results: rows[table] };
  }


  // The existence check jobs.complete runs over the skill ids a driver names,
  // modelled so the refusal can be driven.
  if (/^SELECT id FROM improve_skills WHERE id IN/i.test(text)) {
    const named = params.map(String);
    const out = rows.improve_skills.filter((s) => named.includes(String(s.id))).map((s) => ({ id: s.id }));
    return { handled: true, results: out };
  }

  // The recommend query, matched before the generic `FROM improve_skills s` reader
  // below, which would otherwise claim it and answer from the wrong table.
  if (/JOIN documents_fts f/i.test(text)) {
    const like = String(params[1] ?? "");
    const ns = like.replace(/^%"|"%$/g, "");
    const terms = String(params[0] ?? "").toLowerCase().split(" or ").filter(Boolean);
    const limit = Number(params[2] ?? 3);
    const out = rows.improve_skills.filter((s) => {
      if (!["candidate", "live"].includes(String(s.status))) return false;
      if (s.trigger_condition === null || s.trigger_condition === undefined) return false;
      if (s.namespaces !== null && s.namespaces !== undefined && !String(s.namespaces).includes('"' + ns + '"')) return false;
      // The MATCH, modelled: the skill's document body must contain one of the terms.
      const doc = (rows.documents ?? []).find((d) => d.path === s.body_ref && d.namespace === "capsid");
      const body = String(doc?.body ?? "").toLowerCase();
      return terms.some((t) => body.includes(t));
    });
    return { handled: true, results: out.slice(0, limit) };
  }

  // Every candidate and live skill, for the transition pass.
  if (/^SELECT id, status, version FROM improve_skills/i.test(text)) {
    const out = rows.improve_skills.filter((s) => ["candidate", "live"].includes(String(s.status)));
    return { handled: true, results: out };
  }

  // What the evaluation cycle dispatches, read after its transitions. The status
  // filter is read from the SQL, so a cycle that stopped asking for it would dispatch
  // retired skills here as it would against SQLite.
  if (/^SELECT id, version, source_namespace FROM improve_skills/i.test(text)) {
    const onlyOpen = /status IN \('candidate', 'live'\)/i.test(text);
    const out = rows.improve_skills
      .filter((s) => !onlyOpen || ["candidate", "live"].includes(String(s.status)))
      .map((s) => ({ id: s.id, version: s.version, source_namespace: s.source_namespace }));
    return { handled: true, results: out };
  }


  // The optimizer's negative feedback: refused proposals only, newest first.
  if (/FROM skill_edits/i.test(text)) {
    const skill = params[0];
    // The filter is read from the SQL, not assumed, so this can disagree with a
    // handler that stopped asking for `accepted = 0`.
    const onlyRejected = /accepted = 0/i.test(text);
    const mine = rows.skill_edits.filter((e) => e.skill === skill && (!onlyRejected || Number(e.accepted) === 0));
    mine.sort((a, b) => String(b.evaluated_at).localeCompare(String(a.evaluated_at)));
    return { handled: true, results: mine.slice(0, Number(params[1] ?? 5)) };
  }

  // The merge scan: live skills with a trigger, joined to their prose. Matched before
  // the generic `FROM improve_skills s` reader for the reason that one documents.
  if (/LEFT JOIN documents d/i.test(text)) {
    // Both filters read from the SQL, for the same reason as above.
    const onlyLive = /s\.status = 'live'/i.test(text);
    const needsTrigger = /s\.trigger_condition IS NOT NULL/i.test(text);
    const out = rows.improve_skills
      .filter(
        (s) =>
          (!onlyLive || String(s.status) === "live") &&
          (!needsTrigger || (s.trigger_condition !== null && s.trigger_condition !== undefined))
      )
      .map((s) => ({
        id: s.id,
        status: s.status,
        trigger_condition: s.trigger_condition,
        body: (rows.documents ?? []).find((d) => d.path === s.body_ref && d.namespace === "capsid")?.body ?? null,
      }));
    return { handled: true, results: out };
  }


  // The skill records summary (migrations 0012, 0013), modelled against the rows so
  // an assertion about the summary can fail.
  if (/SELECT status, COUNT\(\*\) AS n FROM improve_skills/i.test(text)) {
    const like = String(params[0] ?? "");
    const ns = like.replace(/^%"|"%$/g, "");
    const counts = new Map<string, number>();
    for (const skill of rows.improve_skills) {
      const scoped =
        skill.namespaces === null || skill.namespaces === undefined || String(skill.namespaces).includes('"' + ns + '"');
      if (!scoped) continue;
      const status = String(skill.status ?? "candidate");
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return { handled: true, results: [...counts].map(([status, n]) => ({ status, n })) };
  }

  if (/FROM skill_evaluations/i.test(text) && /MAX\(evaluated_at\)/i.test(text)) {
    const ns = params[0];
    const mine = rows.skill_evaluations.filter((e) => e.namespace === ns);
    const last = mine.map((e) => String(e.evaluated_at)).sort().pop() ?? null;
    return { handled: true, results: [{ last }] };
  }

  if (/FROM skill_evaluations/i.test(text)) {
    const [skill, version] = params;
    const mine = rows.skill_evaluations.filter((e) => e.skill === skill && e.version === version);
    mine.sort((a, b) => String(a.evaluated_at).localeCompare(String(b.evaluated_at)));
    return { handled: true, results: mine };
  }

  if (/^INSERT INTO skill_(evaluations|edits|failures)/i.test(text)) {
    const table = /^INSERT INTO (skill_\w+)/i.exec(text)?.[1] as "skill_evaluations" | "skill_edits" | "skill_failures";
    rows[table].push(insertRow(text, params));
    return { handled: true, results: [] };
  }

  if (/FROM skill_failures/i.test(text)) {
    const skill = params[0];
    const mine = rows.skill_failures.filter((f) => f.skill === skill);
    mine.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { handled: true, results: mine.slice(0, Number(params[1] ?? 2)) };
  }


  // Skills, matched before the attempts readers: the candidate query carries a
  // `NOT EXISTS (SELECT 1 FROM improve_attempts ...)` subquery, so an attempts
  // branch placed first would claim it and answer with the wrong table.
  if (/FROM improve_skills s/i.test(text)) {
    const ns = params[0];
    // Both filters are read from the SQL, so this branch can disagree with a query
    // that dropped one of them.
    const onlyOpen = /s\.status IN \('candidate', 'live'\)/i.test(text);
    const scoped = /s\.namespaces IS NULL OR s\.namespaces LIKE \?2/i.test(text);
    const out = rows.improve_skills.filter(
      (s) =>
        s.source_namespace !== ns &&
        (!onlyOpen || ["candidate", "live"].includes(String(s.status ?? "candidate"))) &&
        (!scoped || s.namespaces === null || s.namespaces === undefined || String(s.namespaces).includes('"' + String(ns) + '"')) &&
        !rows.improve_attempts.some((a) => a.skill_id === s.id && a.namespace === ns)
    );
    out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return { handled: true, results: out.slice(0, 200) };
  }


  // attempts

  if (/^INSERT INTO improve_attempts/i.test(text)) {
    rows.improve_attempts.push({ ...IMPROVE_ATTEMPT_DEFAULTS, ...insertRow(text, params) });
    return { handled: true, results: [] };
  }

  // The whole WHERE clause applies, including the late report's
  // `AND status IN ('unjudged', ...)` (src/improve/ingest.ts).
  if (/^UPDATE improve_attempts/i.test(text)) {
    const where = / WHERE (.+?)(?: RETURNING .+)?$/i.exec(text)?.[1];
    if (!where || !/^id = \?\d+\b/i.test(where)) {
      throw new Error(`improve fake: an UPDATE on improve_attempts with no id predicate: ${text}`);
    }
    const hits = rows.improve_attempts.filter((row) => evalCond(where, { params, row }));
    for (const row of hits) Object.assign(row, setPatch(text, params, row));
    return { handled: true, results: hits.map((row) => ({ id: row.id })) };
  }

  if (/FROM improve_attempts/i.test(text)) {
    let out = [...rows.improve_attempts];
    if (/WHERE id = \?1/i.test(text)) out = out.filter((a) => a.id === params[0]);
    else if (/WHERE run_id = \?1/i.test(text)) out = out.filter((a) => a.run_id === params[0]);
    else if (/WHERE namespace = \?1/i.test(text)) out = out.filter((a) => a.namespace === params[0]);
    if (/ORDER BY ts ASC/i.test(text)) out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    if (/ORDER BY ts DESC/i.test(text)) out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const bound = /LIMIT \?(\d+)/i.exec(text);
    const limit = bound ? Number(params[Number(bound[1]) - 1]) : out.length;
    return { handled: true, results: out.slice(0, limit) };
  }

  // scores

  if (/^INSERT INTO improve_scores/i.test(text)) {
    rows.improve_scores.push(insertRow(text, params));
    return { handled: true, results: [] };
  }

  if (/FROM improve_scores/i.test(text)) {
    const runId = params[0];
    const wantsBaseline = /attempt_id IS NULL/i.test(text);
    const out = rows.improve_scores.filter(
      (s) => s.run_id === runId && (wantsBaseline ? s.attempt_id === null || s.attempt_id === undefined : s.attempt_id === params[1])
    );
    return { handled: true, results: out.map((s) => ({ metric: s.metric, value: s.value })) };
  }

  // skills

  // The transition's audit row (commitTransition), inserted only when the skill now
  // holds the new status, so a transition that did not land writes no row.
  if (/^INSERT INTO audit_log .* WHERE EXISTS \(SELECT 1 FROM improve_skills WHERE id = \?3 AND status = \?4\)$/i.test(text)) {
    const [actor, auditParams, id, status] = params;
    if (rows.improve_skills.some((k) => k.id === id && k.status === status)) {
      rows.audit_log?.push({ actor, action: "skill-status-changed", namespace: null, path: null, params: auditParams });
    }
    return { handled: true, results: [] };
  }

  // An existing id is updated only when the statement says ON CONFLICT(id) DO UPDATE
  // (src/improve-skills.ts). A plain INSERT of a taken id fails the PRIMARY KEY and
  // aborts its batch, as in SQLite.
  if (/^INSERT INTO improve_skills/i.test(text)) {
    const row = { ...IMPROVE_SKILL_DEFAULTS, ...insertRow(text, params) };
    const existing = rows.improve_skills.find((k) => k.id === row.id);
    if (existing) {
      if (!/ ON CONFLICT\(id\) DO UPDATE SET title = \?3, body_ref = \?4$/i.test(text)) {
        throw new Error("UNIQUE constraint failed: improve_skills.id");
      }
      Object.assign(existing, { title: row.title, body_ref: row.body_ref });
    } else rows.improve_skills.push(row);
    return { handled: true, results: [] };
  }

  // The status transition (commitTransition): keyed on the expected status, so a status
  // that moved underneath the read is not overwritten, and stamped when it retires.
  if (/^UPDATE improve_skills SET status = \?3, retired_at = CASE/i.test(text)) {
    const [id, from, to, at] = params;
    const row = rows.improve_skills.find((k) => k.id === id && (!/AND status = \?2/i.test(text) || k.status === from));
    if (!row) return { handled: true, results: [] };
    row.status = to;
    if (to === "retired") row.retired_at = at;
    return { handled: true, results: [{ id: row.id }] };
  }

  // The whole WHERE clause applies, including the version CAS in
  // src/skills-evaluate.ts (`AND version = ?3`).
  if (/^UPDATE improve_skills/i.test(text)) {
    const where = / WHERE (.+?)(?: RETURNING .+)?$/i.exec(text)?.[1];
    if (!where) throw new Error(`improve fake: an unfiltered UPDATE on improve_skills: ${text}`);
    const hits = rows.improve_skills.filter((row) => evalCond(where, { params, row }));
    for (const row of hits) Object.assign(row, setPatch(text, params, row));
    return { handled: true, results: hits.map((row) => ({ id: row.id })) };
  }

  throw new Error(
    `improve fake: unmodelled statement. Model it or fix the query; answering it with an empty ` +
      `result would make whatever asserts on it vacuously true.\n  ${text}`
  );
}

// One SSE attempt response. The attempt path uses the SDK's streaming helper, so a
// plain JSON body is answered with "request ended without sending any chunks".
// `usage` lets a test set the cache token counters it needs.
export function sseMessage(text: string, usage: Record<string, unknown> = {}): string {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 100, output_tokens: 0, ...usage },
        },
      },
    ],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

// The shape proposeChange parses, over that stream.
export function sseChange(files: Array<{ path: string; content: string }>): string {
  return sseMessage(JSON.stringify({ summary: "s", reasoning: "r", files }));
}
