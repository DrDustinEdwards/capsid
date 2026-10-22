// The paths a repo write needs can_touch_protected for (src/scope.ts): tests, CI, the
// dependency manifests and lockfiles, migrations, deployment and compiler config, the
// agent steering layer and anything else that changes what judges a change rather than
// the change itself.
//
// Matched by shape, not today's spellings, so a sixth repo's layout is covered.
const PROTECTED_PATH_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /(^|\/)tests?\//i, why: "a test directory" },
  { pattern: /\.(test|spec)\.[cm]?[jt]sx?$/i, why: "a test file" },
  { pattern: /(^|\/)__tests__\//i, why: "a test directory" },
  { pattern: /(^|\/)\.github\//i, why: "CI configuration" },
  { pattern: /(^|\/)migrations\//i, why: "a database migration" },
  { pattern: /(^|\/)wrangler\.(jsonc?|toml)(\.example)?$/i, why: "deployment configuration" },
  { pattern: /(^|\/)package(-lock)?\.json$/i, why: "the dependency manifest or lockfile" },
  { pattern: /(^|\/)npm-shrinkwrap\.json$/i, why: "a lockfile npm prefers over package-lock.json" },
  { pattern: /(^|\/)pnpm-lock\.yaml$/i, why: "the pnpm lockfile CI installs from" },
  { pattern: /(^|\/)pnpm-workspace\.yaml$/i, why: "the pnpm workspace definition" },
  { pattern: /(^|\/)\.pnpmfile\.cjs$/i, why: "a pnpm hook that runs during install" },
  { pattern: /(^|\/)yarn\.lock$/i, why: "the yarn lockfile" },
  { pattern: /(^|\/)\.yarnrc\.yml$/i, why: "yarn registry and install policy" },
  { pattern: /(^|\/)bun\.lockb?$/i, why: "the bun lockfile" },
  { pattern: /(^|\/)deno\.lock$/i, why: "the deno lockfile" },
  { pattern: /(^|\/)Cargo\.lock$/i, why: "the cargo lockfile" },
  { pattern: /(^|\/)go\.sum$/i, why: "the go module checksums" },
  { pattern: /(^|\/)(poetry|uv)\.lock$/i, why: "a python lockfile" },
  // The other ecosystems' lockfiles and task runners (Grok audit 2026-10-21, CA-11).
  { pattern: /(^|\/)(Pipfile\.lock|requirements[^/]*\.txt)$/i, why: "a python lockfile" },
  { pattern: /(^|\/)(Gemfile\.lock|composer\.lock|flake\.lock|Package\.resolved|gradle\.lockfile)$/i, why: "a lockfile" },
  { pattern: /(^|\/)(justfile|Taskfile\.ya?ml)$/i, why: "build glue CI executes" },
  { pattern: /(^|\/)\.gitmodules$/i, why: "submodules the checkout would fetch and run" },
  { pattern: /(^|\/)tsconfig[^/]*\.json$/i, why: "compiler configuration" },
  { pattern: /\.(config|conf)\.[cm]?[jt]s$/i, why: "a config file" },
  { pattern: /(^|\/)\.?eslint[^/]*$/i, why: "lint configuration" },
  { pattern: /(^|\/)\.claude\//i, why: "the agent steering layer" },
  { pattern: /(^|\/)CLAUDE\.md$/i, why: "the repo briefing" },
  { pattern: /(^|\/)AGENTS\.md$/i, why: "the repo briefing other agents read" },
  { pattern: /(^|\/)\.nvmrc$/i, why: "the Node version CI runs" },
  { pattern: /(^|\/)\.node-version$/i, why: "the Node version CI runs" },
  { pattern: /(^|\/)\.npmrc$/i, why: "npm registry and install-script policy" },
  { pattern: /(^|\/)\.yarnrc[^/]*$/i, why: "yarn registry and install policy" },
  { pattern: /(^|\/)\.tool-versions$/i, why: "the toolchain versions asdf resolves" },
  { pattern: /(^|\/)\.gitattributes$/i, why: "what the checkout contains" },
  { pattern: /(^|\/)\.husky\//i, why: "a git hook CI may run" },
  { pattern: /(^|\/)scripts\//i, why: "scripts CI executes" },
  { pattern: /(^|\/)Makefile$/i, why: "build glue CI executes" },
  // Config the test runner or build reads that is JSON, a dotfile or has no extension.
  { pattern: /\.(config|conf)\.json$/i, why: "a config file" },
  { pattern: /(^|\/)\.babelrc[^/]*$/i, why: "compiler configuration" },
  { pattern: /(^|\/)\.mocharc[^/]*$/i, why: "test runner configuration" },
  { pattern: /(^|\/)vitest\.workspace\.[^/]+$/i, why: "test runner configuration" },
  { pattern: /(^|\/)\.env[^/]*$/i, why: "environment the build and tests read" },
  { pattern: /(^|\/)Dockerfile[^/]*$/i, why: "the image a build runs in" },
];

// Returns the reasons a change set is disqualified, or an empty array.
export function protectedHits(paths: string[]): Array<{ path: string; why: string }> {
  const hits: Array<{ path: string; why: string }> = [];
  for (const path of paths) {
    for (const { pattern, why } of PROTECTED_PATH_PATTERNS) {
      if (pattern.test(path)) {
        hits.push({ path, why });
        break;
      }
    }
  }
  return hits;
}
