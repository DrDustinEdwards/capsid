import { z } from "zod";
import { bounded } from "./limits";

// The public code maps' shape (src/public-code.ts; docs/public-data.md, "The code maps"),
// apart from the code that reads them so the explorer's build can check the document
// without loading the GitHub client.

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// A repo-relative module path: no leading slash, no "." or ".." segment. $ and brackets are
// in React Router's route file names (blog.$slug[.md].ts); the explorer escapes them in links.
const ModulePath = bounded(300).regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@/+$[\]-]+$/, "a module path is repo-relative");
const Line = z.number().int().min(1);
const Share = z.number().min(0).max(1);

const FunctionSchema = z.object({
  name: bounded(200).min(1),
  line: Line,
  end: Line,
  cc: z.number().int().min(1),
  coverage: Share.nullable(),
  crap: z.number().min(0).nullable(),
  mutants: z.number().int().min(0).nullable(),
  score: z.number().min(0).max(100).nullable(),
  // Changed since the mutation run, so its old numbers were dropped (mutants and score null).
  stale: z.literal(true).optional(),
});

const ModuleSchema = z.object({
  path: ModulePath,
  loc: z.number().int().min(0),
  imports: z.array(ModulePath).max(1000),
  cycle: z.literal(true).optional(),
  functions: z.array(FunctionSchema).max(5000),
});

/** code-map.json v1 as devkit writes it. Parsing strips any key not named here, so a
 *  field nobody listed cannot reach the public document. */
export const CodeMapSchema = z.object({
  version: z.literal(1),
  repo: bounded(200).regex(REPO),
  sha: bounded(40).regex(/^[0-9a-f]{40}$/),
  date: bounded(10).regex(DATE),
  tools: z.object({
    typescript: bounded(40).nullable(),
    coverage: z.literal("istanbul").nullable(),
    mutation: z.literal("stryker").nullable(),
  }),
  // The commit and day the mutation report was measured at, when it is older than the map.
  mutated: z.object({ sha: bounded(40).regex(/^[0-9a-f]{40}$/), date: bounded(10).regex(DATE) }).optional(),
  modules: z.array(ModuleSchema).max(5000),
  cycles: z.array(z.array(ModulePath).min(1).max(1000)).max(1000),
});

export const PublicCodeSchema = z.strictObject({
  version: z.literal(1),
  as_of: bounded(10).regex(DATE),
  maps: z.array(CodeMapSchema.extend({ system: bounded(64) }).strict()),
});

export type PublicCode = z.infer<typeof PublicCodeSchema>;
