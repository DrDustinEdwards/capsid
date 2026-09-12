# Auth model

Every caller resolves to an agent: a name, a set of scopes, and its own audit identity. There is one enforcement point, `checkScope` in `src/scope.ts`. The registrar wraps every tool registration before any tool module runs, so a tool is covered by existing, and `TOOL_GRANTS` states what each tool requires.

Scopes are five axes. `namespaces` and `repos` are a list or `*`. `tools` is an allow list or `*`. `grants` is read, or read and write. `flags` are the blast radius:

| flag | what it gates |
| --- | --- |
| `can_merge` | merging a pull request, which can trigger a deploy on a repo that deploys on push |
| `can_direct_write` | a `mode: "direct"` commit, which lands on a default branch with no review |
| `can_dispatch` | dispatching a workflow, which spends CI minutes and runs code with that repo's secrets in scope |
| `can_write_workflows` | writing under `.github/workflows/` |
| `can_touch_protected` | tests, CI, lint and compiler config, lockfiles, manifests, the agent steering layer, migrations |
| `money_paths` | a path naming a billing or payment surface |
| `can_comment_pr` | commenting on a pull request, the smallest write `manage_pr` makes. It is not `can_merge`. |

A new agent gets read on its named namespaces and no flags. Scopes are stored as JSON and the parse fails closed: a null, truncated or wrong-shaped column resolves to no namespaces, no tools, no grants and no flags.

**The `repos` axis is set per driver, and editing the mapping is admin work.** Both halves were added 2026-09-13 and either alone leaves a hole. Until then every agent carried `repos: "*"`, because `scripts/mint-agents.mjs` named no repos for a driver and an omitted axis mints wide, and `allowsScope("*", v)` can never refuse. That made the namespace-to-repo mapping the only thing standing between a driver and every repo the App reaches, and `update_namespace` took a plain write grant, which every driver holds. A driver could therefore remap its own namespace onto any repo and then read and write it.

- `register_namespace` and `update_namespace` are `admin` in `TOOL_GRANTS`, checked by the registrar like every other requirement. A driver that needs a namespace mapped asks for it, the way it asks for a mint.
- A driver is minted with `repos` set to its namespace's mapped repos, read from the live mapping rather than from a list in the script, so the axis and the mapping cannot disagree. A namespace that maps to nothing refuses the mint rather than falling back to the wildcard.

After both, a remap gains a driver nothing: the repos axis refuses independently of what the mapping says.

### Roles

Roles are few and separated. Each one is a single capability, not a bundle. `scripts/mint-agents.mjs` holds them in two lists: `ROLES`, asked for by name, and `AGENTS`, the per-namespace bootstrap that holds the drivers and the seat. `node scripts/mint-agents.mjs --roles` prints a mint command for each entry in `ROLES`, which is the four below that are not a driver or the seat; the driver rows and the seat are minted by the same script's namespace path (`docs/bootstrap.md`). A test fails the build if any role names a second blast-radius flag.

| role | reads | writes | flag |
| --- | --- | --- | --- |
| `<ns>-driver` | its own namespace | its own namespace, pull requests only | none by default; two exceptions below |
| `auditor` | every namespace and repo | nothing at all | none |
| `reviewer` | every namespace and repo | a comment on a pull request | `can_comment_pr` |
| `watcher` | every namespace | `jobs.post`, and no other job action | none |
| `seat` | every namespace | every namespace | `can_merge` |
| `site-seat` | `dustinedwards` | `dustinedwards` | `can_merge` |

**A project driver holds no blast-radius flag by default, and two of them hold one.** Granted by the seat on 2026-09-11, each for a stated reason rather than as a convenience: `capsid-driver` holds `can_touch_protected`, and `claude-skills-driver` holds `can_touch_protected` and `can_write_workflows`. In both repos the protected list is what the driver's own jobs edit, because tests, CI and `scripts/` are the subject of the work rather than something near it, and in claude-skills a skill's workflow is part of the artifact. Every other driver holds none, and `improve_status` and the console list the flags each one actually has, so the inventory is the answer rather than this paragraph. Widening one is `agents` action `update_scopes`, which is admin only and audit-logged with the scopes before and after.

The reviewer and the watcher both need the write grant, because commenting and posting a job both go through write tools. The tools axis keeps that from being a general write. An entry can name an action: `jobs.post` or `manage_pr.comment`. A list naming at least one action of a tool is narrowed to the actions it names. A bare tool name with no qualified sibling still means the whole tool, and `*` still allows everything, so no agent minted before this changes behaviour. The two tools whose action decides what they do (`jobs` and `lint`) pass the action to `checkScope` at the point where it is known, which is the same shape the grant check already uses.

The `agents` tool is admin only. An agent that could mint another could widen itself. `mint` returns a key once and stores only its sha256. `list` is the inventory, revoked rows included. `revoke` sets `revoked_at` rather than deleting, so rows an agent wrote still resolve to what it was allowed to do, while its key stops resolving immediately. `update_scopes` replaces named axes and leaves the rest.

Audit rows and `jobs.claimed_by` record a minted agent as `agent:<name>`.

**Four of these have never connected, and what each is waiting for is written down so an unused credential reads as a plan rather than a loose end.** `improve_status` shows `last_seen: null` for all four today.

- `seat` is used the first time a merge is made by a machine rather than by a person at GitHub. Until then the human merges pull requests and the seat's key sits unused on disk, which is the correct state while `capsid/policy/auto-merge.md` ships disabled.
- `reviewer` is used the first time a job is posted with `review_required`, since that is the only thing that waits for a `REVIEW:` comment. No job has been posted with it yet.
- `auditor` is used by an outside model doing a cold audit, which is a thing a person starts rather than something the system reaches for.
- `watcher` is different from the other three, and its `null` means something else. The tick has no bearer token to present, so it builds a SYNTHETIC watcher identity in `src/watcher.ts` shaped to match the minted role exactly, and `touchLastSeen` returns early for an agent with no row. The minted `watcher` key is therefore unused by construction, and its `last_seen` stays `null` however many findings the tick posts. What records that work is `audit_log`, where the actor is `agent:watcher` either way. The key is there for a person driving the watcher's checks by hand from outside the Worker.

Three kinds of caller resolve, in this order:

1. **A minted agent**, matched on the sha256 of its bearer token. Checked first, so a key that is both an agent and an operator entry gets the narrower authority.
2. **A legacy operator key**, until its hash is removed from `OPERATOR_KEY_HASH` by hand.
3. **The OAuth admin session**, the synthetic agent `admin` with every scope.

The operator hash is removed once every machine runs as its folder's driver agent and the admin OAuth session is the only wider credential. That is the intent, and it is the last step of the migration in `docs/bootstrap.md`, not something this document can report as done. Until `OPERATOR_KEY_HASH` is unset on the Worker the legacy path stays live: `src/auth.ts` reads the secret on every bearer request, and `src/agents.ts` gives a plain entry the admin grant, so a key in it can still mint agents. Whether it is still set is Worker state this repo cannot see. `npx wrangler secret list --name capsid` answers it, and prints names only.

Two gated endpoints:

1. **OAuth (`/mcp`)** for human clients. The client discovers the server via `.well-known`, registers dynamically, and goes through `/authorize` and a one-time approval screen to GitHub. On return the user is checked against `ADMIN_GITHUB_LOGIN`: the GitHub username, or the numeric user id (find it at `https://api.github.com/users/<login>`). Any other account gets a 403. The check runs again on every `/mcp` request. An admitted admin holds a full write grant.
2. **Agent and operator keys (`/ops/mcp`)** for agents and cron, gated by sha256-hashed bearer keys. An agent key resolves to its row. Failing that, `OPERATOR_KEY_HASH` holds comma-separated hashes: a plain entry is a write key, an entry prefixed `ro:` is read-only and is denied every tool `TOOL_GRANTS` marks write: write, delete, move, restore, register_namespace, update_namespace, repo writes, PR management, improve_run, agents, lint finalize, and every `jobs` action but `list`. Revoke by removing a hash; the others keep working. The OAuth library never sees this route.

Login and repo access use two different GitHub credentials: an OAuth App for login (OAuth Apps cannot mint installation tokens) and a GitHub App for repo access. Keep both.

`register_namespace` returns the command that mints the new namespace's driver agent, `node scripts/mint-agents.mjs --namespace <ns> --apply`. It does not mint it, and since 2026-09-13 it is admin only itself, so the separation is now belt and braces: registering a namespace and minting a credential for it are two acts by the same caller rather than one act that quietly does both.
