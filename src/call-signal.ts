import { AsyncLocalStorage } from "node:async_hooks";

// The running tool call's abort signal (area 11, P11), carried to the code that makes the
// outbound requests without threading it through every operation. The registrar
// (src/scope.ts guardRegistrations) runs each handler inside withCallSignal with the
// request's signal, and the GitHub client (src/github/client.ts) asks callSignal for the
// signal of each request: its own timeout, joined with the call's signal when a call is
// running. So a client that closes the call stops the GitHub requests it started.
const current = new AsyncLocalStorage<AbortSignal | undefined>();

export function withCallSignal<T>(signal: AbortSignal | undefined, run: () => T): T {
  return current.run(signal, run);
}

/** A request's signal: the timeout, and the running tool call's abort signal when there is one. */
export function callSignal(timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  const call = current.getStore();
  return call ? AbortSignal.any([call, timeout]) : timeout;
}
