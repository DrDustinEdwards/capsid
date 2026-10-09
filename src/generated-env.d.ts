// The global Env that worker-configuration.d.ts generates (`npm run types`). src/env.ts
// exports an Env of its own, so it reaches the generated one through this alias. The
// alias is not Cloudflare.Env on purpose: test-integration/env.d.ts makes that one extend
// the Worker's Env, and a base type that names itself does not compile.
declare type GeneratedEnv = Env;
