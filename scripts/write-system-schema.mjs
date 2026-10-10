// Writes system/model.schema.json from the Zod schema in src/system-model.ts, so the
// file editors read and the schema the Worker enforces cannot differ.
// test/system-model.test.ts fails when the committed file is stale.
// Run: node --import ./test/resolve-ts.mjs scripts/write-system-schema.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SystemModelSchema } from "../src/system-model.ts";

const out = join(import.meta.dirname, "..", "system", "model.schema.json");
writeFileSync(out, `${JSON.stringify(z.toJSONSchema(SystemModelSchema, { io: "input" }), null, 2)}\n`);
console.log(`wrote ${out}`);
