// Types for the operator scripts' JSON-RPC client, so tests type-check under
// tsconfig.test.json. The runtime is scripts/capsid-rpc.mjs.
export function requireHttps(origin: string): string;
export function parseRpcBody(text: string, method: string): any;
export function capsidClient(
  origin: string,
  key: string,
  clientName: string,
  fetchImpl?: typeof fetch
): { tool(name: string, args: object): Promise<string> };
