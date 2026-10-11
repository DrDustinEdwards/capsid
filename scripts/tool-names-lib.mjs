// The MCP 4 regroup's data migration, as pure functions (capsid/rulings/mcp-2026-10-10.md:
// "No legacy names: the same PR rewrites every queued job body, skill and canon doc naming
// an old tool, and migrates agent credentials' tools lists and grants"). The script that
// applies them is scripts/migrate-tool-names.mjs; test/tool-names-lib.test.ts drives these.
//
// THE MAPPING. Every tool the old surface served maps to a new tool and, where the new
// tool takes one, an action. src/tools/surface.ts is the source of truth for the new side,
// and the test holds this table to it.

/** Old tools that became one action of a new tool. [new tool, action or null]. */
export const SIMPLE = {
  list: ["capsid_find_docs", "list"],
  find: ["capsid_find_docs", "glob"],
  search: ["capsid_find_docs", "search"],
  namespaces: ["capsid_find_docs", "namespaces"],
  read: ["capsid_read_doc", "read"],
  history: ["capsid_read_doc", "versions"],
  backlinks: ["capsid_read_doc", "links"],
  brief: ["capsid_start_session", null],
  write: ["capsid_write_doc", "write"],
  restore: ["capsid_write_doc", "restore"],
  move: ["capsid_write_doc", "move"],
  delete: ["capsid_delete_doc", null],
  list_repo_tree: ["capsid_read_repo", "tree"],
  read_repo_file: ["capsid_read_repo", "files"],
  search_code: ["capsid_read_repo", "search"],
  repo_refs: ["capsid_inspect_repo", "refs"],
  repo_history: ["capsid_inspect_repo", "history"],
  ci_status: ["capsid_inspect_repo", "ci"],
  write_repo_file: ["capsid_change_repo", "write_file"],
  delete_repo_file: ["capsid_change_repo", "delete_file"],
  create_branch: ["capsid_change_repo", "create_branch"],
  open_pr: ["capsid_open_pr", "open"],
  delete_branch: ["capsid_close_pr", "delete_branch"],
  ci_dispatch: ["capsid_run_ci", null],
  improve_status: ["capsid_run_improve", "status"],
  register_namespace: ["capsid_admin_manage_namespaces", "register"],
  update_namespace: ["capsid_admin_manage_namespaces", "update"],
  ops_snapshot: ["capsid_admin_read_ops", "snapshot"],
};

/** Old tools renamed whole: every action keeps its name. */
export const RENAMED = {
  jobs: "capsid_work_jobs",
  lint: "capsid_lint_namespace",
  agents: "capsid_admin_manage_agents",
  claims: "capsid_admin_read_claims",
  controls: "capsid_admin_run_controls",
};

// The actions (lint: modes) of each renamed tool, so `jobs.claimed_by`, a column, is not
// read as an action. test/tool-names-lib.test.ts holds these to src.
export const RENAMED_ACTIONS = {
  jobs: ["post", "list", "claim", "complete", "record", "fail", "block", "resume", "supersede", "release", "begin", "fire", "routine", "edit", "park", "unpark"],
  lint: ["gather", "finalize", "report"],
  agents: ["mint", "list", "revoke", "update_scopes"],
  claims: ["job", "aggregate", "export"],
  controls: ["list", "preview", "perform"],
};

/** Old tools whose actions split across new tools. old action -> [new tool, new action]. */
export const SPLIT = {
  manage_pr: {
    comment: ["capsid_open_pr", "comment"],
    merge: ["capsid_close_pr", "merge"],
    close: ["capsid_close_pr", "close"],
  },
  delete_namespace: {
    preview: ["capsid_admin_manage_namespaces", "delete_preview"],
    perform: ["capsid_admin_manage_namespaces", "delete_perform"],
  },
  cloudflare_config: {
    access_apps: ["capsid_admin_read_ops", "access_apps"],
    access_policies: ["capsid_admin_read_ops", "access_policies"],
    email_rules: ["capsid_admin_read_ops", "email_rules"],
    email_addresses: ["capsid_admin_read_ops", "email_addresses"],
  },
  improve_run: {
    run: ["capsid_run_improve", "run"],
    claim: ["capsid_run_improve", "claim"],
    mode: ["capsid_admin_control_improve", "mode"],
    pause: ["capsid_admin_control_improve", "pause"],
    unpause: ["capsid_admin_control_improve", "unpause"],
    budget: ["capsid_admin_control_improve", "budget"],
    mint_operator_key: ["capsid_admin_control_improve", "mint_operator_key"],
    sign_policy: ["capsid_admin_control_improve", "sign_policy"],
    register_skill: ["capsid_admin_control_improve", "register_skill"],
    breaker_reset: ["capsid_admin_control_improve", "breaker_reset"],
    overnight: ["capsid_admin_control_improve", "overnight"],
  },
};

// The action an omitted `action` meant on the old split tools, for prose that names the
// tool with no action.
const SPLIT_DEFAULT = { improve_run: "run" };

/** Every old tool name. */
export const OLD_TOOLS = [...Object.keys(SIMPLE), ...Object.keys(RENAMED), ...Object.keys(SPLIT)];

// Each new tool's actions that some old tool served. A new tool whose every such action is
// granted is granted whole, so it also gains the actions this regroup added (site, tag,
// release, builds, build_logs): the same reading as a bare tool name, which has always
// meant the whole tool.
export const OLD_ACTIONS_OF = (() => {
  /** @type {Record<string, Set<string>>} */
  const out = {};
  const add = (/** @type {string} */ tool, /** @type {string | null} */ action) => {
    out[tool] ??= new Set();
    if (action !== null) out[tool].add(action);
  };
  for (const [tool, action] of Object.values(SIMPLE)) add(tool, action);
  for (const actions of Object.values(SPLIT)) for (const [tool, action] of Object.values(actions)) add(tool, action);
  for (const tool of Object.values(RENAMED)) add(tool, null);
  return out;
})();

/**
 * What one old tools-axis entry grants on the new surface: [new tool, action] pairs, where
 * action "*" is the whole tool.
 * @param {string} entry an old entry, "tool" or "tool.action"
 * @param {readonly string[]} list the whole old list, for the narrowing rule
 * @returns {Array<[string, string]> | null} null when the entry names no old tool
 */
export function grantsOf(entry, list) {
  const dot = entry.indexOf(".");
  const tool = dot < 0 ? entry : entry.slice(0, dot);
  const action = dot < 0 ? undefined : entry.slice(dot + 1);
  if (Object.hasOwn(SIMPLE, tool)) {
    if (action !== undefined) return [];
    const [next, nextAction] = SIMPLE[/** @type {keyof typeof SIMPLE} */ (tool)];
    return [[next, nextAction ?? "*"]];
  }
  if (Object.hasOwn(RENAMED, tool)) {
    const next = RENAMED[/** @type {keyof typeof RENAMED} */ (tool)];
    if (action !== undefined) return list.includes(tool) ? [[next, action]] : [];
    // A bare name with a qualified sibling is narrowed to the siblings (allowsToolAction).
    return list.some((e) => e.startsWith(`${tool}.`)) ? [] : [[next, "*"]];
  }
  if (Object.hasOwn(SPLIT, tool)) {
    const actions = SPLIT[/** @type {keyof typeof SPLIT} */ (tool)];
    if (action !== undefined) {
      if (!list.includes(tool) || !Object.hasOwn(actions, action)) return [];
      const [next, nextAction] = actions[/** @type {keyof typeof actions} */ (action)];
      return [[next, nextAction]];
    }
    if (list.some((e) => e.startsWith(`${tool}.`))) return [];
    return Object.values(actions).map(([next, nextAction]) => [next, nextAction]);
  }
  return null;
}

/**
 * The new tools axis an old one grants. "*" stays "*". An entry that names no old tool (a
 * new name already, or anything else) is kept as written.
 * @param {"*" | readonly string[]} list
 * @returns {"*" | string[]}
 */
export function newToolsAxis(list) {
  if (list === "*") return "*";
  /** @type {Map<string, Set<string>>} */
  const granted = new Map();
  const kept = [];
  for (const entry of list) {
    const pairs = grantsOf(entry, list);
    if (pairs === null) {
      kept.push(entry);
      continue;
    }
    for (const [tool, action] of pairs) {
      if (!granted.has(tool)) granted.set(tool, new Set());
      /** @type {Set<string>} */ (granted.get(tool)).add(action);
    }
  }
  const out = [];
  for (const [tool, actions] of granted) {
    const known = OLD_ACTIONS_OF[tool] ?? new Set();
    const whole = actions.has("*") || (known.size > 0 && [...known].every((a) => actions.has(a)));
    out.push(tool);
    if (!whole) for (const action of [...actions].sort()) out.push(`${tool}.${action}`);
  }
  // An entry already in the new form (a re-run) is not doubled.
  for (const entry of kept) if (!out.includes(entry)) out.push(entry);
  return out;
}

/** True for an entry that names an old tool, bare or qualified. */
export function isOldEntry(/** @type {string} */ entry) {
  const dot = entry.indexOf(".");
  return OLD_TOOLS.includes(dot < 0 ? entry : entry.slice(0, dot));
}

/**
 * Phase "add": the old entries kept beside the new ones, so the agent works on the old
 * Worker before the deploy, on the new one after it, and on the old one again after a
 * rollback. An old name on the new Worker names no tool and grants nothing.
 * @param {"*" | readonly string[]} list
 */
export function addedToolsAxis(list) {
  if (list === "*") return "*";
  const next = newToolsAxis(list);
  if (next === "*") return "*";
  const out = [...list];
  for (const entry of next) if (!out.includes(entry)) out.push(entry);
  return out;
}

/**
 * Phase "prune": the old entries removed. Refuses a list that has no new entry for an old
 * one, which means the add phase never ran for it: pruning would leave it with nothing.
 * @param {"*" | readonly string[]} list
 */
export function prunedToolsAxis(list) {
  if (list === "*") return "*";
  const old = list.filter(isOldEntry);
  const rest = list.filter((e) => !isOldEntry(e));
  const wanted = newToolsAxis(old);
  const missing = wanted === "*" ? [] : wanted.filter((e) => !rest.includes(e));
  if (missing.length > 0) {
    throw new Error(`the add phase has not run for this list: it lacks ${missing.join(", ")}. Run --phase add first.`);
  }
  return rest;
}

// ---- prose ------------------------------------------------------------------------

// A backticked old name followed by one of these words is not the tool: "the `write`
// grant", "the `jobs` table".
const NOT_A_TOOL_AFTER = /^\s+(grants?|tables?|columns?|rows?|fields?|flags?|modes?|status|scopes?|axis|role|key)\b/i;

/**
 * The new spelling of an old tool reference.
 * @param {string} tool old tool name
 * @param {string | undefined} action old action, where the reference named one
 * @param {boolean} [called] the reference is a call, name(...)
 * @returns {{ tool: string, action: string | null } | null}
 */
export function renamed(tool, action, called = false) {
  if (Object.hasOwn(SIMPLE, tool)) {
    const [next, nextAction] = SIMPLE[/** @type {keyof typeof SIMPLE} */ (tool)];
    return { tool: next, action: nextAction };
  }
  if (Object.hasOwn(RENAMED, tool)) {
    if (action !== undefined && !RENAMED_ACTIONS[/** @type {keyof typeof RENAMED_ACTIONS} */ (tool)].includes(action)) return null;
    return { tool: RENAMED[/** @type {keyof typeof RENAMED} */ (tool)], action: action ?? null };
  }
  if (Object.hasOwn(SPLIT, tool)) {
    const actions = SPLIT[/** @type {keyof typeof SPLIT} */ (tool)];
    // A tool whose every action moved to one new tool is that tool, named bare.
    const targets = new Set(Object.values(actions).map(([next]) => next));
    if (action === undefined && targets.size === 1) return { tool: [...targets][0], action: null };
    // An omitted action meant the old default only in a call; named bare in prose, a split
    // tool means all of it, which no one new tool is.
    const asked = action ?? (called && Object.hasOwn(SPLIT_DEFAULT, tool) ? SPLIT_DEFAULT[/** @type {keyof typeof SPLIT_DEFAULT} */ (tool)] : undefined);
    if (asked === undefined || !Object.hasOwn(actions, asked)) return null;
    const [next, nextAction] = actions[/** @type {keyof typeof actions} */ (asked)];
    return { tool: next, action: nextAction };
  }
  return null;
}

// The new tools whose action an omitted `action` means, so prose need not name it.
const DEFAULT_ACTIONS = { capsid_find_docs: "list", capsid_read_doc: "read", capsid_write_doc: "write" };

const NAMES = OLD_TOOLS.slice().sort((a, b) => b.length - a.length).join("|");

// Old names that are also ordinary words, or name something else here (`open_pr` is a
// gate class, `namespaces` a scope axis, `agents` a package, `list` a jobs action). One of
// these is rewritten only where the text says it is a tool; anywhere else it is reported
// for the seat, never guessed.
const AMBIGUOUS = new Set(OLD_TOOLS.filter((name) => !name.includes("_") || name === "open_pr"));

// `name`, `name.action` or `name(...)`, one backtick span, then an optional
// ` action `x`` or ` action "x"` after it. A bare word after "action" is prose ("the
// `jobs` action is"), not an action.
const SPAN = new RegExp(
  "`(" + NAMES + ")(?:\\.([a-z_]+))?((?:\\([^`]*\\))?)(?:\\s+action\\s+\"?([a-z_]+)\"?)?`" + "(?:\\s+action\\s+(?:`([a-z_]+)`|\"([a-z_]+)\"))?",
  "g"
);
// name( outside backticks: not a method (.name(), a path (mint-agents(), or a longer word.
const CALL = new RegExp("(^|[^\\w.`$/-])(" + NAMES + ")\\(", "g");
// A file name is not a qualified tool (`agents.ts`).
const FILE_EXTENSION = /^(ts|js|mjs|cjs|md|json|sql|yml|yaml|toml|txt|html|css)$/;
// Text before a span that says it names a tool.
const CALL_BEFORE = /\b(call|calls|calling|called|tool)\s*$/i;

/**
 * Rewrite old tool references in prose. Only tool-call contexts are touched: a backtick
 * span holding a tool name (bare, qualified, called or followed by an action), and a bare
 * `name(` call. A name that is also a word (AMBIGUOUS) is rewritten only where the text
 * says it is the tool, and listed under `ambiguous` otherwise. Fenced code blocks are
 * left alone and listed under `fenced`. Both lists are for the seat to read.
 * @param {string} text
 * @returns {{ text: string, changes: Array<{ line: number, before: string, after: string }>, fenced: Array<{ line: number, text: string }>, unmapped: Array<{ line: number, text: string }>, ambiguous: Array<{ line: number, text: string }> }}
 */
export function rewriteProse(text) {
  const lines = text.split("\n");
  const changes = [];
  const fenced = [];
  const unmapped = [];
  const ambiguous = [];
  let inFence = false;
  const probe = new RegExp("(^|[^\\w./-])(" + NAMES + ")(\\(|\\.[a-z_]+\\b)");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (probe.test(line)) fenced.push({ line: i + 1, text: line });
      continue;
    }
    let next = line.replace(SPAN, (whole, tool, dotted, call, inner, tick, quoted, offset, all) => {
      const after = all.slice(offset + whole.length);
      const before = all.slice(0, offset);
      if (dotted !== undefined && FILE_EXTENSION.test(dotted)) return whole;
      // The action of a tool already named ("`capsid_close_pr` action `delete_branch`"),
      // which a second run over rewritten text must leave alone.
      if (/\baction\s*$/.test(before)) return whole;
      // One in a list of a new tool's actions ("`capsid_change_repo` (actions
      // `write_file` and `create_branch`)"): still the same clause, after "actions".
      if (/`capsid_\w+`[^.;:]*\bactions?\b[^.;:]*$/.test(before)) return whole;
      const trailing = tick ?? quoted;
      const action = dotted ?? inner ?? trailing;
      // "the `write` grant", "the `jobs` table": not the tool, and not worth reporting.
      if (dotted === undefined && !call && action === undefined && NOT_A_TOOL_AFTER.test(after)) return whole;
      if (AMBIGUOUS.has(tool)) {
        const said = Boolean(call) || dotted !== undefined || action !== undefined || /^\s+tools?\b/.test(after) || CALL_BEFORE.test(before);
        if (!said) {
          ambiguous.push({ line: i + 1, text: whole });
          return whole;
        }
      }
      // A qualified name that is not one of the tool's actions is a column or a field
      // (`jobs.claimed_by`), not the tool.
      if (dotted !== undefined && Object.hasOwn(RENAMED_ACTIONS, tool) && !RENAMED_ACTIONS[/** @type {keyof typeof RENAMED_ACTIONS} */ (tool)].includes(dotted)) return whole;
      if (dotted !== undefined && Object.hasOwn(SPLIT, tool) && !Object.hasOwn(SPLIT[/** @type {keyof typeof SPLIT} */ (tool)], dotted)) return whole;
      if (dotted !== undefined && Object.hasOwn(SIMPLE, tool)) return whole;
      const r = renamed(tool, action, Boolean(call));
      if (!r) {
        unmapped.push({ line: i + 1, text: whole });
        return whole;
      }
      const implied = r.action === null || DEFAULT_ACTIONS[/** @type {keyof typeof DEFAULT_ACTIONS} */ (r.tool)] === r.action;
      if (dotted !== undefined && !call) return `\`${r.tool}${r.action ? `.${r.action}` : ""}\``;
      if (call) {
        const args = call.slice(1, -1).trim();
        const actionArg = implied ? "" : `action: "${r.action}"`;
        // A call that already names its action (jobs({ action: "post" })) keeps it.
        const named = /\baction\s*:/.test(args);
        const all2 = named || !actionArg ? args : args ? `${actionArg}, ${args}` : actionArg;
        return `\`${r.tool}(${all2})\``;
      }
      // A renamed tool keeps the action the text gave it, in the text's own spelling.
      if (trailing !== undefined && r.action === trailing) return `\`${r.tool}\` action \`${r.action}\``;
      return implied ? `\`${r.tool}\`` : `\`${r.tool}\` action \`${r.action}\``;
    });
    next = next.replace(CALL, (whole, before, tool) => {
      const r = renamed(tool, undefined, true);
      if (!r) {
        unmapped.push({ line: i + 1, text: whole.trim() });
        return whole;
      }
      return `${before}${r.tool}(`;
    });
    if (next !== line) {
      changes.push({ line: i + 1, before: line, after: next });
      lines[i] = next;
    }
  }
  return { text: lines.join("\n"), changes, fenced, unmapped, ambiguous };
}

// ---- job bodies -------------------------------------------------------------------

// A stored job body carries the signature as frontmatter (src/improve-task.ts
// signTaskBody). The edit re-signs the text it is given, so the signature is taken off
// first; rewriting it in place would leave a signature over other text.
const SIGNED = /^---\ncapsid-task-signature: [0-9a-f]+\n---\n/;

/** The signed text of a stored job body. */
export function unsignedBody(/** @type {string} */ stored) {
  return stored.replace(SIGNED, "");
}
