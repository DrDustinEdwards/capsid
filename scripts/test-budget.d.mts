// Types for the unit suite's time budget, so test/test-budget.test.ts type-checks
// under tsconfig.test.json (noImplicitAny). The runtime is scripts/test-budget.mjs.
export const BUDGET_MS: number;
export function verdict(ms: number, ci: string | undefined): { fail: boolean; message: string };
