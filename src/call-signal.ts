import { AsyncLocalStorage } from "node:async_hooks";

// The running tool call's abort signal, carried to the code that makes outbound requests without
// threading it through every operation.
const current = new AsyncLocalStorage<AbortSignal | undefined>();

export function withCallSignal<T>(signal: AbortSignal | undefined, run: () => T): T {
  return current.run(signal, run);
}

export function callSignal(timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  const call = current.getStore();
  return call ? AbortSignal.any([call, timeout]) : timeout;
}
