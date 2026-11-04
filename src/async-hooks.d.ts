// The one Node module Capsid imports (src/call-signal.ts), which nodejs_compat provides on
// Workers. Declared here rather than by adding @types/node, whose globals would let Node-only
// code typecheck in a Worker.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
