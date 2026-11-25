// The global Env that worker-configuration.d.ts generates (`npm run types`). src/env.ts exports an
// Env of its own, so it reaches the generated one through this alias.
declare type GeneratedEnv = Env;
